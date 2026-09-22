"""SupabaseRepository against the real Supabase project.

Auto-skips when SUPABASE_URL / SUPABASE_KEY are not available. Every test uses a
fresh uuid4 conversation (visitor names start with "TEST") and deletes exactly that
conversation afterwards; it never touches any other rows.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from app.config import load_settings
from app.db import SupabaseRepository, conversation_name_from_rows, parse_timestamp, summarize_conversations

_settings = load_settings()
pytestmark = pytest.mark.skipif(
    not (_settings.supabase_url and _settings.supabase_key),
    reason="Supabase credentials not configured",
)


@pytest.fixture(scope="module")
def supabase_repo() -> SupabaseRepository:
    return SupabaseRepository(_settings.supabase_url, _settings.supabase_key)


@pytest.fixture
def conversation_id(supabase_repo):
    cid = str(uuid.uuid4())
    try:
        yield cid
    finally:
        asyncio.run(supabase_repo.delete_conversation(cid))
        assert asyncio.run(supabase_repo.get_conversation(cid)) == []


def run(coro):
    return asyncio.run(coro)


def test_full_repository_roundtrip(supabase_repo, conversation_id):
    cid = conversation_id
    visitor = run(supabase_repo.insert_message(cid, "visitor", "integration hello", conversation_name="TEST Integration"))
    assert visitor["id"] > 0
    assert visitor["role"] == "visitor"
    assert visitor["read"] is False and visitor["needs_attention"] is False
    assert visitor["conversation_name"] == "TEST Integration"

    tool_calls = [{"type": "function", "name": "push_tool", "arguments": '{"message": "x"}', "output": "ok"}]
    avatar = run(supabase_repo.insert_message(cid, "avatar", "integration reply", tool_calls=tool_calls, needs_attention=True))
    assert avatar["tool_calls"] == tool_calls
    assert avatar["needs_attention"] is True

    human = run(supabase_repo.insert_message(cid, "human", "owner joined", read=True))
    assert human["read"] is True

    rows = run(supabase_repo.get_conversation(cid))
    assert [r["id"] for r in rows] == [visitor["id"], avatar["id"], human["id"]]
    assert conversation_name_from_rows(rows) == "TEST Integration"

    after = run(supabase_repo.get_conversation(cid, after_id=visitor["id"]))
    assert [r["id"] for r in after] == [avatar["id"], human["id"]]

    inbox_rows = run(supabase_repo.list_inbox_rows())
    mine = [r for r in inbox_rows if r["conversation_id"] == cid]
    assert len(mine) == 3
    assert "tool_calls" not in mine[0]
    summary = [s for s in summarize_conversations(inbox_rows) if s["conversation_id"] == cid][0]
    assert summary["message_count"] == 3
    assert summary["unread_count"] == 2
    assert summary["needs_attention"] is True
    assert summary["preview"] == "integration hello"
    assert summary["last_role"] == "human"

    opened = run(supabase_repo.open_conversation(cid))
    assert [r["id"] for r in opened] == [visitor["id"], avatar["id"], human["id"]]
    assert all(r["read"] is True and r["needs_attention"] is False for r in opened)

    run(supabase_repo.insert_message(cid, "avatar", "new attention", needs_attention=True))
    run(supabase_repo.resolve_conversation(cid))
    rows = run(supabase_repo.get_conversation(cid))
    assert not any(r["needs_attention"] for r in rows)
    assert rows[-1]["read"] is False  # resolve does not mark read


def test_keepalive_ping_reaches_the_real_table(supabase_repo):
    run(supabase_repo.ping())  # raises if the Data API or the table does not answer


def test_open_unknown_conversation_returns_no_rows(supabase_repo, conversation_id):
    assert run(supabase_repo.open_conversation(conversation_id)) == []
    assert run(supabase_repo.get_conversation(conversation_id)) == []


def test_inbox_preview_is_latest_visitor_message_truncated(supabase_repo, conversation_id):
    cid = conversation_id
    run(supabase_repo.insert_message(cid, "visitor", "first question", conversation_name="TEST preview"))
    long_text = "TEST " + "p" * 300
    run(supabase_repo.insert_message(cid, "visitor", long_text))
    run(supabase_repo.insert_message(cid, "avatar", "a reply that is not the preview"))

    rows = run(supabase_repo.list_inbox_rows())
    summary = [s for s in summarize_conversations(rows) if s["conversation_id"] == cid][0]
    assert summary["preview"] == long_text[:140]
    # The second poll is served from the preview cache and gives the same result.
    rows = run(supabase_repo.list_inbox_rows())
    summary = [s for s in summarize_conversations(rows) if s["conversation_id"] == cid][0]
    assert summary["preview"] == long_text[:140]
    assert all("content" not in r for r in rows if r["conversation_id"] == cid and r["role"] == "avatar")


def test_unicode_and_tool_call_json_round_trip(supabase_repo, conversation_id):
    text = "TEST Tere, Привет, 你好 \U0001F600 \"quotes\" <b>tags</b> \\ backslash\nnew line"
    tool_calls = [{"type": "instant", "faq": 2}, {"type": "function", "name": "faq_tool", "arguments": '{"question_number": 2}',
                                                 "output": "Ω"}]
    run(supabase_repo.insert_message(conversation_id, "visitor", text, conversation_name="TEST Юникод"))
    run(supabase_repo.insert_message(conversation_id, "avatar", "ok", tool_calls=tool_calls))
    rows = run(supabase_repo.get_conversation(conversation_id))
    assert rows[0]["content"] == text
    assert rows[0]["conversation_name"] == "TEST Юникод"
    assert rows[1]["tool_calls"] == tool_calls


def test_timestamps_are_server_set_and_ordered(supabase_repo, conversation_id):
    ids = [run(supabase_repo.insert_message(conversation_id, "visitor", f"TEST {i}"))["id"] for i in range(3)]
    rows = run(supabase_repo.get_conversation(conversation_id))
    assert [r["id"] for r in rows] == ids
    stamps = [parse_timestamp(r["created_at"]) for r in rows]
    assert stamps == sorted(stamps) and all(s.tzinfo is not None for s in stamps)


def test_reads_page_past_supabases_1000_row_cap(supabase_repo, conversation_id):
    """A conversation (and an inbox) longer than one 1000-row response is read completely."""
    records = [
        {"conversation_id": conversation_id, "conversation_name": "TEST paging" if i == 0 else None,
         "role": "visitor" if i % 2 == 0 else "avatar", "content": f"TEST paging row {i}"}
        for i in range(1005)
    ]
    supabase_repo._client.table("messages").insert(records).execute()  # one bulk request
    rows = run(supabase_repo.get_conversation(conversation_id))
    assert len(rows) == 1005
    assert len({r["id"] for r in rows}) == 1005
    last_id = rows[-1]["id"]
    after = run(supabase_repo.get_conversation(conversation_id, after_id=rows[4]["id"]))
    assert len(after) == 1000 and after[-1]["id"] == last_id

    inbox_rows = run(supabase_repo.list_inbox_rows())
    mine = [r for r in inbox_rows if r["conversation_id"] == conversation_id]
    assert len(mine) == 1005
    summary = [s for s in summarize_conversations(inbox_rows) if s["conversation_id"] == conversation_id][0]
    assert summary["message_count"] == 1005 and summary["unread_count"] == 1005
    assert summary["preview"] == "TEST paging row 1004"

    opened = run(supabase_repo.open_conversation(conversation_id))
    assert len(opened) == 1005 and all(r["read"] for r in opened)


def test_http_api_against_real_supabase(supabase_repo, conversation_id, fake_stream, tmp_path):
    """The whole HTTP surface on the real database (the LLM replaced by the fake stream)."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    from .conftest import TEST_PASSWORD, make_settings, parse_sse

    app = create_app(make_settings(tmp_path), repository=supabase_repo)
    cid = conversation_id
    fake_stream.script = [("push", "TEST Supa wants a call"), ("delta", "Passed on.")]
    with TestClient(app) as client:
        events = parse_sse(client.post("/api/chat", json={"conversation_id": cid, "message": "TEST hello db",
                                                             "name": "TEST Supa"}).text)
        assert [e for e, _ in events] == ["start", "tool_called", "tool_output", "delta", "done"]
        instant = parse_sse(client.post("/api/chat", json={"conversation_id": cid, "message": "Q2"}).text)
        assert instant[-1][1]["message"]["tool_calls"] == [{"type": "instant", "faq": 2}]

        public = client.get(f"/api/conversations/{cid}").json()
        assert public["conversation_name"] == "TEST Supa"
        assert [m["role"] for m in public["messages"]] == ["visitor", "avatar", "visitor", "avatar"]
        assert all(set(m) == {"id", "role", "content", "created_at", "tool_calls"} for m in public["messages"])

        assert client.get("/admin/api/conversations").status_code == 401
        assert client.post("/admin/login", json={"password": TEST_PASSWORD}).status_code == 200
        summary = [c for c in client.get("/admin/api/conversations").json()["conversations"] if c["conversation_id"] == cid][0]
        assert summary["needs_attention"] is True and summary["unread_count"] == 4 and summary["preview"] == "Q2"

        opened = client.get(f"/admin/api/conversations/{cid}").json()
        assert all(m["read"] and not m["needs_attention"] for m in opened["messages"])
        posted = client.post(f"/admin/api/conversations/{cid}/messages", json={"content": "TEST owner reply"})
        assert posted.status_code == 201
        human_id = posted.json()["message"]["id"]

        after = client.get(f"/api/conversations/{cid}?after_id={opened['messages'][-1]['id']}").json()
        assert [m["id"] for m in after["messages"]] == [human_id]
        assert after["messages"][0]["role"] == "human"

    rows = run(supabase_repo.get_conversation(cid))
    assert all(r["read"] for r in rows) and not any(r["needs_attention"] for r in rows)


def test_database_enforces_the_role_check(supabase_repo, conversation_id):
    """The README's check constraint is live: only visitor / avatar / human rows can exist."""
    with pytest.raises(Exception):
        run(supabase_repo.insert_message(conversation_id, "system", "TEST forged role"))
    assert run(supabase_repo.get_conversation(conversation_id)) == []
