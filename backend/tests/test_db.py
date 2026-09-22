"""SupabaseRepository query shapes (with a recording fake client) and pure helpers."""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import pytest

from app import db
from app.db import (
    INBOX_COLUMNS,
    PAGE_SIZE,
    PREVIEW_CHARS,
    PREVIEW_FETCH_CHUNK,
    SupabaseRepository,
    conversation_name_from_rows,
    parse_timestamp,
    preview_source_ids,
    sort_rows,
    summarize_conversations,
)


class FakeQuery:
    """Records the PostgREST builder chain; ``execute`` returns canned data."""

    def __init__(self, client: "FakeClient", table: str) -> None:
        self.client = client
        self.ops: list[tuple] = [("table", table)]

    def __getattr__(self, name):
        def method(*args, **kwargs):
            self.ops.append((name, args, kwargs))
            return self

        return method

    def execute(self):
        self.client.executed.append(self.ops)
        self.client.threads.append(threading.get_ident())
        data = self.client.responses.pop(0) if self.client.responses else []
        if isinstance(data, Exception):  # a queued PostgREST error
            raise data
        return SimpleNamespace(data=data)


class FakeClient:
    def __init__(self) -> None:
        self.executed: list[list[tuple]] = []
        self.responses: list[list[dict]] = []
        self.threads: list[int] = []

    def table(self, name: str) -> FakeQuery:
        return FakeQuery(self, name)


@pytest.fixture
def fake_repo() -> tuple[SupabaseRepository, FakeClient]:
    repo = SupabaseRepository.__new__(SupabaseRepository)
    client = FakeClient()
    repo._client = client  # type: ignore[attr-defined]
    repo._previews = {}  # type: ignore[attr-defined]
    return repo, client


def op_names(ops):
    return [op[0] for op in ops]


def test_insert_is_one_call_and_returns_row(fake_repo):
    repo, client = fake_repo
    client.responses = [[{"id": 7, "role": "visitor"}]]
    row = asyncio.run(repo.insert_message("cid", "visitor", "hi", conversation_name="Jo"))
    assert row == {"id": 7, "role": "visitor"}
    assert len(client.executed) == 1
    ops = client.executed[0]
    assert op_names(ops) == ["table", "insert"]
    record = ops[1][1][0]
    assert record == {
        "conversation_id": "cid", "conversation_name": "Jo", "role": "visitor", "content": "hi",
        "tool_calls": None, "needs_attention": False, "read": False,
    }
    assert client.threads[0] != threading.get_ident()  # ran in a worker thread


def test_get_conversation_single_select(fake_repo):
    repo, client = fake_repo
    asyncio.run(repo.get_conversation("cid"))
    asyncio.run(repo.get_conversation("cid", after_id=41))
    assert len(client.executed) == 2
    plain, after = client.executed
    assert op_names(plain) == ["table", "select", "eq", "order", "order", "range"]
    assert plain[2][1] == ("conversation_id", "cid")
    assert plain[3][1] == ("created_at",) and plain[4][1] == ("id",)
    assert plain[5][1] == (0, PAGE_SIZE - 1)
    assert op_names(after) == ["table", "select", "eq", "gt", "order", "order", "range"]
    assert after[3][1] == ("id", 41)


def test_get_conversation_longer_than_a_page(fake_repo):
    repo, client = fake_repo
    client.responses = [[{"id": i} for i in range(PAGE_SIZE)], [{"id": "last"}]]
    rows = asyncio.run(repo.get_conversation("cid"))
    assert len(rows) == PAGE_SIZE + 1
    assert [[op for op in ops if op[0] == "range"][0][1] for ops in client.executed] == [(0, 999), (1000, 1999)]


