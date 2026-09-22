"""Shared fixtures: in-memory repository, fake agent stream, mocked Pushover, test app."""

from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import agent as agent_module
from app.config import REPO_ROOT, Settings
from app.db import sort_rows
from app.main import create_app

TEST_OWNER = "Ada Q. Lovelace"
TEST_PASSWORD = "correct horse battery staple"
TEST_SECRET = "test-session-secret-0123456789"


# ---------------------------------------------------------------------------
# Only run @pytest.mark.llm tests when explicitly selected with -m llm
# ---------------------------------------------------------------------------


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    markexpr = config.getoption("-m") or ""
    if "llm" in markexpr:
        return
    skip = pytest.mark.skip(reason="LLM test: run with `pytest -m llm`")
    for item in items:
        if "llm" in item.keywords:
            item.add_marker(skip)


# ---------------------------------------------------------------------------
# In-memory repository with the same async interface as SupabaseRepository
# ---------------------------------------------------------------------------


class FakeRepository:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self._next_id = 1
        self._clock = datetime(2026, 9, 21, 10, 0, 0, tzinfo=timezone.utc)
        self.calls: list[str] = []

    def _now(self) -> str:
        self._clock += timedelta(seconds=1)
        return self._clock.isoformat()

    def add_row(self, **fields: Any) -> dict[str, Any]:
        """Synchronous helper for seeding test data."""
        row = {
            "id": self._next_id,
            "conversation_id": fields.pop("conversation_id"),
            "conversation_name": fields.pop("conversation_name", None),
            "role": fields.pop("role"),
            "content": fields.pop("content"),
            "tool_calls": fields.pop("tool_calls", None),
            "needs_attention": fields.pop("needs_attention", False),
            "read": fields.pop("read", False),
            "created_at": fields.pop("created_at", None) or self._now(),
        }
        assert not fields, f"unexpected fields {fields}"
        self._next_id += 1
        self.rows.append(row)
        return copy.deepcopy(row)

    async def insert_message(self, conversation_id, role, content, *, conversation_name=None,
                             tool_calls=None, needs_attention=False, read=False):
        self.calls.append("insert_message")
        for text in (content, conversation_name):
            if text is None:
                continue
            # Mimic Postgres 22P05: text columns cannot hold NUL or lone surrogates.
            if "\x00" in text:
                raise ValueError("22P05: \\u0000 cannot be converted to text")
            text.encode("utf-8")  # raises UnicodeEncodeError on a lone surrogate
        return self.add_row(
            conversation_id=conversation_id, role=role, content=content,
            conversation_name=conversation_name, tool_calls=tool_calls,
            needs_attention=needs_attention, read=read,
        )

    async def get_conversation(self, conversation_id, after_id=None):
        self.calls.append("get_conversation")
        rows = [r for r in self.rows if r["conversation_id"] == conversation_id]
        if after_id is not None:
            rows = [r for r in rows if r["id"] > after_id]
        return copy.deepcopy(sort_rows(rows))

    async def list_inbox_rows(self):
        self.calls.append("list_inbox_rows")
        return copy.deepcopy(self.rows)

    async def open_conversation(self, conversation_id):
        self.calls.append("open_conversation")
        updated = []
        for row in self.rows:
            if row["conversation_id"] == conversation_id:
                row["read"] = True
                row["needs_attention"] = False
                updated.append(row)
        return copy.deepcopy(sort_rows(updated))

    async def resolve_conversation(self, conversation_id):
        self.calls.append("resolve_conversation")
        for row in self.rows:
            if row["conversation_id"] == conversation_id:
                row["needs_attention"] = False

    async def delete_conversation(self, conversation_id):
        self.calls.append("delete_conversation")
        self.rows = [r for r in self.rows if r["conversation_id"] != conversation_id]

    def for_conversation(self, conversation_id: str) -> list[dict[str, Any]]:
        return sort_rows(r for r in self.rows if r["conversation_id"] == conversation_id)


# ---------------------------------------------------------------------------
# Fake agent stream (replaces app.agent.stream_agent_events; no LLM calls)
# ---------------------------------------------------------------------------


