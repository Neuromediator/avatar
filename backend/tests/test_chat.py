"""POST /api/chat: SSE contract, Qn shortcut, clamp, rate limit, tools, errors."""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest

from app.db import summarize_conversations
from app.main import BODY_TOO_LARGE_DETAIL, MAX_BODY_BYTES, TRUNCATION_NOTE, clamp_message, normalize_name, sanitize_text
from app.ratelimit import RATE_LIMIT_DETAIL

from .conftest import TEST_OWNER, parse_sse


def new_cid() -> str:
    return str(uuid.uuid4())


def chat(client, cid, message, name=None):
    payload = {"conversation_id": cid, "message": message}
    if name is not None:
        payload["name"] = name
    return client.post("/api/chat", json=payload)


# ---------------------------------------------------------------------------
# LLM path (fake stream)
# ---------------------------------------------------------------------------


def test_chat_streams_events_in_order_and_stores_reply(client, repo, fake_stream):
    cid = new_cid()
    fake_stream.script = [("delta", "Hi "), ("delta", "Jordan."), ("final", "Hi Jordan.")]
    response = chat(client, cid, "  Hello twin  ", name="  Jordan  ")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"

    events = parse_sse(response.text)
    assert [e for e, _ in events] == ["start", "delta", "delta", "done"]

    start = events[0][1]["visitor_message"]
    assert start["role"] == "visitor"
    assert start["content"] == "Hello twin"
    assert set(start) == {"id", "role", "content", "created_at", "tool_calls"}
    assert [d["text"] for e, d in events if e == "delta"] == ["Hi ", "Jordan."]

    done = events[-1][1]["message"]
    assert done["role"] == "avatar"
    assert done["content"] == "Hi Jordan."
    assert done["tool_calls"] is None
    assert set(done) == {"id", "role", "content", "created_at", "tool_calls"}

    rows = repo.for_conversation(cid)
    assert [r["role"] for r in rows] == ["visitor", "avatar"]
    visitor, avatar = rows
    assert visitor["conversation_name"] == "Jordan"
    assert visitor["read"] is False and visitor["needs_attention"] is False
    assert avatar["id"] == done["id"]
    assert avatar["read"] is False
    assert avatar["needs_attention"] is False
    assert avatar["conversation_name"] is None
    assert avatar["tool_calls"] is None


def test_done_content_is_authoritative_final_output(client, repo, fake_stream):
    cid = new_cid()
    fake_stream.script = [("delta", "partial"), ("final", "  The full final answer.  ")]
    events = parse_sse(chat(client, cid, "question").text)
    assert events[-1][1]["message"]["content"] == "The full final answer."
    assert repo.for_conversation(cid)[-1]["content"] == "The full final answer."


def test_prompt_contains_full_conversation_with_all_roles(client, repo, fake_stream):
    cid = new_cid()
    repo.add_row(conversation_id=cid, role="visitor", content="What do you do?", conversation_name="Jordan")
    repo.add_row(conversation_id=cid, role="avatar", content="I build applied AI systems.")
    repo.add_row(conversation_id=cid, role="human", content="Real owner here, hello!", read=True)
    chat(client, cid, "Nice, and what's next?", name="Jordan")

    assert len(fake_stream.calls) == 1
    call = fake_stream.calls[0]
    prompt = call["prompt"]
    assert "Visitor (Jordan)" in prompt
    assert "Avatar (you)" in prompt
    assert f"{TEST_OWNER} (the real human, joined live)" in prompt
    assert "What do you do?" in prompt and "I build applied AI systems." in prompt
    assert "Real owner here, hello!" in prompt
    latest_block = prompt.split("<latest_visitor_message>")[1]
    assert "Nice, and what's next?" in latest_block
    assert prompt.index("Real owner here") < prompt.index("<latest_visitor_message>")

    ctx = call["context"]
    assert ctx.conversation_id == cid
    assert ctx.visitor_name == "Jordan"
    assert ctx.pushed is False
    assert call["agent"] is client.app.state.agent


def test_tool_events_and_tool_calls_recorded(client, repo, fake_stream):
    cid = new_cid()
    long_output = "A" * 5000
    fake_stream.script = [
        ("tool", "faq_tool", {"question_number": 12}, long_output),
        ("delta", "Here is the dashboard."),
    ]
    events = parse_sse(chat(client, cid, "Tell me about the tennis dashboard").text)
    assert [e for e, _ in events] == ["start", "tool_called", "tool_output", "delta", "done"]
    called = events[1][1]
    assert called == {"call_id": "call_1", "name": "faq_tool", "arguments": json.dumps({"question_number": 12})}
    assert events[2][1] == {"call_id": "call_1", "name": "faq_tool"}  # no output leaked to the client

    avatar = repo.for_conversation(cid)[-1]
    assert avatar["needs_attention"] is False
    assert avatar["tool_calls"] == [
        {"type": "function", "name": "faq_tool", "arguments": json.dumps({"question_number": 12}), "output": "A" * 2000}
    ]
    assert events[-1][1]["message"]["tool_calls"] == avatar["tool_calls"]


