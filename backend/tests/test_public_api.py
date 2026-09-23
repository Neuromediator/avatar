"""Public API (/api/config, conversation fetch) and static page serving."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import create_app

from .conftest import TEST_OWNER, make_settings


def test_config_endpoint(client, repo):
    response = client.get("/api/config")
    assert response.status_code == 200
    assert response.json() == {"owner_name": TEST_OWNER, "owner_first_name": "Ada"}
    assert repo.calls == []  # no DB hit (Fly health check)


def test_config_works_without_database_configuration(tmp_path, fake_stream):
    app = create_app(make_settings(tmp_path))  # no repository, no Supabase credentials
    with TestClient(app) as client:
        assert client.get("/api/config").status_code == 200
        response = client.get(f"/api/conversations/{uuid.uuid4()}")
        assert response.status_code == 503
        assert response.json() == {"detail": "The database is not configured."}


def test_fetch_invalid_uuid_is_422(client):
    assert client.get("/api/conversations/not-a-uuid").status_code == 422
    assert client.get("/api/conversations/1234").status_code == 422


def test_fetch_unknown_conversation_returns_empty(client):
    cid = str(uuid.uuid4())
    response = client.get(f"/api/conversations/{cid}")
    assert response.status_code == 200
    assert response.json() == {"conversation_id": cid, "conversation_name": None, "messages": []}


def test_fetch_returns_ordered_public_messages(client, repo):
    cid, other = str(uuid.uuid4()), str(uuid.uuid4())
    repo.add_row(conversation_id=cid, role="visitor", content="one", conversation_name="Jo")
    repo.add_row(conversation_id=other, role="visitor", content="someone else's")
    repo.add_row(conversation_id=cid, role="avatar", content="two", needs_attention=True,
                 tool_calls=[{"type": "instant", "faq": 2}])
    repo.add_row(conversation_id=cid, role="human", content="three", read=True)

    body = client.get(f"/api/conversations/{cid}").json()
    assert body["conversation_id"] == cid
    assert body["conversation_name"] == "Jo"
    assert [m["content"] for m in body["messages"]] == ["one", "two", "three"]
    assert [m["role"] for m in body["messages"]] == ["visitor", "avatar", "human"]
    assert body["messages"][1]["tool_calls"] == [{"type": "instant", "faq": 2}]
    for message in body["messages"]:
        assert set(message) == {"id", "role", "content", "created_at", "tool_calls"}
        assert isinstance(message["id"], int)
        assert "T" in message["created_at"]
    assert repo.calls == ["get_conversation"]  # one round-trip


def test_fetch_uuid_is_normalised(client, repo):
    cid = str(uuid.uuid4())
    repo.add_row(conversation_id=cid, role="visitor", content="hello")
    body = client.get(f"/api/conversations/{cid.upper()}").json()
    assert body["conversation_id"] == cid
    assert len(body["messages"]) == 1


def test_fetch_name_is_latest_non_null(client, repo):
    cid = str(uuid.uuid4())
    repo.add_row(conversation_id=cid, role="visitor", content="a", conversation_name="J")
    repo.add_row(conversation_id=cid, role="visitor", content="b", conversation_name="Jordan")
    repo.add_row(conversation_id=cid, role="visitor", content="c")
    assert client.get(f"/api/conversations/{cid}").json()["conversation_name"] == "Jordan"


def test_fetch_after_id(client, repo):
    cid = str(uuid.uuid4())
    first = repo.add_row(conversation_id=cid, role="visitor", content="a", conversation_name="Jo")
    second = repo.add_row(conversation_id=cid, role="avatar", content="b")
    third = repo.add_row(conversation_id=cid, role="human", content="c", read=True)

    body = client.get(f"/api/conversations/{cid}?after_id={first['id']}").json()
    assert [m["id"] for m in body["messages"]] == [second["id"], third["id"]]
    assert body["conversation_name"] is None  # derived from the loaded rows only

    body = client.get(f"/api/conversations/{cid}?after_id={third['id']}").json()
    assert body["messages"] == []

    body = client.get(f"/api/conversations/{cid}?after_id=0").json()
    assert len(body["messages"]) == 3


def test_fetch_after_id_validation(client):
    cid = str(uuid.uuid4())
    assert client.get(f"/api/conversations/{cid}?after_id=abc").status_code == 422
    assert client.get(f"/api/conversations/{cid}?after_id=-1").status_code == 422


def test_fetch_after_id_is_bounded_to_bigint(client, repo):
    cid = str(uuid.uuid4())
    assert client.get(f"/api/conversations/{cid}?after_id={2**63}").status_code == 422
    assert repo.calls == []  # never reaches the database
    assert client.get(f"/api/conversations/{cid}?after_id={2**63 - 1}").status_code == 200


def test_validation_errors_echoing_lone_surrogates_render(client, repo):
    """A 422 that echoes a lone surrogate must render, not crash into a 500."""
    for raw in (b'{"conversation_id": "\\ud800", "message": "hi"}',):
        response = client.post("/api/chat", content=raw, headers={"content-type": "application/json"})
        assert response.status_code == 422
        assert response.json()["detail"][0]["loc"] == ["body", "conversation_id"]
    response = client.post("/admin/login", content=b'{"password": "x\\ud800"}',
                           headers={"content-type": "application/json"})
    assert response.status_code == 422
    assert repo.rows == []


def test_validation_error_body_shape_is_unchanged(client):
    response = client.post("/api/chat", json={"conversation_id": "not-a-uuid", "message": "hi"})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list) and detail[0]["loc"] == ["body", "conversation_id"]


# ---------------------------------------------------------------------------
# Static pages
# ---------------------------------------------------------------------------


def make_dist(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        "<title>{{OWNER_NAME}} - digital twin</title><p>Hi, I'm {{OWNER_FIRST_NAME}}'s twin</p>",
        encoding="utf-8",
    )
    (dist / "admin.html").write_text("<h1>{{OWNER_NAME}} admin</h1>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log('ok')", encoding="utf-8")
    (dist / "icons.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'></svg>", encoding="utf-8")
    return dist


def test_static_pages_are_templated_and_escaped(tmp_path, repo, fake_stream):
    dist = make_dist(tmp_path)
    settings = make_settings(tmp_path, owner_name='Zoë <O\'Brien> & "Co"', static_dir=dist)
    app = create_app(settings, repository=repo)
    with TestClient(app) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        assert response.headers["cache-control"] == "no-cache"
        assert "{{" not in response.text
        assert "Zoë &lt;O&#x27;Brien&gt; &amp; &quot;Co&quot; - digital twin" in response.text
        assert "Hi, I'm Zoë's twin" in response.text
        assert "<O'Brien>" not in response.text

        for path in ("/admin", "/admin/", "/admin.html"):
            page = client.get(path)
            assert page.status_code == 200
            assert page.headers["cache-control"] == "no-cache"
            assert "Zoë &lt;O&#x27;Brien&gt;" in page.text and "admin" in page.text

        raw = client.get("/index.html")
        assert raw.status_code == 200 and "{{OWNER_NAME}}" not in raw.text

        assert client.get("/assets/app.js").text == "console.log('ok')"
        assert client.get("/icons.svg").status_code == 200
        assert client.get("/missing.png").status_code == 404
        # API routes still take precedence over the static mount.
        assert client.get("/api/config").json()["owner_first_name"] == "Zoë"


def test_static_missing_dist_returns_503_but_api_works(tmp_path, repo, fake_stream):
    app = create_app(make_settings(tmp_path, static_dir=tmp_path / "does-not-exist"), repository=repo)
    with TestClient(app) as client:
        assert client.get("/").status_code == 503
        assert client.get("/admin").status_code == 503
        assert client.get("/api/config").status_code == 200
        assert client.get(f"/api/conversations/{uuid.uuid4()}").status_code == 200


def test_head_requests_match_get(tmp_path, repo, fake_stream):
    dist = make_dist(tmp_path)
    app = create_app(make_settings(tmp_path, static_dir=dist), repository=repo)
    with TestClient(app) as client:
        for path in ("/", "/index.html", "/admin", "/admin/", "/admin.html", "/api/config"):
            head = client.head(path)
            get = client.get(path)
            assert head.status_code == 200, path
            assert head.content == b"", path
            assert head.headers["content-length"] == get.headers["content-length"], path
            if path != "/api/config":  # served by render_page, not StaticFiles
                assert head.headers["cache-control"] == "no-cache", path
                assert "{{" not in get.text
        cid = uuid.uuid4()
        assert client.head(f"/api/conversations/{cid}").status_code == 200
        assert client.head("/icons.svg").status_code == 200
        assert client.head("/missing.png").status_code == 404


# ---------------------------------------------------------------------------
# Additional public/static behaviour
# ---------------------------------------------------------------------------


def test_pages_can_be_framed(tmp_path, repo, fake_stream):
    """SPEC (iframe embedding): with FRAME_ANCESTORS unset, anyone may frame the app."""
    dist = make_dist(tmp_path)
    app = create_app(make_settings(tmp_path, static_dir=dist), repository=repo)
    with TestClient(app) as client:
        for path in ("/", "/admin", "/api/config", "/assets/app.js"):
            headers = client.get(path).headers
            assert "x-frame-options" not in headers, path
            assert "frame-ancestors" not in headers.get("content-security-policy", ""), path


def test_frame_ancestors_restricts_framing(tmp_path, repo, fake_stream):
    """SPEC (iframe embedding): FRAME_ANCESTORS limits framing to the owner's site."""
    dist = make_dist(tmp_path)
    settings = make_settings(
        tmp_path,
        static_dir=dist,
        frame_ancestors="https://example.com https://www.example.com",
    )
    app = create_app(settings, repository=repo)
    with TestClient(app) as client:
        for path in ("/", "/admin", "/api/config", "/assets/app.js"):
            policy = client.get(path).headers.get("content-security-policy", "")
            assert policy == (
                "frame-ancestors 'self' https://example.com https://www.example.com"
            ), path
            assert "x-frame-options" not in client.get(path).headers, path