def test_open_conversation_is_one_update_returning(fake_repo):
    repo, client = fake_repo
    client.responses = [[
        {"id": 2, "created_at": "2026-09-21T10:00:01+00:00"},
        {"id": 1, "created_at": "2026-09-21T10:00:00+00:00"},
    ]]
    rows = asyncio.run(repo.open_conversation("cid"))
    assert [r["id"] for r in rows] == [1, 2]  # sorted in Python
    assert len(client.executed) == 1
    ops = client.executed[0]
    assert op_names(ops) == ["table", "update", "eq"]
    assert ops[1][1][0] == {"read": True, "needs_attention": False}
    assert ops[2][1] == ("conversation_id", "cid")


def test_resolve_and_delete_are_single_calls(fake_repo):
    repo, client = fake_repo
    asyncio.run(repo.resolve_conversation("cid"))
    asyncio.run(repo.delete_conversation("cid"))
    resolve, delete = client.executed
    assert op_names(resolve) == ["table", "update", "eq"]
    assert resolve[1][1][0] == {"needs_attention": False}
    assert op_names(delete) == ["table", "delete", "eq"]


def inbox_row(row_id: int, conversation_id: str = "c", role: str = "visitor", second: int = 0) -> dict:
    return {
        "id": row_id, "conversation_id": conversation_id, "conversation_name": None, "role": role,
        "needs_attention": False, "read": False, "created_at": f"2026-09-21T10:00:{second:02d}+00:00",
    }


def inbox_queries(client):
    return [ops for ops in client.executed if ("select", (INBOX_COLUMNS,), {}) in ops]


def content_queries(client):
    return [ops for ops in client.executed if ("select", ("id,content",), {}) in ops]


def test_inbox_columns_exclude_content_and_tool_calls():
    assert "content" not in INBOX_COLUMNS.split(",")
    assert "tool_calls" not in INBOX_COLUMNS


def test_inbox_pages_through_1000_row_chunks(fake_repo):
    repo, client = fake_repo
    client.responses = [
        [inbox_row(i) for i in range(1, PAGE_SIZE + 1)],
        [inbox_row(i) for i in range(PAGE_SIZE + 1, 2 * PAGE_SIZE + 1)],
        [inbox_row(2 * PAGE_SIZE + 1)],
        [{"id": 2 * PAGE_SIZE + 1, "content": "latest"}],
    ]
    rows = asyncio.run(repo.list_inbox_rows())
    assert len(rows) == 2 * PAGE_SIZE + 1
    pages = inbox_queries(client)
    assert len(pages) == 3
    ranges = [[op for op in ops if op[0] == "range"][0][1] for ops in pages]
    assert ranges == [(0, 999), (1000, 1999), (2000, 2999)]
    for ops in pages:
        assert ("order", ("id",), {}) in ops
    assert len(client.executed) == 4  # three pages + one preview fetch


def test_inbox_single_page(fake_repo):
    repo, client = fake_repo
    client.responses = [[inbox_row(1)], [{"id": 1, "content": "hello"}]]
    rows = asyncio.run(repo.list_inbox_rows())
    assert [r["id"] for r in rows] == [1]
    assert rows[0]["content"] == "hello"
    assert len(client.executed) == 2