def test_push_tool_sets_needs_attention_and_notifies(client, repo, fake_stream, pushover):
    cid = new_cid()
    fake_stream.script = [
        ("push", "Jordan (jordan@example.com) wants to discuss a role"),
        ("delta", "Thanks, I've let the owner know."),
    ]
    events = parse_sse(chat(client, cid, "I'm hiring, my email is jordan@example.com", name="Jordan").text)
    assert [e for e, _ in events] == ["start", "tool_called", "tool_output", "delta", "done"]
    avatar = repo.for_conversation(cid)[-1]
    assert avatar["needs_attention"] is True
    assert avatar["tool_calls"][0]["name"] == "push_tool"
    assert "Notification delivered" in avatar["tool_calls"][0]["output"]

    assert len(pushover.calls) == 1
    push = pushover.calls[0]
    assert push["user"] == "u-test" and push["token"] == "t-test"
    assert "jordan@example.com" in push["message"]
    assert "Jordan" in push["message"]
    assert cid in push["message"]
    assert push["title"] and "Jordan" in push["title"]


def test_no_push_means_no_attention(client, repo, fake_stream, pushover):
    cid = new_cid()
    fake_stream.script = [("tool", "faq_tool", {"question_number": 1}, "faq"), ("delta", "ok")]
    chat(client, cid, "who are you?")
    assert repo.for_conversation(cid)[-1]["needs_attention"] is False
    assert pushover.calls == []


def test_error_event_when_agent_raises(client, repo, fake_stream):
    cid = new_cid()
    fake_stream.script = [("delta", "Starting"), ("raise", RuntimeError("boom: secret stack detail"))]
    response = chat(client, cid, "hello")
    assert response.status_code == 200
    events = parse_sse(response.text)
    assert [e for e, _ in events] == ["start", "delta", "error"]
    detail = events[-1][1]["detail"]
    assert "boom" not in detail and "Traceback" not in detail
    assert "try again" in detail.lower()
    assert [r["role"] for r in repo.for_conversation(cid)] == ["visitor"]  # no avatar row


def test_error_event_when_reply_is_empty(client, repo, fake_stream):
    cid = new_cid()
    fake_stream.script = [("final", "   ")]
    events = parse_sse(chat(client, cid, "hello").text)
    assert [e for e, _ in events] == ["start", "error"]
    assert [r["role"] for r in repo.for_conversation(cid)] == ["visitor"]


def test_error_event_when_storing_reply_fails(client, repo, fake_stream, monkeypatch):
    cid = new_cid()
    original = repo.insert_message

    async def failing_insert(conversation_id, role, content, **kwargs):
        if role == "avatar":
            raise ConnectionError("db down")
        return await original(conversation_id, role, content, **kwargs)

    monkeypatch.setattr(repo, "insert_message", failing_insert)
    events = parse_sse(chat(client, cid, "hello").text)
    assert [e for e, _ in events][-1] == "error"
    assert "done" not in [e for e, _ in events]


def test_visitor_insert_failure_is_503_without_llm_call(client, repo, fake_stream, monkeypatch):
    async def failing_insert(*args, **kwargs):
        raise ConnectionError("db down")

    monkeypatch.setattr(repo, "insert_message", failing_insert)
    response = chat(client, new_cid(), "hello")
    assert response.status_code == 503
    assert "try again" in response.json()["detail"].lower()
    assert fake_stream.calls == []


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("message", ["", "   ", "\n\t "])
def test_blank_message_is_422(client, repo, fake_stream, message):
    response = chat(client, new_cid(), message)
    assert response.status_code == 422
    assert repo.rows == []
    assert fake_stream.calls == []


@pytest.mark.parametrize(
    "payload",
    [
        {"message": "hi"},
        {"conversation_id": "not-a-uuid", "message": "hi"},
        {"conversation_id": str(uuid.uuid4())},
        {"conversation_id": str(uuid.uuid4()), "message": None},
    ],
)
def test_malformed_payload_is_422(client, repo, fake_stream, payload):
    assert client.post("/api/chat", json=payload).status_code == 422
    assert repo.rows == []
    assert fake_stream.calls == []