def test_no_api_docs_exposed(client):
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404, path


def test_real_built_frontend_is_templated_from_config(tmp_path, repo, fake_stream):
    """The shipped dist/ pages get OWNER_NAME from config; no {{placeholders}} survive."""
    from app.config import REPO_ROOT

    dist = REPO_ROOT / "frontend" / "dist"
    if not (dist / "index.html").is_file() or not (dist / "admin.html").is_file():
        import pytest

        pytest.skip("frontend not built (run npm run build in frontend/)")
    settings = make_settings(tmp_path, owner_name="Grace Brewster Hopper", static_dir=dist)
    app = create_app(settings, repository=repo)
    with TestClient(app) as client:
        visitor = client.get("/").text
        admin = client.get("/admin").text
    import re

    for page in (visitor, admin):
        assert not re.search(r"\{\{\s*[A-Z_]+\s*\}\}", page)  # (inline JS may contain "}}")
        assert "Grace Brewster Hopper" in page
    assert "<title>Grace Brewster Hopper" in visitor
    assert 'content="Grace"' in visitor  # avatar:owner-first-name meta
    assert "Grace\u2019s" in visitor  # intro / composer copy uses the first name (typographic apostrophe)
    assert make_settings().owner_name not in visitor


def test_fetch_includes_every_role_and_tool_calls(client, repo):
    cid = str(uuid.uuid4())
    tool_calls = [{"type": "function", "name": "push_tool", "arguments": '{"message": "x"}', "output": "ok"}]
    repo.add_row(conversation_id=cid, role="visitor", content="v")
    repo.add_row(conversation_id=cid, role="avatar", content="a", tool_calls=tool_calls, needs_attention=True)
    repo.add_row(conversation_id=cid, role="human", content="h", read=True)
    messages = client.get(f"/api/conversations/{cid}").json()["messages"]
    assert [m["role"] for m in messages] == ["visitor", "avatar", "human"]
    assert messages[1]["tool_calls"] == tool_calls
    assert "needs_attention" not in messages[1] and "read" not in messages[2]