def test_inbox_fetches_only_preview_rows_and_caches_them(fake_repo):
    repo, client = fake_repo
    page = [
        inbox_row(1, "a", "visitor", 0),
        inbox_row(2, "a", "avatar", 1),
        inbox_row(3, "b", "visitor", 2),
        inbox_row(4, "a", "visitor", 3),
        inbox_row(5, "b", "avatar", 4),
    ]
    client.responses = [page, [{"id": 3, "content": "b question"}, {"id": 4, "content": "a" * 500}]]
    rows = asyncio.run(repo.list_inbox_rows())
    assert len(client.executed) == 2
    fetch = content_queries(client)[0]
    assert [op for op in fetch if op[0] == "in_"] == [("in_", ("id", [3, 4]), {})]
    by_id = {r["id"]: r for r in rows}
    assert by_id[4]["content"] == "a" * PREVIEW_CHARS  # cached truncated
    assert by_id[3]["content"] == "b question"
    assert "content" not in by_id[1] and "content" not in by_id[5]
    summaries = {s["conversation_id"]: s for s in summarize_conversations(rows)}
    assert summaries["a"]["preview"] == "a" * PREVIEW_CHARS
    assert summaries["b"]["preview"] == "b question"

    # A repeat poll with the same rows is one round trip: no content query.
    client.executed.clear()
    client.responses = [[dict(r) for r in page]]
    rows = asyncio.run(repo.list_inbox_rows())
    assert len(client.executed) == 1 and content_queries(client) == []
    assert {r["id"]: r.get("content") for r in rows}[4] == "a" * PREVIEW_CHARS

    # A new visitor message in "b" fetches just that row; the superseded one is pruned.
    client.executed.clear()
    client.responses = [[dict(r) for r in page] + [inbox_row(6, "b", "visitor", 5)], [{"id": 6, "content": "b again"}]]
    rows = asyncio.run(repo.list_inbox_rows())
    assert [op for op in content_queries(client)[0] if op[0] == "in_"] == [("in_", ("id", [6]), {})]
    assert set(repo._previews) == {4, 6}


def test_inbox_preview_falls_back_to_latest_row_without_visitor(fake_repo):
    repo, client = fake_repo
    page = [inbox_row(1, "a", "human", 0), inbox_row(2, "a", "avatar", 1)]
    assert preview_source_ids(page) == {"a": 2}
    client.responses = [page, [{"id": 2, "content": "avatar said"}]]
    rows = asyncio.run(repo.list_inbox_rows())
    assert summarize_conversations(rows)[0]["preview"] == "avatar said"


def test_inbox_preview_ids_are_chunked(fake_repo):
    repo, client = fake_repo
    count = PREVIEW_FETCH_CHUNK + 50
    page = [inbox_row(i, f"c{i}") for i in range(1, count + 1)]
    client.responses = [
        page,
        [{"id": i, "content": f"m{i}"} for i in range(1, PREVIEW_FETCH_CHUNK + 1)],
        [{"id": i, "content": f"m{i}"} for i in range(PREVIEW_FETCH_CHUNK + 1, count + 1)],
    ]
    rows = asyncio.run(repo.list_inbox_rows())
    fetches = content_queries(client)
    sizes = [len([op for op in ops if op[0] == "in_"][0][1][1]) for ops in fetches]
    assert sizes == [PREVIEW_FETCH_CHUNK, 50]
    assert all(r["content"] == f"m{r['id']}" for r in rows)


def test_preview_source_ids_uses_latest_visitor_by_time_then_id():
    rows = [
        inbox_row(10, "a", "visitor", 5),
        inbox_row(3, "a", "visitor", 9),  # later in time despite the lower id
        inbox_row(11, "a", "avatar", 10),
    ]
    assert preview_source_ids(rows) == {"a": 3}


def test_get_repository_without_credentials_is_503(tmp_path):
    from fastapi import HTTPException

    from .conftest import make_settings

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=make_settings(tmp_path), repository=None)))
    with pytest.raises(HTTPException) as excinfo:
        db.get_repository(request)  # type: ignore[arg-type]
    assert excinfo.value.status_code == 503


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_parse_timestamp_variants():
    a = parse_timestamp("2026-09-21T10:00:00.5+00:00")
    b = parse_timestamp("2026-09-21T10:00:00.123456+00:00")
    c = parse_timestamp("2026-09-21T10:00:00Z")
    assert c < b < a
    assert parse_timestamp("garbage").year == 1


def test_sort_rows_by_time_then_id():
    rows = [
        {"id": 3, "created_at": "2026-09-21T10:00:00+00:00"},
        {"id": 1, "created_at": "2026-09-21T10:00:01+00:00"},
        {"id": 2, "created_at": "2026-09-21T10:00:00+00:00"},
    ]
    assert [r["id"] for r in sort_rows(rows)] == [2, 3, 1]