@pytest.mark.parametrize(
    "name,expected",
    [
        (None, None),
        ("", None),
        ("   ", None),
        ("  Jordan  ", "Jordan"),
        ("Jo   Ann\nSmith", "Jo Ann Smith"),
        ("N" * 80, "N" * 60),
    ],
)
def test_name_normalisation(client, repo, name, expected):
    cid = new_cid()
    chat(client, cid, "hello", name=name)
    assert repo.for_conversation(cid)[0]["conversation_name"] == expected


def test_name_can_change_and_conversation_name_follows(client, repo):
    cid = new_cid()
    chat(client, cid, "hello", name="J")
    chat(client, cid, "hello again", name="Jordan")
    chat(client, cid, "and again")
    assert client.get(f"/api/conversations/{cid}").json()["conversation_name"] == "Jordan"


# ---------------------------------------------------------------------------
# Abuse guard: clamp
# ---------------------------------------------------------------------------


def test_message_of_exactly_20000_chars_is_not_truncated(client, repo, fake_stream):
    cid = new_cid()
    message = "a" * 20000
    events = parse_sse(chat(client, cid, message).text)
    assert events[0][1]["visitor_message"]["content"] == message
    assert repo.for_conversation(cid)[0]["content"] == message
    assert TRUNCATION_NOTE.strip() not in fake_stream.calls[0]["prompt"]


def test_message_of_20001_chars_is_truncated_with_note(client, repo, fake_stream):
    cid = new_cid()
    message = "b" * 20000 + "Z"
    expected = "b" * 20000 + "\n\n[...message truncated as it's too long; ask the visitor to send something more concise]"
    assert TRUNCATION_NOTE == "\n\n[...message truncated as it's too long; ask the visitor to send something more concise]"
    events = parse_sse(chat(client, cid, message).text)
    assert events[0][1]["visitor_message"]["content"] == expected
    stored = repo.for_conversation(cid)[0]["content"]
    assert stored == expected
    assert "Z" not in stored
    # The clamped text is exactly what the agent receives.
    latest = fake_stream.calls[0]["prompt"].split("<latest_visitor_message>\n")[1].split("\n</latest_visitor_message>")[0]
    assert latest == expected


def test_huge_message_is_truncated(client, repo, fake_stream):
    cid = new_cid()
    chat(client, cid, "c" * 250_000)
    stored = repo.for_conversation(cid)[0]["content"]
    assert len(stored) == 20000 + len(TRUNCATION_NOTE)


# ---------------------------------------------------------------------------
# Abuse guard: rate limit
# ---------------------------------------------------------------------------


def test_rate_limit_20_per_minute_per_conversation(client, repo, fake_stream):
    cid = new_cid()
    for i in range(20):
        response = chat(client, cid, f"message {i}")
        assert response.status_code == 200, i
    rows_before = len(repo.rows)
    calls_before = len(fake_stream.calls)

    response = chat(client, cid, "message 21")
    assert response.status_code == 429
    assert response.json() == {"detail": RATE_LIMIT_DETAIL}
    assert int(response.headers["retry-after"]) >= 1
    assert len(repo.rows) == rows_before  # no DB write
    assert len(fake_stream.calls) == calls_before  # no LLM call

    # A different conversation is unaffected.
    other = new_cid()
    assert chat(client, other, "hello").status_code == 200


def test_rate_limit_applies_to_qn_shortcut_too(client, repo):
    cid = new_cid()
    for _ in range(20):
        assert chat(client, cid, "Q1").status_code == 200
    assert chat(client, cid, "Q1").status_code == 429


def test_rate_limit_checked_before_validation(client, repo, fake_stream):
    cid = new_cid()
    for _ in range(20):
        chat(client, cid, "hi")
    # Over the limit: even an invalid (blank) message gets 429, not 422.
    assert chat(client, cid, "   ").status_code == 429


def test_rate_limit_key_is_canonical_uuid(client):
    cid = new_cid()
    for i in range(20):
        chat(client, cid if i % 2 else cid.upper(), "hi")
    assert chat(client, cid, "hi").status_code == 429


def test_rate_limit_resets(client):
    cid = new_cid()
    for _ in range(20):
        chat(client, cid, "hi")
    assert chat(client, cid, "hi").status_code == 429
    client.app.state.rate_limiter.reset()
    assert chat(client, cid, "hi").status_code == 200