class FakeAgentStream:
    """Scriptable stand-in for ``stream_agent_events``.

    ``script`` is a list of steps: ("delta", "text"), ("tool", name, arguments_dict,
    output), ("push", message) (calls the real notify_owner with mocked Pushover),
    ("sleep", seconds), ("raise", exc), ("final", text). If no "final" step is given,
    the final text is the concatenation of the deltas.
    """

    def __init__(self) -> None:
        self.script: list[tuple] = [("delta", "Hello "), ("delta", "there.")]
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, agent, prompt, context):
        self.calls.append({"agent": agent, "prompt": prompt, "context": context})
        text = ""
        final: str | None = None
        counter = 0
        for step in self.script:
            kind = step[0]
            if kind == "delta":
                text += step[1]
                yield "delta", {"text": step[1]}
            elif kind in ("tool", "push"):
                counter += 1
                call_id = f"call_{counter}"
                if kind == "push":
                    name, args = "push_tool", {"message": step[1]}
                else:
                    name, args = step[1], step[2]
                yield "tool_called", {"call_id": call_id, "name": name, "arguments": json.dumps(args)}
                if kind == "push":
                    output = await agent_module.notify_owner(context, step[1])
                else:
                    output = step[3]
                yield "tool_output", {"call_id": call_id, "name": name, "output": output}
            elif kind == "sleep":
                await asyncio.sleep(step[1])
            elif kind == "raise":
                raise step[1]
            elif kind == "final":
                final = step[1]
        yield "final", {"text": final if final is not None else text}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def make_settings(tmp_path: Path | None = None, **overrides: Any) -> Settings:
    values: dict[str, Any] = dict(
        openrouter_api_key="sk-or-test",
        model="openai/gpt-5.4-nano",
        owner_name=TEST_OWNER,
        admin_password=TEST_PASSWORD,
        pushover_user="u-test",
        pushover_token="t-test",
        supabase_url="",
        supabase_key="",
        session_secret=TEST_SECRET,
        cookie_secure=False,
        knowledge_dir=REPO_ROOT / "knowledge",
        static_dir=(tmp_path / "no-dist") if tmp_path else Path("/nonexistent-avatar-dist"),
    )
    values.update(overrides)
    return Settings(**values)


class PushRecorder:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.status = 200
        self.exc: Exception | None = None

    def __call__(self, user, token, message, title=None):
        self.calls.append({"user": user, "token": token, "message": message, "title": title})
        if self.exc:
            raise self.exc
        return self.status


@pytest.fixture(autouse=True)
def pushover(monkeypatch: pytest.MonkeyPatch) -> PushRecorder:
    """Pushover is mocked in every test; a real HTTP POST to it fails loudly."""
    recorder = PushRecorder()
    monkeypatch.setattr(agent_module, "send_pushover", recorder)

    def _no_real_requests(*args, **kwargs):
        raise AssertionError("Real HTTP request attempted via requests.post in a test")

    monkeypatch.setattr(agent_module.requests, "post", _no_real_requests)
    return recorder


@pytest.fixture
def fake_stream(monkeypatch: pytest.MonkeyPatch) -> FakeAgentStream:
    fake = FakeAgentStream()
    monkeypatch.setattr(agent_module, "stream_agent_events", fake)
    return fake


@pytest.fixture
def repo() -> FakeRepository:
    return FakeRepository()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture
def app(settings: Settings, repo: FakeRepository, fake_stream: FakeAgentStream):
    application = create_app(settings, repository=repo)
    application.state.rate_limiter.reset()
    return application


@pytest.fixture
def client(app) -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def admin_client(client: TestClient) -> TestClient:
    response = client.post("/admin/login", json={"password": TEST_PASSWORD})
    assert response.status_code == 200
    return client


def parse_sse(text: str) -> list[tuple[str, dict[str, Any]]]:
    """Parse an SSE body into [(event, data), ...], asserting strict framing."""
    events: list[tuple[str, dict[str, Any]]] = []
    assert text.endswith("\n\n") or text == ""
    for block in text.split("\n\n"):
        if not block:
            continue
        lines = block.split("\n")
        assert len(lines) == 2, f"bad SSE block: {block!r}"
        assert lines[0].startswith("event: ") and lines[1].startswith("data: ")
        events.append((lines[0][len("event: "):], json.loads(lines[1][len("data: "):])))
    return events


@pytest.fixture
def sse() -> Callable[[str], list[tuple[str, dict[str, Any]]]]:
    return parse_sse