def test_conversation_name_from_rows():
    rows = [
        {"id": 1, "created_at": "2026-09-21T10:00:00+00:00", "conversation_name": "A"},
        {"id": 2, "created_at": "2026-09-21T10:00:01+00:00", "conversation_name": None},
        {"id": 3, "created_at": "2026-09-21T10:00:02+00:00", "conversation_name": "B"},
        {"id": 4, "created_at": "2026-09-21T10:00:03+00:00"},
    ]
    assert conversation_name_from_rows(rows) == "B"
    assert conversation_name_from_rows([]) is None


def test_summaries_sorted_by_last_activity_with_varied_precision():
    rows = [
        {"id": 1, "conversation_id": "a", "role": "visitor", "content": "a1", "read": False,
         "needs_attention": False, "created_at": "2026-09-21T10:00:00.9+00:00"},
        {"id": 2, "conversation_id": "b", "role": "visitor", "content": "b1", "read": False,
         "needs_attention": False, "created_at": "2026-09-21T10:00:00.123456+00:00"},
    ]
    assert [s["conversation_id"] for s in summarize_conversations(rows)] == ["a", "b"]


# ---------------------------------------------------------------------------
# Additional repository behaviour
# ---------------------------------------------------------------------------


def test_insert_passes_every_tracked_field(fake_repo):
    repo, client = fake_repo
    client.responses = [[{"id": 1}]]
    tool_calls = [{"type": "function", "name": "push_tool", "arguments": "{}", "output": "ok"}]
    asyncio.run(repo.insert_message("cid", "avatar", "reply", tool_calls=tool_calls, needs_attention=True, read=True))
    record = client.executed[0][1][1][0]
    assert record["tool_calls"] == tool_calls
    assert record["needs_attention"] is True and record["read"] is True
    assert record["conversation_name"] is None
    assert "created_at" not in record and "id" not in record  # set by the database


def test_supabase_client_options(monkeypatch):
    import supabase

    captured = {}

    def fake_create_client(url, key, options=None):
        captured.update(url=url, key=key, options=options)
        return FakeClient()

    monkeypatch.setattr(supabase, "create_client", fake_create_client)
    SupabaseRepository("https://example.supabase.co", "sb_secret_x")
    options = captured["options"]
    assert captured["url"] == "https://example.supabase.co" and captured["key"] == "sb_secret_x"
    assert options.postgrest_client_timeout == 20
    assert options.persist_session is False and options.auto_refresh_token is False


def test_get_repository_is_lazy_and_cached(tmp_path, monkeypatch):
    from .conftest import make_settings

    made = []
    monkeypatch.setattr(db, "create_repository", lambda settings: made.append(settings) or object())
    state = SimpleNamespace(settings=make_settings(tmp_path, supabase_url="https://x", supabase_key="k"), repository=None)
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    first = db.get_repository(request)  # type: ignore[arg-type]
    second = db.get_repository(request)  # type: ignore[arg-type]
    assert first is second and len(made) == 1


def test_create_repository_requires_both_credentials(tmp_path):
    from .conftest import make_settings

    for url, key in (("", "k"), ("https://x", ""), ("", "")):
        with pytest.raises(RuntimeError):
            db.create_repository(make_settings(tmp_path, supabase_url=url, supabase_key=key))


def test_inbox_preview_cache_drops_deleted_conversations(fake_repo):
    repo, client = fake_repo
    client.responses = [[inbox_row(1, "a"), inbox_row(2, "b")], [{"id": 1, "content": "a"}, {"id": 2, "content": "b"}]]
    asyncio.run(repo.list_inbox_rows())
    assert set(repo._previews) == {1, 2}
    client.responses = [[inbox_row(2, "b")]]  # conversation "a" was deleted
    asyncio.run(repo.list_inbox_rows())
    assert set(repo._previews) == {2}