def test_fetch_is_read_only(client, repo):
    cid = str(uuid.uuid4())
    repo.add_row(conversation_id=cid, role="visitor", content="v")
    before = [dict(r) for r in repo.rows]
    for _ in range(3):
        client.get(f"/api/conversations/{cid}")
    assert repo.rows == before
    assert repo.calls == ["get_conversation"] * 3


def test_fetch_other_conversation_ids_do_not_leak(client, repo):
    mine, theirs = str(uuid.uuid4()), str(uuid.uuid4())
    repo.add_row(conversation_id=theirs, role="visitor", content="private to them", conversation_name="TEST Them")
    body = client.get(f"/api/conversations/{mine}").json()
    assert body["messages"] == [] and body["conversation_name"] is None


def test_database_errors_become_generic_500s(app, repo, monkeypatch):
    async def boom(*args, **kwargs):
        raise ConnectionError("postgres://user:secret@db.internal refused")

    monkeypatch.setattr(repo, "get_conversation", boom)
    with TestClient(app, raise_server_exceptions=False) as client:  # see what a browser would get
        response = client.get(f"/api/conversations/{uuid.uuid4()}")
    assert response.status_code == 500
    assert response.json() == {"detail": "Something went wrong. Please try again."}
    assert "secret" not in response.text


def test_chat_payload_types_are_strict(client, repo, fake_stream):
    cid = str(uuid.uuid4())
    for payload in ({"conversation_id": cid, "message": 123}, {"conversation_id": cid, "message": ["hi"]},
                    {"conversation_id": cid, "message": "hi", "name": 5}):
        assert client.post("/api/chat", json=payload).status_code == 422, payload
    assert client.post("/api/chat", content=b"not json", headers={"content-type": "application/json"}).status_code == 422
    assert repo.rows == [] and fake_stream.calls == []
