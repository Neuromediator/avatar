"""Admin API behaviour (with a valid session)."""

from __future__ import annotations

import uuid


def cid() -> str:
    return str(uuid.uuid4())


def test_inbox_summaries_most_recent_first(admin_client, repo):
    a, b = cid(), cid()
    repo.add_row(conversation_id=a, role="visitor", content="first convo question", conversation_name="Ann")
    repo.add_row(conversation_id=a, role="avatar", content="answer A")
    repo.add_row(conversation_id=b, role="visitor", content="second convo question")
    repo.add_row(conversation_id=b, role="avatar", content="answer B", needs_attention=True)
    repo.add_row(conversation_id=a, role="human", content="owner joins A", read=True)

    body = admin_client.get("/admin/api/conversations").json()
    convos = body["conversations"]
    assert [c["conversation_id"] for c in convos] == [a, b]

    first = convos[0]
    assert first["conversation_name"] == "Ann"
    assert first["message_count"] == 3
    assert first["unread_count"] == 2  # the human row is stored read=true
    assert first["needs_attention"] is False
    assert first["preview"] == "first convo question"
    assert first["last_role"] == "human"
    assert first["started_at"] < first["last_message_at"]
    assert set(first) == {
        "conversation_id", "conversation_name", "started_at", "last_message_at", "message_count",
        "unread_count", "needs_attention", "preview", "last_role",
    }

    second = convos[1]
    assert second["conversation_name"] is None
    assert second["needs_attention"] is True
    assert second["unread_count"] == 2
    assert second["last_role"] == "avatar"


def test_inbox_preview_is_latest_visitor_message_truncated(admin_client, repo):
    a = cid()
    repo.add_row(conversation_id=a, role="visitor", content="old question")
    repo.add_row(conversation_id=a, role="visitor", content="x" * 300)
    repo.add_row(conversation_id=a, role="avatar", content="reply")
    convo = admin_client.get("/admin/api/conversations").json()["conversations"][0]
    assert convo["preview"] == "x" * 140


def test_inbox_preview_falls_back_to_latest_message(admin_client, repo):
    a = cid()
    repo.add_row(conversation_id=a, role="human", content="owner started this", read=True)
    convo = admin_client.get("/admin/api/conversations").json()["conversations"][0]
    assert convo["preview"] == "owner started this"
    assert convo["unread_count"] == 0


def test_inbox_name_is_latest_non_null(admin_client, repo):
    a = cid()
    repo.add_row(conversation_id=a, role="visitor", content="1", conversation_name="J")
    repo.add_row(conversation_id=a, role="visitor", content="2", conversation_name="Jordan")
    repo.add_row(conversation_id=a, role="visitor", content="3", conversation_name=None)
    convo = admin_client.get("/admin/api/conversations").json()["conversations"][0]
    assert convo["conversation_name"] == "Jordan"


def test_inbox_empty(admin_client):
    assert admin_client.get("/admin/api/conversations").json() == {"conversations": []}


def test_open_conversation_marks_read_and_clears_attention(admin_client, repo):
    a, other = cid(), cid()
    repo.add_row(conversation_id=a, role="visitor", content="hello", conversation_name="Kim")
    repo.add_row(conversation_id=a, role="avatar", content="notified", needs_attention=True,
                 tool_calls=[{"type": "function", "name": "push_tool", "arguments": "{}", "output": "ok"}])
    repo.add_row(conversation_id=other, role="visitor", content="untouched", needs_attention=True)

    response = admin_client.get(f"/admin/api/conversations/{a}")
    assert response.status_code == 200
    body = response.json()
    assert body["conversation_id"] == a
    assert body["conversation_name"] == "Kim"
    assert [m["content"] for m in body["messages"]] == ["hello", "notified"]
    for message in body["messages"]:
        assert message["read"] is True
        assert message["needs_attention"] is False
        assert set(message) == {"id", "role", "content", "created_at", "tool_calls", "needs_attention", "read"}
    assert body["messages"][1]["tool_calls"][0]["name"] == "push_tool"

    # Single round-trip: one update-returning call, nothing else.
    assert repo.calls == ["open_conversation"]
    # Other conversations are untouched.
    assert [r for r in repo.rows if r["conversation_id"] == other][0]["needs_attention"] is True

    summary = [c for c in admin_client.get("/admin/api/conversations").json()["conversations"] if c["conversation_id"] == a][0]
    assert summary["unread_count"] == 0
    assert summary["needs_attention"] is False


