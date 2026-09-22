"""Admin authentication and authorization: every admin route is guarded."""

from __future__ import annotations

import time
import uuid

import pytest
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner, URLSafeTimedSerializer

from app import auth
from app.auth import (
    COOKIE_NAME,
    MAX_AGE_SECONDS,
    SALT,
    make_session_token,
    revoke_session_token,
    verify_session_token,
)
from app.main import create_app
from app.ratelimit import LOGIN_RATE_LIMIT_DETAIL, LoginRateLimiter

from .conftest import TEST_PASSWORD, TEST_SECRET, make_settings

CID = str(uuid.uuid4())

ADMIN_ROUTES = [
    ("GET", "/admin/api/session", None),
    ("GET", "/admin/api/conversations", None),
    ("GET", f"/admin/api/conversations/{CID}", None),
    ("POST", f"/admin/api/conversations/{CID}/messages", {"content": "hello from the owner"}),
    ("POST", f"/admin/api/conversations/{CID}/resolve", None),
]


def call(client: TestClient, method: str, path: str, body):
    return client.request(method, path, json=body) if body is not None else client.request(method, path)


def seed(repo) -> None:
    repo.add_row(conversation_id=CID, role="visitor", content="hi", conversation_name="Jo")
    repo.add_row(conversation_id=CID, role="avatar", content="hello", needs_attention=True)


def expired_token(secret: str) -> str:
    # Well-formed in every other way (admin + jti), so only the age can reject it.
    original = TimestampSigner.get_timestamp
    try:
        TimestampSigner.get_timestamp = lambda self: int(time.time()) - MAX_AGE_SECONDS - 60  # type: ignore[method-assign]
        return URLSafeTimedSerializer(secret, salt=SALT).dumps({"admin": True, "jti": "expired-jti"})
    finally:
        TimestampSigner.get_timestamp = original  # type: ignore[method-assign]


# ---------------------------------------------------------------------------
# 401 without a valid session
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
def test_admin_routes_reject_missing_cookie(client, repo, method, path, body):
    seed(repo)
    response = call(client, method, path, body)
    assert response.status_code == 401
    assert response.json() == {"detail": "Not authenticated"}


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
def test_admin_routes_reject_tampered_cookie(client, settings, repo, method, path, body):
    seed(repo)
    token = make_session_token(settings)
    tampered = token[:-3] + ("AAA" if not token.endswith("AAA") else "BBB")
    client.cookies.set(COOKIE_NAME, tampered)
    assert call(client, method, path, body).status_code == 401


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
def test_admin_routes_reject_forged_payload(client, repo, method, path, body):
    seed(repo)
    client.cookies.set(COOKIE_NAME, "eyJhZG1pbiI6dHJ1ZX0.fake.signature")
    assert call(client, method, path, body).status_code == 401


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
def test_admin_routes_reject_cookie_signed_with_other_secret(client, repo, method, path, body):
    seed(repo)
    other = URLSafeTimedSerializer("some-other-secret", salt=SALT).dumps({"admin": True, "jti": "foreign-jti"})
    client.cookies.set(COOKIE_NAME, other)
    assert call(client, method, path, body).status_code == 401


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
def test_admin_routes_reject_cookie_with_other_salt(client, repo, method, path, body):
    seed(repo)
    other = URLSafeTimedSerializer(TEST_SECRET, salt="not-the-salt").dumps({"admin": True, "jti": "salt-jti"})
    client.cookies.set(COOKIE_NAME, other)
    assert call(client, method, path, body).status_code == 401


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
def test_admin_routes_reject_expired_cookie(client, repo, method, path, body):
    seed(repo)
    client.cookies.set(COOKIE_NAME, expired_token(TEST_SECRET))
    assert call(client, method, path, body).status_code == 401


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
def test_admin_routes_reject_non_admin_payload(client, repo, method, path, body):
    seed(repo)
    token = URLSafeTimedSerializer(TEST_SECRET, salt=SALT).dumps({"admin": False, "jti": "not-admin-jti"})
    client.cookies.set(COOKIE_NAME, token)
    assert call(client, method, path, body).status_code == 401


def test_unauthenticated_requests_do_not_touch_the_database(client, repo):
    seed(repo)
    before = list(repo.calls)
    for method, path, body in ADMIN_ROUTES:
        call(client, method, path, body)
    assert repo.calls == before
    assert all(r["role"] != "human" for r in repo.rows)
    assert any(r["needs_attention"] for r in repo.rows)