# ---------------------------------------------------------------------------
# Qn instant-answer shortcut (no LLM call)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("message,number", [("Q2", 2), ("q16", 16), (" Q2 ", 2), ("q1", 1), ("Q12", 12)])
def test_instant_answer(client, repo, fake_stream, message, number):
    cid = new_cid()
    knowledge = client.app.state.knowledge
    faq = knowledge.faqs[number]
    events = parse_sse(chat(client, cid, message).text)
    assert [e for e, _ in events] == ["start", "instant", "delta", "done"]
    assert events[1][1] == {"faq": number}
    expected = f"**Q{number}:** {faq.question}\n\n{faq.answer}"
    assert events[2][1] == {"text": expected}
    done = events[3][1]["message"]
    assert done["content"] == expected
    assert done["tool_calls"] == [{"type": "instant", "faq": number}]
    assert fake_stream.calls == []  # no LLM call

    visitor, avatar = repo.for_conversation(cid)
    assert visitor["content"] == message.strip()
    assert avatar["role"] == "avatar"
    assert avatar["content"] == expected
    assert avatar["tool_calls"] == [{"type": "instant", "faq": number}]
    assert avatar["needs_attention"] is False and avatar["read"] is False


def test_instant_answer_unknown_number(client, repo, fake_stream):
    cid = new_cid()
    events = parse_sse(chat(client, cid, "Q99").text)
    assert [e for e, _ in events] == ["start", "instant", "delta", "done"]
    assert events[1][1] == {"faq": 99}
    content = events[-1][1]["message"]["content"]
    assert "Q99" in content
    assert client.app.state.knowledge.faq_range_text() in content  # e.g. "Q1 to Q16"
    assert fake_stream.calls == []
    assert repo.for_conversation(cid)[-1]["tool_calls"] == [{"type": "instant", "faq": 99}]


@pytest.mark.parametrize("message", ["Q2 please", "Q 2", "Q123", "What is Q2?", "Q", "QQ2", "Q2."])
def test_non_bare_qn_goes_to_llm(client, fake_stream, message):
    events = parse_sse(chat(client, new_cid(), message).text)
    assert "instant" not in [e for e, _ in events]
    assert len(fake_stream.calls) == 1


def test_instant_answer_appears_in_later_prompt(client, repo, fake_stream):
    cid = new_cid()
    chat(client, cid, "Q2")
    chat(client, cid, "thanks, and where do you work?")
    prompt = fake_stream.calls[0]["prompt"]
    assert "instant FAQ answer Q2" in prompt
    assert "**Q2:**" in prompt


# ---------------------------------------------------------------------------
# Disconnect resilience: the reply is still stored
# ---------------------------------------------------------------------------


def test_reply_stored_when_client_disconnects_mid_stream(app, repo, fake_stream):
    cid = new_cid()
    fake_stream.script = [
        ("delta", "one "),
        ("sleep", 0.05),
        ("delta", "two "),
        ("sleep", 0.05),
        ("delta", "three"),
        ("final", "one two three"),
    ]
    body = json.dumps({"conversation_id": cid, "message": "hello"}).encode()
    sent: list[dict] = []

    async def scenario() -> list:
        got_body = asyncio.Event()
        request_delivered = False

        async def receive():
            nonlocal request_delivered
            if not request_delivered:
                request_delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            await got_body.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)
            if message["type"] == "http.response.body" and b"event: delta" in message.get("body", b""):
                got_body.set()

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/api/chat",
            "raw_path": b"/api/chat",
            "query_string": b"",
            "root_path": "",
            "headers": [(b"content-type", b"application/json"), (b"host", b"testserver")],
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 80),
        }
        await app(scope, receive, send)
        rows_at_disconnect = [r["role"] for r in repo.for_conversation(cid)]
        pending = list(app.state.chat_tasks)
        if pending:
            await asyncio.wait(pending, timeout=5)
        return rows_at_disconnect

    rows_at_disconnect = asyncio.run(scenario())
    streamed = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    assert b"event: start" in streamed
    assert b"event: done" not in streamed  # the client left before the end
    assert rows_at_disconnect == ["visitor"]
    rows = repo.for_conversation(cid)
    assert [r["role"] for r in rows] == ["visitor", "avatar"]
    assert rows[-1]["content"] == "one two three"


# ---------------------------------------------------------------------------
# push_tool delivery status on the live tool_output event
# ---------------------------------------------------------------------------


def test_push_tool_output_event_reports_delivery(client, repo, fake_stream, pushover):
    fake_stream.script = [
        ("push", "Jordan wants a call"),
        ("tool", "faq_tool", {"question_number": 1}, "faq text"),
        ("delta", "Done."),
    ]
    events = parse_sse(chat(client, new_cid(), "please tell the owner").text)
    outputs = [d for e, d in events if e == "tool_output"]
    assert outputs[0] == {"call_id": "call_1", "name": "push_tool", "ok": True}
    assert outputs[1] == {"call_id": "call_2", "name": "faq_tool"}  # no ok key for other tools