def test_open_unknown_conversation_is_404(admin_client):
    response = admin_client.get(f"/admin/api/conversations/{cid()}")
    assert response.status_code == 404
    assert response.json() == {"detail": "Conversation not found"}


def test_open_invalid_uuid_is_422(admin_client):
    assert admin_client.get("/admin/api/conversations/not-a-uuid").status_code == 422


def test_post_human_message(admin_client, repo, fake_stream):
    a = cid()
    repo.add_row(conversation_id=a, role="visitor", content="is anyone there?")
    response = admin_client.post(f"/admin/api/conversations/{a}/messages", json={"content": "  Yes, I'm here.  "})
    assert response.status_code == 201
    message = response.json()["message"]
    assert message["role"] == "human"
    assert message["content"] == "Yes, I'm here."
    assert message["read"] is True
    assert message["needs_attention"] is False
    stored = repo.for_conversation(a)[-1]
    assert stored["role"] == "human" and stored["conversation_name"] is None and stored["read"] is True
    # The Avatar does not react to the human's message.
    assert fake_stream.calls == []
    assert len(repo.for_conversation(a)) == 2


def test_human_message_visible_to_visitor(admin_client, repo):
    a = cid()
    repo.add_row(conversation_id=a, role="visitor", content="hi")
    admin_client.post(f"/admin/api/conversations/{a}/messages", json={"content": "owner here"})
    admin_client.cookies.clear()
    messages = admin_client.get(f"/api/conversations/{a}").json()["messages"]
    assert messages[-1]["role"] == "human"
    assert messages[-1]["content"] == "owner here"


def test_post_human_message_validation(admin_client):
    a = cid()
    assert admin_client.post(f"/admin/api/conversations/{a}/messages", json={"content": "   "}).status_code == 422
    assert admin_client.post(f"/admin/api/conversations/{a}/messages", json={"content": ""}).status_code == 422
    assert admin_client.post(f"/admin/api/conversations/{a}/messages", json={}).status_code == 422
    assert admin_client.post(f"/admin/api/conversations/{a}/messages", json={"content": "x" * 20001}).status_code == 422
    assert admin_client.post(f"/admin/api/conversations/{a}/messages", json={"content": "x" * 20000}).status_code == 201


def test_resolve_clears_attention_only(admin_client, repo):
    a = cid()
    repo.add_row(conversation_id=a, role="avatar", content="pushed", needs_attention=True)
    response = admin_client.post(f"/admin/api/conversations/{a}/resolve")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    row = repo.for_conversation(a)[0]
    assert row["needs_attention"] is False
    assert row["read"] is False  # resolve does not mark read
    assert repo.calls == ["resolve_conversation"]


def test_post_human_message_drops_nul_and_surrogates(admin_client, repo):
    a = cid()
    response = admin_client.post(f"/admin/api/conversations/{a}/messages", json={"content": "hello\u0000world"})
    assert response.status_code == 201
    assert response.json()["message"]["content"] == "helloworld"
    assert repo.for_conversation(a)[-1]["content"] == "helloworld"

    raw = b'{"content": "owner \\ud800here"}'
    response = admin_client.post(f"/admin/api/conversations/{a}/messages", content=raw,
                                 headers={"content-type": "application/json"})
    assert response.status_code == 201
    assert repo.for_conversation(a)[-1]["content"] == "owner here"


def test_post_human_message_nul_only_is_422(admin_client, repo):
    a = cid()
    response = admin_client.post(f"/admin/api/conversations/{a}/messages", json={"content": "\u0000 \u0000"})
    assert response.status_code == 422
    assert repo.rows == []


# ---------------------------------------------------------------------------
# Additional admin behaviour
# ---------------------------------------------------------------------------


def test_inbox_aggregates_thousands_of_rows(admin_client, repo):
    """Paging itself is covered in test_db.py; here the aggregation over >1000 rows is checked."""
    convos = [cid() for _ in range(3)]
    for i in range(2500):
        c = convos[i % 3]
        role = "visitor" if i % 2 == 0 else "avatar"
        repo.add_row(conversation_id=c, role=role, content=f"{c[:4]} message {i}", read=i < 1500,
                     needs_attention=(i == 2400))
    body = admin_client.get("/admin/api/conversations").json()["conversations"]
    assert len(body) == 3
    assert sum(c["message_count"] for c in body) == 2500
    assert sum(c["unread_count"] for c in body) == 1000
    assert [c["needs_attention"] for c in body].count(True) == 1
    assert [c for c in body if c["needs_attention"]][0]["conversation_id"] == convos[2400 % 3]
    assert body[0]["conversation_id"] == convos[2499 % 3]  # most recent activity first