# ---------------------------------------------------------------------------
# Success with a valid session
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
def test_admin_routes_accept_valid_login_cookie(admin_client, repo, method, path, body):
    seed(repo)
    response = call(admin_client, method, path, body)
    expected = 201 if path.endswith("/messages") else 200
    assert response.status_code == expected, response.text


def test_token_that_is_six_days_old_is_still_valid(client, repo):
    seed(repo)
    original = TimestampSigner.get_timestamp
    try:
        TimestampSigner.get_timestamp = lambda self: int(time.time()) - 6 * 24 * 3600  # type: ignore[method-assign]
        token = URLSafeTimedSerializer(TEST_SECRET, salt=SALT).dumps({"admin": True, "jti": "x"})
    finally:
        TimestampSigner.get_timestamp = original  # type: ignore[method-assign]
    client.cookies.set(COOKIE_NAME, token)
    assert client.get("/admin/api/session").status_code == 200


def test_session_endpoint_reports_owner(admin_client, settings):
    assert admin_client.get("/admin/api/session").json() == {
        "authenticated": True,
        "owner_name": settings.owner_name,
    }


# ---------------------------------------------------------------------------
# Login / logout
# ---------------------------------------------------------------------------


def test_login_with_correct_password_sets_cookie(client):
    response = client.post("/admin/login", json={"password": TEST_PASSWORD})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    set_cookie = response.headers["set-cookie"]
    assert set_cookie.startswith(f"{COOKIE_NAME}=")
    lowered = set_cookie.lower()
    assert "httponly" in lowered
    assert "samesite=lax" in lowered
    assert "path=/" in lowered
    assert f"max-age={MAX_AGE_SECONDS}" in lowered
    assert "secure" not in lowered.replace("samesite", "")
    token = client.cookies.get(COOKIE_NAME)
    assert token and verify_session_token(token, make_settings())


@pytest.mark.parametrize(
    "body",
    [{"password": "wrong"}, {"password": ""}, {}, {"password": TEST_PASSWORD.upper()}, {"password": TEST_PASSWORD + " "}],
)
def test_login_with_wrong_or_missing_password_is_401(client, body):
    response = client.post("/admin/login", json=body)
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid password"}
    assert "set-cookie" not in response.headers
    assert client.get("/admin/api/session").status_code == 401


def test_login_with_no_body_is_401(client):
    response = client.post("/admin/login")
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid password"}


@pytest.mark.parametrize("password", ["", "anything"])
def test_empty_admin_password_always_rejects(tmp_path, repo, fake_stream, password):
    app = create_app(make_settings(tmp_path, admin_password=""), repository=repo)
    with TestClient(app) as client:
        response = client.post("/admin/login", json={"password": password})
        assert response.status_code == 401
        # Even a token signed with the derived secret is rejected when no password is configured.
        client.cookies.set(COOKIE_NAME, URLSafeTimedSerializer(TEST_SECRET, salt=SALT).dumps({"admin": True}))
        assert client.get("/admin/api/session").status_code == 401


def test_cookie_secure_flag_when_configured(tmp_path, repo, fake_stream):
    app = create_app(make_settings(tmp_path, cookie_secure=True), repository=repo)
    with TestClient(app) as client:
        response = client.post("/admin/login", json={"password": TEST_PASSWORD})
        assert response.status_code == 200
        lowered = response.headers["set-cookie"].lower()
        assert "; secure" in lowered
        assert "httponly" in lowered and "samesite=lax" in lowered


def test_logout_clears_cookie(admin_client):
    assert admin_client.get("/admin/api/session").status_code == 200
    response = admin_client.post("/admin/logout")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    set_cookie = response.headers["set-cookie"].lower()
    assert set_cookie.startswith(f"{COOKIE_NAME}=")
    assert "max-age=0" in set_cookie
    assert admin_client.cookies.get(COOKIE_NAME) is None
    assert admin_client.get("/admin/api/session").status_code == 401


def test_logout_without_session_is_ok(client):
    assert client.post("/admin/logout").json() == {"ok": True}


def test_session_secret_defaults_to_admin_password_derivation(tmp_path, repo, fake_stream):
    settings = make_settings(tmp_path, session_secret="")
    assert settings.effective_session_secret == f"avatar::{TEST_PASSWORD}"
    app = create_app(settings, repository=repo)
    with TestClient(app) as client:
        client.post("/admin/login", json={"password": TEST_PASSWORD})
        token = client.cookies.get(COOKIE_NAME)
        payload = URLSafeTimedSerializer(f"avatar::{TEST_PASSWORD}", salt=SALT).loads(token)
        assert payload["admin"] is True
        assert isinstance(payload["jti"], str) and payload["jti"]
        assert client.get("/admin/api/session").status_code == 200