def test_push_tool_output_event_reports_not_configured(tmp_path, repo, fake_stream, pushover):
    from fastapi.testclient import TestClient

    from app.main import create_app

    from .conftest import make_settings

    app = create_app(make_settings(tmp_path, pushover_user="", pushover_token=""), repository=repo)
    fake_stream.script = [("push", "Jordan wants a call"), ("delta", "Flagged.")]
    with TestClient(app) as test_client:
        events = parse_sse(chat(test_client, new_cid(), "please tell the owner").text)
    output = [d for e, d in events if e == "tool_output"][0]
    assert output == {"call_id": "call_1", "name": "push_tool", "ok": False}
    assert pushover.calls == []
    assert repo.rows[-1]["needs_attention"] is True


def test_push_tool_output_event_reports_failed_delivery(client, repo, fake_stream, pushover):
    pushover.status = 500
    fake_stream.script = [("push", "Jordan wants a call"), ("delta", "Flagged.")]
    events = parse_sse(chat(client, new_cid(), "please tell the owner").text)
    assert [d for e, d in events if e == "tool_output"][0]["ok"] is False


# ---------------------------------------------------------------------------
# A turn that pushed and then failed still flags the conversation
# ---------------------------------------------------------------------------


def assert_push_fallback(client, repo, cid, events, pushover):
    kinds = [e for e, _ in events]
    assert kinds[-1] == "done" and "error" not in kinds
    rows = repo.for_conversation(cid)
    assert [r["role"] for r in rows] == ["visitor", "avatar"]
    avatar = rows[-1]
    assert avatar["needs_attention"] is True
    assert avatar["tool_calls"][0]["name"] == "push_tool"
    assert "Ada" in avatar["content"] and "passed your message on" in avatar["content"]
    assert events[-1][1]["message"]["id"] == avatar["id"]
    assert len(pushover.calls) == 1
    summary = [s for s in summarize_conversations(repo.rows) if s["conversation_id"] == cid][0]
    assert summary["needs_attention"] is True


def test_push_then_model_failure_keeps_flag_and_marker(client, repo, fake_stream, pushover):
    cid = new_cid()
    fake_stream.script = [("push", "visitor wants a call"), ("raise", RuntimeError("upstream 502"))]
    events = parse_sse(chat(client, cid, "call me: jo@example.com").text)
    assert_push_fallback(client, repo, cid, events, pushover)
    # The admin inbox shows it too.
    client.post("/admin/login", json={"password": "correct horse battery staple"})
    inbox = client.get("/admin/api/conversations").json()["conversations"]
    assert [c for c in inbox if c["conversation_id"] == cid][0]["needs_attention"] is True


def test_push_then_empty_reply_keeps_flag_and_marker(client, repo, fake_stream, pushover):
    cid = new_cid()
    fake_stream.script = [("push", "visitor wants a call"), ("final", "   ")]
    events = parse_sse(chat(client, cid, "call me: jo@example.com").text)
    assert_push_fallback(client, repo, cid, events, pushover)


def test_push_fallback_marker_is_added_when_tool_events_were_missed(client, repo, fake_stream, monkeypatch):
    """ctx.pushed alone (no push_tool event seen) still stores a push marker."""
    from app import agent as agent_module

    async def stream(agent, prompt, context):
        await agent_module.notify_owner(context, "silent push")
        yield "delta", {"text": "partial"}
        raise RuntimeError("boom")

    monkeypatch.setattr(agent_module, "stream_agent_events", stream)
    cid = new_cid()
    events = parse_sse(chat(client, cid, "hi").text)
    assert events[-1][0] == "done"
    avatar = repo.for_conversation(cid)[-1]
    assert avatar["needs_attention"] is True
    assert avatar["tool_calls"] == [{"type": "function", "name": "push_tool", "arguments": "{}", "output": ""}]


def test_push_then_failure_and_fallback_insert_failure_is_error(client, repo, fake_stream, monkeypatch):
    cid = new_cid()
    original = repo.insert_message

    async def failing_insert(conversation_id, role, content, **kwargs):
        if role == "avatar":
            raise ConnectionError("db down")
        return await original(conversation_id, role, content, **kwargs)

    monkeypatch.setattr(repo, "insert_message", failing_insert)
    fake_stream.script = [("push", "visitor wants a call"), ("delta", "Notified.")]
    events = parse_sse(chat(client, cid, "hello").text)
    assert events[-1][0] == "error"
    assert [r["role"] for r in repo.for_conversation(cid)] == ["visitor"]


# ---------------------------------------------------------------------------
# Request body size limit
# ---------------------------------------------------------------------------


def test_oversized_chat_body_is_413_and_stores_nothing(client, repo, fake_stream):
    response = chat(client, new_cid(), "x" * 600_000)
    assert response.status_code == 413
    assert response.json() == {"detail": BODY_TOO_LARGE_DETAIL}
    assert repo.rows == []
    assert fake_stream.calls == []