def test_new_activity_moves_conversation_to_the_top(admin_client, repo, fake_stream):
    a, b = cid(), cid()
    repo.add_row(conversation_id=a, role="visitor", content="old convo")
    repo.add_row(conversation_id=b, role="visitor", content="newer convo")
    assert admin_client.get("/admin/api/conversations").json()["conversations"][0]["conversation_id"] == b
    admin_client.post("/api/chat", json={"conversation_id": a, "message": "back again"})
    inbox = admin_client.get("/admin/api/conversations").json()["conversations"]
    assert [c["conversation_id"] for c in inbox] == [a, b]
    assert inbox[0]["preview"] == "back again"
    assert inbox[0]["last_role"] == "avatar"


def test_three_way_flow_end_to_end_with_fakes(admin_client, repo, fake_stream, pushover):
    """Visitor -> Avatar pushes -> inbox flags it -> owner opens (clears) and replies ->
    visitor sees the owner's bubble -> next Avatar turn gets the owner's message."""
    a = cid()
    fake_stream.script = [("push", "TEST Kim wants a call (kim@example.com)"), ("delta", "I've passed this on.")]
    admin_client.post("/api/chat", json={"conversation_id": a, "message": "Call me: kim@example.com", "name": "TEST Kim"})
    summary = admin_client.get("/admin/api/conversations").json()["conversations"][0]
    assert summary["needs_attention"] is True and summary["unread_count"] == 2 and summary["conversation_name"] == "TEST Kim"

    opened = admin_client.get(f"/admin/api/conversations/{a}").json()
    assert [m["role"] for m in opened["messages"]] == ["visitor", "avatar"]
    summary = admin_client.get("/admin/api/conversations").json()["conversations"][0]
    assert summary["needs_attention"] is False and summary["unread_count"] == 0

    calls_before = len(fake_stream.calls)
    admin_client.post(f"/admin/api/conversations/{a}/messages", json={"content": "Hi Kim, Thursday works."})
    assert len(fake_stream.calls) == calls_before  # the Avatar does not react

    public = admin_client.get(f"/api/conversations/{a}").json()["messages"]
    assert public[-1]["role"] == "human" and public[-1]["content"] == "Hi Kim, Thursday works."

    fake_stream.script = [("delta", "Great.")]
    admin_client.post("/api/chat", json={"conversation_id": a, "message": "Thursday it is", "name": "TEST Kim"})
    prompt = fake_stream.calls[-1]["prompt"]
    assert "Ada Q. Lovelace (the real human, joined live)" in prompt and "Hi Kim, Thursday works." in prompt
    assert "HAS joined this conversation" in prompt
    summary = admin_client.get("/admin/api/conversations").json()["conversations"][0]
    assert summary["unread_count"] == 2  # the new visitor + avatar rows (the owner's own row is read)


def test_resolve_unknown_conversation_is_ok(admin_client, repo):
    assert admin_client.post(f"/admin/api/conversations/{cid()}/resolve").json() == {"ok": True}


def test_admin_routes_validate_uuid(admin_client, repo):
    assert admin_client.post("/admin/api/conversations/nope/messages", json={"content": "x"}).status_code == 422
    assert admin_client.post("/admin/api/conversations/nope/resolve").status_code == 422
    assert repo.rows == []


def test_admin_uuid_is_normalised(admin_client, repo):
    a = cid()
    repo.add_row(conversation_id=a, role="visitor", content="hi")
    assert admin_client.get(f"/admin/api/conversations/{a.upper()}").json()["conversation_id"] == a
    admin_client.post(f"/admin/api/conversations/{a.upper()}/messages", json={"content": "owner"})
    assert repo.for_conversation(a)[-1]["role"] == "human"


def test_open_is_idempotent(admin_client, repo):
    a = cid()
    repo.add_row(conversation_id=a, role="visitor", content="hi", needs_attention=True)
    first = admin_client.get(f"/admin/api/conversations/{a}").json()
    second = admin_client.get(f"/admin/api/conversations/{a}").json()
    assert first == second