def test_summary_counts_and_flags():
    rows = [
        {"id": 1, "conversation_id": "a", "role": "visitor", "content": "q", "read": True, "needs_attention": False,
         "created_at": "2026-09-21T10:00:00+00:00", "conversation_name": "TEST A"},
        {"id": 2, "conversation_id": "a", "role": "avatar", "content": "r", "read": False, "needs_attention": True,
         "created_at": "2026-09-21T10:00:01+00:00"},
    ]
    summary = summarize_conversations(rows)[0]
    assert summary == {
        "conversation_id": "a", "conversation_name": "TEST A", "started_at": "2026-09-21T10:00:00+00:00",
        "last_message_at": "2026-09-21T10:00:01+00:00", "message_count": 2, "unread_count": 1,
        "needs_attention": True, "preview": "q", "last_role": "avatar",
    }
    assert summarize_conversations([]) == []


def test_readme_schema_matches_the_repository():
    """SPEC: the messages table (columns used here) and its conversation_id / created_at
    indexes are documented in the README setup SQL."""
    import re

    from app.config import REPO_ROOT

    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    table = re.search(r"create table public\.messages \((.*?)\);", readme, re.S | re.I)
    assert table, "README has no messages table SQL"
    for column in ("id", "conversation_id", "conversation_name", "role", "content", "tool_calls",
                   "needs_attention", "read", "created_at"):
        assert re.search(rf"^\s*{column}\s", table.group(1), re.M), column
    assert re.search(r"create index \w+ on public\.messages \(conversation_id\)", readme, re.I)
    assert re.search(r"create index \w+ on public\.messages \(created_at( desc)?\)", readme, re.I)
    for column in INBOX_COLUMNS.split(","):
        assert column in table.group(1)


# -- transient clock-skew rejection (PGRST303 "JWT issued at future") ----------------


def _clock_skew_error():
    from postgrest.exceptions import APIError

    return APIError({"message": "JWT issued at future", "code": "PGRST303", "hint": None, "details": None})


@pytest.fixture
def sleeps(monkeypatch):
    calls: list[float] = []
    monkeypatch.setattr(db.time, "sleep", calls.append)
    return calls


def test_clock_skew_rejection_is_retried_on_reads_and_writes(fake_repo, sleeps):
    """Found by the Docker end-to-end run: Supabase answered one inbox read with PGRST303
    and the route returned 500. The request is refused before any SQL runs, so every
    repository call retries it."""
    repo, client = fake_repo
    row = {"id": 7, "conversation_id": "c", "role": "visitor", "content": "hi"}
    client.responses = [_clock_skew_error(), [row]]
    assert asyncio.run(repo.insert_message("c", "visitor", "hi")) == row
    client.responses = [_clock_skew_error(), _clock_skew_error(), [row]]
    assert asyncio.run(repo.get_conversation("c")) == [row]
    client.responses = [_clock_skew_error(), [row]]
    assert asyncio.run(repo.open_conversation("c")) == [row]
    assert len(client.executed) == 7
    assert sleeps == [0.25, 0.25, 0.75, 0.25]


def test_clock_skew_rejection_gives_up_after_two_retries(fake_repo, sleeps):
    from postgrest.exceptions import APIError

    repo, client = fake_repo
    client.responses = [_clock_skew_error(), _clock_skew_error(), _clock_skew_error(), [{"id": 1}]]
    with pytest.raises(APIError) as info:
        asyncio.run(repo.list_inbox_rows())
    assert info.value.code == "PGRST303"
    assert len(client.executed) == 3
    assert sleeps == [0.25, 0.75]


def test_other_postgrest_errors_are_not_retried(fake_repo, sleeps):
    from postgrest.exceptions import APIError

    repo, client = fake_repo
    client.responses = [APIError({"message": "invalid input value for enum", "code": "22P02"}), [{"id": 1}]]
    with pytest.raises(APIError):
        asyncio.run(repo.insert_message("c", "robot", "x"))
    assert len(client.executed) == 1
    assert sleeps == []