def test_oversized_chunked_chat_body_is_413(client, repo, fake_stream):
    cid = new_cid()

    def body():
        yield f'{{"conversation_id": "{cid}", "message": "'.encode()
        for _ in range(10):
            yield b"y" * 100_000
        yield b'"}'

    response = client.post("/api/chat", content=body(), headers={"content-type": "application/json"})
    assert response.status_code == 413
    assert response.json() == {"detail": BODY_TOO_LARGE_DETAIL}
    assert repo.rows == []
    assert fake_stream.calls == []


def test_small_chunked_chat_body_is_accepted(client, repo, fake_stream):
    cid = new_cid()

    def body():
        yield f'{{"conversation_id": "{cid}", '.encode()
        yield b'"message": "hello in chunks"}'

    response = client.post("/api/chat", content=body(), headers={"content-type": "application/json"})
    assert response.status_code == 200
    assert repo.for_conversation(cid)[0]["content"] == "hello in chunks"


def test_body_just_under_the_limit_is_truncated_not_rejected(client, repo, fake_stream):
    cid = new_cid()
    message = "z" * (MAX_BODY_BYTES - 200)
    response = chat(client, cid, message)
    assert response.status_code == 200
    assert len(repo.for_conversation(cid)[0]["content"]) == 20000 + len(TRUNCATION_NOTE)


def test_oversized_login_body_is_413(client):
    response = client.post("/admin/login", json={"password": "p" * 600_000})
    assert response.status_code == 413
    assert response.json() == {"detail": BODY_TOO_LARGE_DETAIL}
    assert "set-cookie" not in response.headers


def test_overlong_login_password_is_422(client):
    assert client.post("/admin/login", json={"password": "p" * 2000}).status_code == 422


def test_overlong_name_field_is_422(client, repo):
    assert chat(client, new_cid(), "hi", name="n" * 1001).status_code == 422
    assert repo.rows == []


# ---------------------------------------------------------------------------
# Characters Postgres text cannot store
# ---------------------------------------------------------------------------


def test_sanitize_text():
    assert sanitize_text("a\x00b") == "ab"
    assert sanitize_text("x\ud800y") == "xy"
    assert sanitize_text("Tere, Привет, 你好 \U0001F600") == "Tere, Привет, 你好 \U0001F600"
    assert sanitize_text("\x00\x00") == ""


def test_normalize_name_and_clamp_helpers():
    assert normalize_name("TEST\x00nul") == "TESTnul"
    assert normalize_name("\x00 \x00") is None
    assert normalize_name("  A  \ud800 B ") == "A B"
    assert clamp_message("short") == "short"
    assert clamp_message("k" * 20001) == "k" * 20000 + TRUNCATION_NOTE


def test_nul_in_message_is_dropped_and_qn_still_works(client, repo, fake_stream):
    cid = new_cid()
    response = chat(client, cid, "Q1\u0000")
    assert response.status_code == 200
    events = parse_sse(response.text)
    assert [e for e, _ in events] == ["start", "instant", "delta", "done"]
    assert repo.for_conversation(cid)[0]["content"] == "Q1"
    assert fake_stream.calls == []


def test_nul_in_name_is_dropped(client, repo):
    cid = new_cid()
    assert chat(client, cid, "hello", name="TEST\u0000nul").status_code == 200
    assert repo.for_conversation(cid)[0]["conversation_name"] == "TESTnul"


def test_nul_only_message_is_422(client, repo, fake_stream):
    assert chat(client, new_cid(), "\u0000\u0000 ").status_code == 422
    assert repo.rows == []


def test_lone_surrogate_is_dropped(client, repo, fake_stream):
    cid = new_cid()
    raw = '{"conversation_id": "%s", "message": "hi \\ud800 there", "name": "TEST \\udfff"}' % cid
    response = client.post("/api/chat", content=raw.encode(), headers={"content-type": "application/json"})
    assert response.status_code == 200
    visitor = repo.for_conversation(cid)[0]
    assert visitor["content"] == "hi  there"
    visitor["content"].encode("utf-8")
    assert visitor["conversation_name"] == "TEST"
    assert parse_sse(response.text)[-1][0] == "done"


# ---------------------------------------------------------------------------
# SSE framing and payloads (additional)
# ---------------------------------------------------------------------------


def test_sse_framing_survives_newlines_and_non_ascii(client, repo, fake_stream):
    cid = new_cid()
    text = "Line one.\n\nevent: fake\ndata: {}\n\nTere! Привет. 你好"
    fake_stream.script = [("delta", text)]
    response = chat(client, cid, "hello")
    assert "Привет" in response.text  # UTF-8 on the wire, not \\u-escaped
    events = parse_sse(response.text)  # strict: exactly one event + one data line per block
    assert [e for e, _ in events] == ["start", "delta", "done"]
    assert events[1][1]["text"] == text
    assert events[-1][1]["message"]["content"] == text.strip()


