"""Admin authentication: password check and a signed, HttpOnly session cookie.

``POST /admin/login`` compares the password with ``ADMIN_PASSWORD`` in constant time
and sets ``avatar_admin`` = itsdangerous URLSafeTimedSerializer(SESSION_SECRET,
salt="avatar-admin").dumps({"admin": True, "jti": <random id>}). Every
``/admin/api/*`` route depends on ``require_admin``, which verifies the signature, the
7-day max age and that the token's ``jti`` has not been revoked.

``POST /admin/logout`` revokes the presented token's ``jti`` (kept in memory until the
token would have expired anyway), so a captured cookie stops working after logout.
The revocation list is per process, which fits the single always-on machine; tokens
without a ``jti`` (the old format, which cannot be revoked) are rejected.
"""

from __future__ import annotations

import hmac
import secrets
import time

from fastapi import HTTPException, Request, Response
from itsdangerous import BadSignature, URLSafeTimedSerializer

from .config import Settings

COOKIE_NAME = "avatar_admin"
SALT = "avatar-admin"
MAX_AGE_SECONDS = 7 * 24 * 60 * 60

# jti -> Unix time at which that (revoked) token expires anyway.
_revoked_jtis: dict[str, float] = {}


def _serializer(settings: Settings) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.effective_session_secret, salt=SALT)


def check_password(candidate: str | None, settings: Settings) -> bool:
    """Constant-time comparison; an empty/unset ADMIN_PASSWORD never matches."""
    if not settings.admin_password or not isinstance(candidate, str) or not candidate:
        return False
    # surrogatepass: a candidate with a lone surrogate simply does not match (no crash).
    return hmac.compare_digest(
        candidate.encode("utf-8", "surrogatepass"), settings.admin_password.encode("utf-8", "surrogatepass")
    )


def make_session_token(settings: Settings) -> str:
    return _serializer(settings).dumps({"admin": True, "jti": secrets.token_urlsafe(16)})


def verify_session_token(token: str | None, settings: Settings) -> bool:
    if not token or not settings.admin_password:
        return False
    try:
        data = _serializer(settings).loads(token, max_age=MAX_AGE_SECONDS)
    except BadSignature:  # includes SignatureExpired
        return False
    if not isinstance(data, dict) or data.get("admin") is not True:
        return False
    jti = data.get("jti")
    return isinstance(jti, str) and bool(jti) and jti not in _revoked_jtis


def revoke_session_token(token: str | None, settings: Settings) -> None:
    """Revoke a session token (logout). Invalid or missing tokens are ignored."""
    now = time.time()
    for jti, expires_at in list(_revoked_jtis.items()):
        if expires_at < now:
            del _revoked_jtis[jti]
    if not token:
        return
    try:
        data, signed_at = _serializer(settings).loads(token, max_age=MAX_AGE_SECONDS, return_timestamp=True)
    except BadSignature:  # includes SignatureExpired: nothing left to revoke
        return
    jti = data.get("jti") if isinstance(data, dict) else None
    if isinstance(jti, str) and jti:
        _revoked_jtis[jti] = signed_at.timestamp() + MAX_AGE_SECONDS


def set_session_cookie(response: Response, settings: Settings) -> None:
    response.set_cookie(
        COOKIE_NAME,
        make_session_token(settings),
        max_age=MAX_AGE_SECONDS,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        COOKIE_NAME,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )


def require_admin(request: Request) -> None:
    """FastAPI dependency guarding every admin API route."""
    settings: Settings = request.app.state.settings
    if not verify_session_token(request.cookies.get(COOKIE_NAME), settings):
        raise HTTPException(status_code=401, detail="Not authenticated")