# ---------------------------------------------------------------------------
# Public routes cannot reach admin data
# ---------------------------------------------------------------------------


def test_public_fetch_does_not_mark_read_or_leak_flags(client, repo):
    seed(repo)
    body = client.get(f"/api/conversations/{CID}").json()
    for message in body["messages"]:
        assert set(message) == {"id", "role", "content", "created_at", "tool_calls"}
    assert all(not r["read"] for r in repo.rows)
    assert any(r["needs_attention"] for r in repo.rows)


def test_no_public_listing_of_conversations(client, repo):
    seed(repo)
    assert client.get("/api/conversations").status_code in (404, 405)
    assert client.get("/api/conversations/").status_code in (404, 405, 307)


def test_admin_cookie_is_not_accepted_as_query_or_header(client, settings, repo):
    seed(repo)
    token = make_session_token(settings)
    assert client.get(f"/admin/api/conversations?avatar_admin={token}").status_code == 401
    assert client.get("/admin/api/conversations", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_legacy_token_without_jti_is_rejected(client, repo):
    """Tokens without a jti cannot be revoked, so they are not accepted."""
    seed(repo)
    client.cookies.set(COOKIE_NAME, URLSafeTimedSerializer(TEST_SECRET, salt=SALT).dumps({"admin": True}))
    assert client.get("/admin/api/session").status_code == 401
    client.cookies.set(COOKIE_NAME, URLSafeTimedSerializer(TEST_SECRET, salt=SALT).dumps({"admin": True, "jti": ""}))
    assert client.get("/admin/api/session").status_code == 401


# ---------------------------------------------------------------------------
# Logout revokes the session token
# ---------------------------------------------------------------------------


def test_token_replayed_after_logout_is_rejected(admin_client):
    token = admin_client.cookies.get(COOKIE_NAME)
    assert token
    assert admin_client.get("/admin/api/session").status_code == 200
    assert admin_client.post("/admin/logout").status_code == 200
    assert admin_client.cookies.get(COOKIE_NAME) is None
    # Replaying the captured cookie no longer works.
    admin_client.cookies.set(COOKIE_NAME, token)
    assert admin_client.get("/admin/api/session").status_code == 401
    assert admin_client.get("/admin/api/conversations").status_code == 401


def test_replay_from_another_client_after_logout_is_rejected(app, admin_client):
    token = admin_client.cookies.get(COOKIE_NAME)
    admin_client.post("/admin/logout")
    with TestClient(app) as other:
        other.cookies.set(COOKIE_NAME, token)
        assert other.get("/admin/api/session").status_code == 401


def test_logout_revokes_only_that_session(app):
    with TestClient(app) as first, TestClient(app) as second:
        assert first.post("/admin/login", json={"password": TEST_PASSWORD}).status_code == 200
        assert second.post("/admin/login", json={"password": TEST_PASSWORD}).status_code == 200
        assert first.cookies.get(COOKIE_NAME) != second.cookies.get(COOKIE_NAME)
        first.post("/admin/logout")
        assert first.get("/admin/api/session").status_code == 401
        assert second.get("/admin/api/session").status_code == 200


def test_logout_with_invalid_cookie_is_ok(client):
    client.cookies.set(COOKIE_NAME, "not-a-token")
    response = client.post("/admin/logout")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_revocation_entries_are_pruned(settings, monkeypatch):
    monkeypatch.setattr(auth, "_revoked_jtis", {"stale": time.time() - 1, "live": time.time() + 3600})
    token = make_session_token(settings)
    revoke_session_token(token, settings)
    assert "stale" not in auth._revoked_jtis
    assert "live" in auth._revoked_jtis
    jti = URLSafeTimedSerializer(TEST_SECRET, salt=SALT).loads(token)["jti"]
    assert auth._revoked_jtis[jti] == pytest.approx(time.time() + MAX_AGE_SECONDS, abs=5)
    assert not verify_session_token(token, settings)
    # Pruning also happens when there is no token to revoke.
    auth._revoked_jtis["stale2"] = time.time() - 1
    revoke_session_token(None, settings)
    assert "stale2" not in auth._revoked_jtis


# ---------------------------------------------------------------------------
# Brute-force protection on /admin/login
# ---------------------------------------------------------------------------


def test_login_is_throttled_after_ten_failures(client):
    for i in range(10):
        response = client.post("/admin/login", json={"password": f"wrong-{i}"})
        assert response.status_code == 401, i
    response = client.post("/admin/login", json={"password": "wrong-again"})
    assert response.status_code == 429
    assert response.json() == {"detail": LOGIN_RATE_LIMIT_DETAIL}
    assert int(response.headers["retry-after"]) >= 1
    assert "set-cookie" not in response.headers


def test_locked_out_client_cannot_log_in_even_with_the_right_password(client):
    for _ in range(10):
        client.post("/admin/login", json={"password": "wrong"})
    response = client.post("/admin/login", json={"password": TEST_PASSWORD})
    assert response.status_code == 429
    assert "set-cookie" not in response.headers
    assert client.get("/admin/api/session").status_code == 401


def test_successful_logins_are_not_counted(client):
    for _ in range(20):
        assert client.post("/admin/login", json={"password": TEST_PASSWORD}).status_code == 200
    for _ in range(9):
        assert client.post("/admin/login", json={"password": "wrong"}).status_code == 401
    assert client.post("/admin/login", json={"password": TEST_PASSWORD}).status_code == 200


def test_login_throttle_is_per_fly_client_ip(client, monkeypatch):
    monkeypatch.setenv("FLY_APP_NAME", "x")
    attacker = {"Fly-Client-IP": "1.1.1.1"}
    for i in range(10):
        headers = {**attacker, "X-Forwarded-For": f"10.0.0.{i}"}
        assert client.post("/admin/login", json={"password": "wrong"}, headers=headers).status_code == 401
    # Rotating X-Forwarded-For does not get the attacker past the limit.
    spoofed = {**attacker, "X-Forwarded-For": "9.9.9.9"}
    assert client.post("/admin/login", json={"password": "wrong"}, headers=spoofed).status_code == 429
    # Another client is unaffected.
    owner = {"Fly-Client-IP": "2.2.2.2"}
    assert client.post("/admin/login", json={"password": TEST_PASSWORD}, headers=owner).status_code == 200


def test_fly_client_ip_is_ignored_off_fly(client, monkeypatch):
    monkeypatch.delenv("FLY_APP_NAME", raising=False)
    for i in range(10):
        client.post("/admin/login", json={"password": "wrong"}, headers={"Fly-Client-IP": f"1.1.1.{i}"})
    response = client.post("/admin/login", json={"password": "wrong"}, headers={"Fly-Client-IP": "3.3.3.3"})
    assert response.status_code == 429


def test_login_limiter_unit():
    limiter = LoginRateLimiter()
    assert limiter.allowed("a")
    for _ in range(10):
        limiter.record_failure("a")
    assert not limiter.allowed("a")
    assert limiter.allowed("b")
    assert 1 <= limiter.retry_after("a") <= 60
    assert limiter.retry_after("b") == 1
    limiter.reset()
    assert limiter.allowed("a")


def test_login_limiter_default_windows():
    assert [str(i) for i in LoginRateLimiter().items] == ["10 per 1 minute", "50 per 1 hour"]


def test_login_limiter_hourly_window_drives_retry_after():
    limiter = LoginRateLimiter("100/minute;3/hour")
    for _ in range(3):
        assert limiter.allowed("a")
        limiter.record_failure("a")
    assert not limiter.allowed("a")  # the per-minute budget is fine; the hourly one is spent
    assert 60 < limiter.retry_after("a") <= 3600


# ---------------------------------------------------------------------------
# Coverage guarantees for the admin guard
# ---------------------------------------------------------------------------


def _admin_api_routes(app) -> set[tuple[str, str]]:
    from fastapi.routing import APIRoute

    found = set()
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path.startswith("/admin/api"):
            for method in route.methods:
                found.add((method, route.path))
    return found


def test_admin_route_inventory_is_fully_covered(app):
    """Every /admin/api route the app defines is in ADMIN_ROUTES, so the 401 tests cover it."""
    listed = {(method, path.replace(CID, "{conversation_id}")) for method, path, _ in ADMIN_ROUTES}
    assert _admin_api_routes(app) == listed


def test_every_admin_api_route_depends_on_require_admin(app):
    from fastapi.routing import APIRoute

    from app.auth import require_admin

    routes = [r for r in app.routes if isinstance(r, APIRoute) and r.path.startswith("/admin/api")]
    assert routes
    for route in routes:
        calls = {dep.call for dep in route.dependant.dependencies}
        assert require_admin in calls, route.path


def test_known_token_forms_are_accepted_only_when_well_formed(settings):
    """Sanity check for the forged-token tests: the same payload signed properly is valid."""
    good = URLSafeTimedSerializer(TEST_SECRET, salt=SALT).dumps({"admin": True, "jti": "some-jti"})
    assert verify_session_token(good, settings)
    assert not verify_session_token(expired_token(TEST_SECRET), settings)


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
def test_admin_routes_reject_token_revoked_by_logout(app, repo, method, path, body):
    seed(repo)
    with TestClient(app) as owner:
        assert owner.post("/admin/login", json={"password": TEST_PASSWORD}).status_code == 200
        token = owner.cookies.get(COOKIE_NAME)
        assert owner.post("/admin/logout").status_code == 200
    with TestClient(app) as attacker:
        attacker.cookies.set(COOKIE_NAME, token)
        before = list(repo.calls)
        response = call(attacker, method, path, body)
        assert response.status_code == 401
        assert repo.calls == before  # rejected before any database access


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
@pytest.mark.parametrize("bogus", ["", "null", "a.b.c", "x" * 4000])
def test_admin_routes_reject_garbage_cookie_values(client, repo, method, path, body, bogus):
    seed(repo)
    client.cookies.set(COOKIE_NAME, bogus)
    assert call(client, method, path, body).status_code == 401


@pytest.mark.parametrize("method", ["PUT", "PATCH", "DELETE"])
@pytest.mark.parametrize("path", ["/admin/api/conversations", f"/admin/api/conversations/{CID}"])
def test_undefined_methods_on_admin_paths_never_succeed_even_when_logged_in(admin_client, repo, method, path):
    seed(repo)
    before = [dict(r) for r in repo.rows]
    response = admin_client.request(method, path)
    assert response.status_code in (401, 404, 405)
    assert repo.rows == before  # nothing deleted or changed


def test_unknown_admin_api_path_is_not_served(client, admin_client):
    assert admin_client.get("/admin/api/does-not-exist").status_code == 404


def test_logout_cookie_deletion_flags(client):
    client.post("/admin/login", json={"password": TEST_PASSWORD})
    set_cookie = client.post("/admin/logout").headers["set-cookie"].lower()
    assert "httponly" in set_cookie and "samesite=lax" in set_cookie and "path=/" in set_cookie
    assert "secure" not in set_cookie.replace("samesite", "")


def test_logout_cookie_deletion_is_secure_when_configured(tmp_path, repo, fake_stream):
    app = create_app(make_settings(tmp_path, cookie_secure=True), repository=repo)
    with TestClient(app) as client:
        assert "; secure" in client.post("/admin/logout").headers["set-cookie"].lower()


def test_password_check_is_constant_time(settings, monkeypatch):
    import hmac

    from app.auth import check_password

    seen = []
    real = hmac.compare_digest

    def spy(a, b):
        seen.append((a, b))
        return real(a, b)

    monkeypatch.setattr(auth.hmac, "compare_digest", spy)
    assert check_password(TEST_PASSWORD, settings) is True
    assert check_password("nope", settings) is False
    assert len(seen) == 2
    assert check_password(None, settings) is False and check_password(123, settings) is False  # type: ignore[arg-type]


def test_session_cookie_value_is_a_signed_token_not_the_password(client):
    client.post("/admin/login", json={"password": TEST_PASSWORD})
    token = client.cookies.get(COOKIE_NAME)
    assert TEST_PASSWORD not in token and TEST_SECRET not in token
    payload = URLSafeTimedSerializer(TEST_SECRET, salt=SALT).loads(token)
    assert set(payload) == {"admin", "jti"}


def test_admin_cookie_does_not_change_public_fetch(admin_client, repo):
    """Being logged in gives the public endpoint no extra data and no side effects."""
    seed(repo)
    body = admin_client.get(f"/api/conversations/{CID}").json()
    for message in body["messages"]:
        assert set(message) == {"id", "role", "content", "created_at", "tool_calls"}
    assert all(not r["read"] for r in repo.rows)
    assert any(r["needs_attention"] for r in repo.rows)


def test_successful_login_does_not_reset_failure_count(client):
    for _ in range(5):
        client.post("/admin/login", json={"password": "wrong"})
    assert client.post("/admin/login", json={"password": TEST_PASSWORD}).status_code == 200
    for _ in range(5):
        assert client.post("/admin/login", json={"password": "wrong"}).status_code == 401
    assert client.post("/admin/login", json={"password": "wrong"}).status_code == 429