def test_tool_call_without_id_gets_a_generated_one(client, repo, monkeypatch):
    from app import agent as agent_module

    async def stream(agent, prompt, context):
        yield "tool_called", {"call_id": "", "name": "faq_tool", "arguments": '{"question_number": 3}'}
        yield "tool_output", {"call_id": "unknown-id", "name": "faq_tool", "output": "orphan"}
        yield "delta", {"text": "ok"}
        yield "final", {"text": "ok"}

    monkeypatch.setattr(agent_module, "stream_agent_events", stream)
    cid = new_cid()
    events = parse_sse(chat(client, cid, "hi").text)
    assert events[1] == ("tool_called", {"call_id": "call_1", "name": "faq_tool", "arguments": '{"question_number": 3}'})
    assert events[2] == ("tool_output", {"call_id": "unknown-id", "name": "faq_tool"})
    stored = repo.for_conversation(cid)[-1]["tool_calls"]
    assert stored == [{"type": "function", "name": "faq_tool", "arguments": '{"question_number": 3}', "output": ""}]


def test_parallel_tool_calls_are_all_recorded_in_order(client, repo, fake_stream):
    cid = new_cid()
    fake_stream.script = [
        ("tool", "faq_tool", {"question_number": 12}, "twelve"),
        ("tool", "faq_tool", {"question_number": 13}, "thirteen"),
        ("delta", "Both."),
    ]
    events = parse_sse(chat(client, cid, "tell me about both projects").text)
    assert [e for e, _ in events] == ["start", "tool_called", "tool_output", "tool_called", "tool_output", "delta", "done"]
    stored = repo.for_conversation(cid)[-1]["tool_calls"]
    assert [json.loads(c["arguments"])["question_number"] for c in stored] == [12, 13]
    assert [c["output"] for c in stored] == ["twelve", "thirteen"]


def test_only_the_avatar_row_that_pushed_is_flagged(client, repo, fake_stream, pushover):
    cid = new_cid()
    chat(client, cid, "hello")
    fake_stream.script = [("push", "wants a call"), ("delta", "Passed on.")]
    chat(client, cid, "please ask the owner to call me: TEST@example.com")
    fake_stream.script = [("delta", "Anything else?")]
    chat(client, cid, "thanks")
    flags = [(r["role"], r["needs_attention"]) for r in repo.for_conversation(cid)]
    assert flags == [("visitor", False), ("avatar", False), ("visitor", False), ("avatar", True),
                     ("visitor", False), ("avatar", False)]
    # The later turn sees the earlier push in its transcript (so it does not push again).
    assert 'used push_tool: notified Ada: "wants a call"' in fake_stream.calls[-1]["prompt"]


def test_prompt_uses_the_current_request_name(client, repo, fake_stream):
    cid = new_cid()
    chat(client, cid, "hello", name="TEST One")
    chat(client, cid, "hello again", name="TEST Two")
    assert fake_stream.calls[-1]["context"].visitor_name == "TEST Two"
    assert 'Visitor (TEST Two)' in fake_stream.calls[-1]["prompt"]


def test_prompt_is_built_from_a_fresh_read_including_the_new_message(client, repo, fake_stream):
    cid = new_cid()
    repo.add_row(conversation_id=cid, role="visitor", content="earlier question")
    repo.calls.clear()
    chat(client, cid, "the new one")
    assert repo.calls == ["insert_message", "get_conversation", "insert_message"]
    prompt = fake_stream.calls[0]["prompt"]
    assert "earlier question" in prompt.split("<transcript>")[1].split("</transcript>")[0]
    assert "the new one" not in prompt.split("<transcript>")[1].split("</transcript>")[0]


# ---------------------------------------------------------------------------
# Clamp (additional)
# ---------------------------------------------------------------------------


def test_clamp_counts_characters_not_bytes(client, repo, fake_stream):
    cid = new_cid()
    chat(client, cid, "й" * 20001)
    stored = repo.for_conversation(cid)[0]["content"]
    assert stored == "й" * 20000 + TRUNCATION_NOTE


def test_clamp_applies_after_trimming_whitespace(client, repo, fake_stream):
    cid = new_cid()
    message = "a" * 20000
    chat(client, cid, "   " + message + "\n\n  ")
    assert repo.for_conversation(cid)[0]["content"] == message


def test_truncation_note_is_exactly_the_spec_text():
    assert TRUNCATION_NOTE.strip() == "[...message truncated as it's too long; ask the visitor to send something more concise]"


# ---------------------------------------------------------------------------
# Rate limiter (additional)
# ---------------------------------------------------------------------------


def test_chat_limiter_is_a_20_per_minute_moving_window_in_memory():
    from limits.storage import MemoryStorage
    from limits.strategies import MovingWindowRateLimiter

    from app.ratelimit import ConversationRateLimiter

    limiter = ConversationRateLimiter()
    assert str(limiter.item) == "20 per 1 minute"
    assert isinstance(limiter.limiter, MovingWindowRateLimiter)
    assert isinstance(limiter.storage, MemoryStorage)


def test_moving_window_frees_slots_one_minute_after_each_hit(monkeypatch):
    """A fixed window would free all 20 slots at the minute boundary; a moving one frees them as each hit ages out."""
    import time as time_module

    from app.ratelimit import ConversationRateLimiter

    clock = [1_000_020.0]  # 20 s into a minute, so a fixed window would reset at +40 s
    monkeypatch.setattr(time_module, "time", lambda: clock[0])
    limiter = ConversationRateLimiter()
    for _ in range(10):
        assert limiter.hit("c")
    clock[0] += 30
    for _ in range(10):
        assert limiter.hit("c")
    assert not limiter.hit("c")
    clock[0] += 15  # past the fixed-window boundary, but no hit is a minute old yet
    assert not limiter.hit("c")
    assert 1 <= limiter.retry_after("c") <= 16
    clock[0] += 16  # the first 10 hits are now over a minute old
    for _ in range(10):
        assert limiter.hit("c")
    assert not limiter.hit("c")
    assert limiter.hit("other")  # per conversation


def test_rate_limited_request_touches_nothing(client, repo, fake_stream):
    cid = new_cid()
    for _ in range(20):
        chat(client, cid, "hi")
    repo.calls.clear()
    calls_before = len(fake_stream.calls)
    response = chat(client, cid, "one too many")
    assert response.status_code == 429
    assert response.headers["content-type"].startswith("application/json")
    assert "too quickly" in response.json()["detail"]
    assert repo.calls == []  # no read, no write
    assert len(fake_stream.calls) == calls_before  # no LLM call


def test_rate_limit_counts_messages_not_characters(client, repo, fake_stream):
    """Truncated or long messages still count as one message each."""
    cid = new_cid()
    for _ in range(20):
        assert chat(client, cid, "x" * 25_000).status_code == 200
    assert chat(client, cid, "short").status_code == 429


# ---------------------------------------------------------------------------
# Body size (additional) and shutdown
# ---------------------------------------------------------------------------


def test_oversized_admin_message_body_is_413(admin_client, repo):
    cid = new_cid()
    response = admin_client.post(f"/admin/api/conversations/{cid}/messages", json={"content": "h" * 600_000})
    assert response.status_code == 413
    assert response.json() == {"detail": BODY_TOO_LARGE_DETAIL}
    assert repo.rows == []


def test_body_size_limit_applies_before_auth(client, repo):
    response = client.post(f"/admin/api/conversations/{new_cid()}/messages", json={"content": "h" * 600_000})
    assert response.status_code == 413
    assert repo.rows == []


def test_shutdown_waits_for_in_flight_replies(app):
    async def scenario():
        async with app.router.lifespan_context(app):
            task = asyncio.create_task(asyncio.sleep(0.1, result="stored"))
            app.state.chat_tasks.add(task)
        # Checked inside the loop: asyncio.run would cancel a still-pending task on exit.
        return task.done() and not task.cancelled() and task.result() == "stored"

    assert asyncio.run(scenario()) is True


# ---------------------------------------------------------------------------
# Real HTTP server: events are flushed as they happen (no buffering)
# ---------------------------------------------------------------------------


def test_sse_is_delivered_incrementally_over_real_http(app, fake_stream):
    import socket
    import threading
    import time

    import httpx
    import uvicorn

    fake_stream.script = [("delta", "first "), ("sleep", 0.6), ("delta", "second"), ("final", "first second")]
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.time() + 10
        while not server.started and time.time() < deadline:
            time.sleep(0.02)
        assert server.started
        arrivals: dict[str, float] = {}
        start = time.monotonic()
        payload = {"conversation_id": new_cid(), "message": "hello"}
        with httpx.stream("POST", f"http://127.0.0.1:{port}/api/chat", json=payload, timeout=10) as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            for line in response.iter_lines():
                if line.startswith("event: "):
                    arrivals.setdefault(line[7:], time.monotonic() - start)
        assert list(arrivals) == ["start", "delta", "done"]
        # "start" and the first delta arrive well before the reply finishes (0.6 s later).
        assert arrivals["delta"] < arrivals["done"] - 0.4
        assert arrivals["start"] < 0.5
    finally:
        server.should_exit = True
        thread.join(timeout=10)
