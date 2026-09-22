"""FastAPI application: public chat API (SSE), admin API, and the static frontend.

Run: ``cd backend && uv run uvicorn app.main:app --app-dir .``
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import agent as agent_module
from .agent import ChatContext
from .auth import (
    COOKIE_NAME,
    check_password,
    clear_session_cookie,
    require_admin,
    revoke_session_token,
    set_session_cookie,
)
from .config import Settings, get_settings
from .db import MessageRepository, conversation_name_from_rows, get_repository, summarize_conversations
from .knowledge import Knowledge, instant_answer, load_knowledge, parse_instant_request
from .prompts import build_task_prompt, push_delivered
from .ratelimit import LOGIN_RATE_LIMIT_DETAIL, RATE_LIMIT_DETAIL, ConversationRateLimiter, LoginRateLimiter

logger = logging.getLogger("avatar")

MAX_MESSAGE_CHARS = 20_000
TRUNCATION_NOTE = "\n\n[...message truncated as it's too long; ask the visitor to send something more concise]"
MAX_NAME_CHARS = 60
MAX_BIGINT = 2**63 - 1  # Postgres bigint: larger ids never reach PostgREST
# Request bodies are read whole before any handler runs, so cap them up front: enough
# for a 20,000-character message even fully JSON-escaped, plus big pastes that the
# clamp then truncates.
MAX_BODY_BYTES = 512 * 1024
BODY_TOO_LARGE_DETAIL = "That message is far too long to send. Please send something more concise."
MAX_TOOL_OUTPUT_CHARS = 2_000
CHAT_ERROR_DETAIL = "Sorry, something went wrong while I was writing my reply. Please try again in a moment."
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------


class ChatBody(BaseModel):
    conversation_id: UUID
    message: str  # no max_length: over-long messages are truncated, not rejected
    name: str | None = Field(default=None, max_length=1000)  # normalize_name trims to 60

    @field_validator("name", mode="before")
    @classmethod
    def _sanitize_name(cls, value: Any) -> Any:
        return sanitize_text(value) if isinstance(value, str) else value


class LoginBody(BaseModel):
    password: str | None = Field(default=None, max_length=1024)


class HumanMessageBody(BaseModel):
    content: str = Field(max_length=MAX_MESSAGE_CHARS)

    @field_validator("content", mode="before")
    @classmethod
    def _sanitize(cls, value: Any) -> Any:
        # Before the length check: a lone surrogate would otherwise fail it as invalid text.
        return sanitize_text(value) if isinstance(value, str) else value

    @field_validator("content")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Message must not be empty")
        return value


class AsciiJSONResponse(JSONResponse):
    """JSON with non-ASCII escaped, so echoing arbitrary input (even a lone UTF-16
    surrogate, which cannot be encoded as UTF-8) can never fail to render."""

    def render(self, content: Any) -> bytes:
        return json.dumps(content, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------


class BodySizeLimitMiddleware:
    """Reject request bodies over ``max_bytes`` with 413 before they are buffered.

    A declared Content-Length is checked up front; a chunked body is counted as it is
    received (FastAPI re-raises an HTTPException from the body reader as-is).
    """

    def __init__(self, app: Any, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        for key, value in scope["headers"]:
            if key == b"content-length":
                try:
                    too_big = int(value) > self.max_bytes
                except ValueError:
                    too_big = False
                if too_big:
                    response = JSONResponse({"detail": BODY_TOO_LARGE_DETAIL}, status_code=413)
                    await response(scope, receive, send)
                    return

        received = 0

        async def limited_receive() -> Any:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise HTTPException(status_code=413, detail=BODY_TOO_LARGE_DETAIL)
            return message

        await self.app(scope, limited_receive, send)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def public_message(row: dict[str, Any]) -> dict[str, Any]:
    """The visitor-facing shape of a row (never exposes read / needs_attention)."""
    return {
        "id": row["id"],
        "role": row["role"],
        "content": row["content"],
        "created_at": row["created_at"],
        "tool_calls": row.get("tool_calls"),
    }


def admin_message(row: dict[str, Any]) -> dict[str, Any]:
    return {
        **public_message(row),
        "needs_attention": bool(row.get("needs_attention")),
        "read": bool(row.get("read")),
    }


def sanitize_text(value: str) -> str:
    """Drop characters Postgres text cannot store: NUL and lone UTF-16 surrogates."""
    return value.replace("\x00", "").encode("utf-8", "ignore").decode("utf-8")


def clamp_message(message: str) -> str:
    """Abuse guard: truncate to 20,000 characters and append the note."""
    if len(message) > MAX_MESSAGE_CHARS:
        return message[:MAX_MESSAGE_CHARS] + TRUNCATION_NOTE
    return message


def normalize_name(name: str | None) -> str | None:
    if name is None:
        return None
    cleaned = " ".join(sanitize_text(str(name)).split())[:MAX_NAME_CHARS].strip()
    return cleaned or None


def sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def app_settings(request: Request) -> Settings:
    return request.app.state.settings


def login_client_key(request: Request) -> str:
    """The client identity used to throttle failed admin logins.

    uvicorn runs with ``--forwarded-allow-ips '*'``, which trusts the leftmost
    X-Forwarded-For entry, and a client controls that, so behind Fly
    ``request.client.host`` can be spoofed. Fly's edge sets ``Fly-Client-IP`` itself
    (clients cannot override it), so it is used when running on Fly.
    """
    if os.environ.get("FLY_APP_NAME"):
        fly_ip = request.headers.get("fly-client-ip", "").strip()
        if fly_ip:
            return fly_ip
    return request.client.host if request.client else "unknown"


# ---------------------------------------------------------------------------
# One chat turn (runs as a background task feeding the SSE stream)
# ---------------------------------------------------------------------------


async def run_chat_turn(
    state: Any,
    repo: MessageRepository,
    ctx: ChatContext,
    visitor_row: dict[str, Any],
    instant_number: int | None,
    queue: asyncio.Queue,
) -> None:
    """Produce the Avatar's reply, store it, and push SSE events onto ``queue``.

    Runs in its own task so that the reply is still generated and stored if the
    visitor disconnects mid-stream (they pick it up by polling or on reload).
    """
    conversation_id = ctx.conversation_id
    calls: dict[str, dict[str, Any]] = {}
    try:
        if instant_number is not None:
            content = instant_answer(state.knowledge, instant_number)
            await queue.put(("instant", {"faq": instant_number}))
            await queue.put(("delta", {"text": content}))
            row = await repo.insert_message(
                conversation_id,
                "avatar",
                content,
                tool_calls=[{"type": "instant", "faq": instant_number}],
            )
            await queue.put(("done", {"message": public_message(row)}))
            return

        rows = await repo.get_conversation(conversation_id)
        prompt = build_task_prompt(rows, visitor_row, state.settings, ctx.visitor_name)

        final_text = ""
        async for kind, data in agent_module.stream_agent_events(state.agent, prompt, ctx):
            if kind == "delta":
                if data.get("text"):
                    await queue.put(("delta", {"text": data["text"]}))
            elif kind == "tool_called":
                call_id = str(data.get("call_id") or f"call_{len(calls) + 1}")
                calls[call_id] = {
                    "type": "function",
                    "name": data.get("name") or "tool",
                    "arguments": data.get("arguments") or "{}",
                    "output": "",
                }
                await queue.put(
                    ("tool_called", {"call_id": call_id, "name": calls[call_id]["name"], "arguments": calls[call_id]["arguments"]})
                )
            elif kind == "tool_output":
                call_id = str(data.get("call_id") or "")
                entry = calls.get(call_id)
                name = data.get("name") or (entry["name"] if entry else "tool")
                output = str(data.get("output") or "")
                if entry is not None:
                    entry["output"] = output[:MAX_TOOL_OUTPUT_CHARS]
                payload: dict[str, Any] = {"call_id": call_id, "name": name}
                if name == "push_tool":  # did the phone notification actually go out?
                    payload["ok"] = push_delivered(output)
                await queue.put(("tool_output", payload))
            elif kind == "final":
                final_text = str(data.get("text") or "")

        final_text = final_text.strip()
        if not final_text:
            raise RuntimeError("The agent produced an empty reply")

        tool_calls = list(calls.values()) or None
        needs_attention = ctx.pushed or any(c["name"] == "push_tool" for c in calls.values())
        row = await repo.insert_message(
            conversation_id,
            "avatar",
            final_text,
            tool_calls=tool_calls,
            needs_attention=needs_attention,
        )
        if ctx.tool_log:  # names only: tool arguments can contain visitor emails
            logger.info("Conversation %s used tools: %s", conversation_id, [t["name"] for t in ctx.tool_log])
        await queue.put(("done", {"message": public_message(row)}))
    except Exception:
        logger.exception("Chat turn failed for conversation %s", conversation_id)
        if ctx.pushed or any(c.get("name") == "push_tool" for c in calls.values()):
            # The owner's phone was already notified: keep the dashboard flag and a push
            # marker in the transcript so the thread shows "Needs you" and is not re-pushed.
            try:
                row = await store_push_fallback(state, repo, conversation_id, calls)
                await queue.put(("done", {"message": public_message(row)}))
                return
            except Exception:
                logger.exception("Could not store the fallback reply for %s", conversation_id)
        await queue.put(("error", {"detail": CHAT_ERROR_DETAIL}))
    finally:
        await queue.put(None)


async def store_push_fallback(
    state: Any, repo: MessageRepository, conversation_id: str, calls: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    """Store a short Avatar reply flagged for the owner after a turn that pushed, then failed."""
    tool_calls = list(calls.values())
    if not any(c.get("name") == "push_tool" for c in tool_calls):
        tool_calls.append({"type": "function", "name": "push_tool", "arguments": "{}", "output": ""})
    first = state.settings.owner_first_name
    return await repo.insert_message(
        conversation_id,
        "avatar",
        f"Sorry, something went wrong while I was writing my reply, but I have passed your message on to "
        f"{first}, who will pick it up here.",
        tool_calls=tool_calls,
        needs_attention=True,
    )


async def event_stream(visitor_row: dict[str, Any], queue: asyncio.Queue) -> AsyncIterator[str]:
    yield sse("start", {"visitor_message": public_message(visitor_row)})
    while True:
        item = await queue.get()
        if item is None:
            return
        event, data = item
        yield sse(event, data)


# ---------------------------------------------------------------------------
# Static pages
# ---------------------------------------------------------------------------


def render_page(settings: Settings, filename: str) -> Response:
    path = settings.static_dir / filename
    if not path.is_file():
        return PlainTextResponse(
            "The frontend has not been built. Run `npm run build` in frontend/.", status_code=503
        )
    page = path.read_text(encoding="utf-8")
    page = page.replace("{{OWNER_NAME}}", html.escape(settings.owner_name, quote=True))
    page = page.replace("{{OWNER_FIRST_NAME}}", html.escape(settings.owner_first_name, quote=True))
    return HTMLResponse(page, headers={"Cache-Control": "no-cache"})


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def create_app(
    settings: Settings | None = None,
    *,
    repository: MessageRepository | None = None,
    knowledge: Knowledge | None = None,
    agent: Any | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # per-request URL logs are noise

    knowledge = knowledge or load_knowledge(settings.knowledge_dir)
    agent = agent or agent_module.build_agent(settings, knowledge)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        pending = [task for task in app.state.chat_tasks if not task.done()]
        if pending:  # let in-flight replies finish and be stored before shutdown
            await asyncio.wait(pending, timeout=60)

    app = FastAPI(title="Avatar", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=MAX_BODY_BYTES)
    app.state.settings = settings
    app.state.knowledge = knowledge
    app.state.agent = agent
    app.state.repository = repository
    app.state.rate_limiter = ConversationRateLimiter()
    app.state.login_limiter = LoginRateLimiter()
    app.state.chat_tasks = set()

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # FastAPI's default body, rendered so that echoed input cannot crash it.
        return AsciiJSONResponse({"detail": jsonable_encoder(exc.errors())}, status_code=422)

    @app.exception_handler(Exception)
    async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse({"detail": "Something went wrong. Please try again."}, status_code=500)

    # -- public API ----------------------------------------------------------

    @app.api_route("/api/config", methods=["GET", "HEAD"])
    async def public_config(settings: Settings = Depends(app_settings)) -> dict[str, str]:
        return {"owner_name": settings.owner_name, "owner_first_name": settings.owner_first_name}

    @app.api_route("/api/conversations/{conversation_id}", methods=["GET", "HEAD"])
    async def get_public_conversation(
        conversation_id: UUID,
        after_id: int | None = Query(default=None, ge=0, le=MAX_BIGINT),
        repo: MessageRepository = Depends(get_repository),
    ) -> dict[str, Any]:
        rows = await repo.get_conversation(str(conversation_id), after_id)
        return {
            "conversation_id": str(conversation_id),
            "conversation_name": conversation_name_from_rows(rows),
            "messages": [public_message(r) for r in rows],
        }

    @app.post("/api/chat")
    async def chat(body: ChatBody, request: Request, repo: MessageRepository = Depends(get_repository)) -> Response:
        state = request.app.state
        conversation_id = str(body.conversation_id)

        # 1. Rate limit first: no DB write and no LLM call when over the limit.
        limiter: ConversationRateLimiter = state.rate_limiter
        if not limiter.hit(conversation_id):
            return JSONResponse(
                {"detail": RATE_LIMIT_DETAIL},
                status_code=429,
                headers={"Retry-After": str(limiter.retry_after(conversation_id))},
            )

        # 2. Validation, 3. clamp (after dropping what Postgres text cannot store).
        message = sanitize_text(body.message).strip()
        if not message:
            raise HTTPException(status_code=422, detail="Please type a message before sending.")
        message = clamp_message(message)
        name = normalize_name(body.name)

        # 4. Store the visitor's message.
        try:
            visitor_row = await repo.insert_message(conversation_id, "visitor", message, conversation_name=name)
        except Exception as exc:
            logger.exception("Could not store the visitor message for %s", conversation_id)
            raise HTTPException(
                status_code=503, detail="Sorry, I couldn't save your message. Please try again in a moment."
            ) from exc

        # 5. Stream the reply; the turn runs in its own task (survives disconnects).
        ctx = ChatContext(
            conversation_id=conversation_id,
            visitor_name=name,
            settings=state.settings,
            knowledge=state.knowledge,
        )
        queue: asyncio.Queue = asyncio.Queue()
        task = asyncio.create_task(
            run_chat_turn(state, repo, ctx, visitor_row, parse_instant_request(message), queue)
        )
        state.chat_tasks.add(task)
        task.add_done_callback(state.chat_tasks.discard)
        return StreamingResponse(
            event_stream(visitor_row, queue), media_type="text/event-stream", headers=SSE_HEADERS
        )

    # -- admin auth ----------------------------------------------------------

    @app.post("/admin/login")
    async def admin_login(
        request: Request,
        body: LoginBody | None = Body(default=None),
        settings: Settings = Depends(app_settings),
    ) -> JSONResponse:
        # Throttle failed attempts per client, checked before the password so a
        # locked-out client learns nothing. No await between the check and the
        # record, so concurrent requests cannot race past it.
        key = login_client_key(request)
        limiter: LoginRateLimiter = request.app.state.login_limiter
        if not limiter.allowed(key):
            return JSONResponse(
                {"detail": LOGIN_RATE_LIMIT_DETAIL},
                status_code=429,
                headers={"Retry-After": str(limiter.retry_after(key))},
            )
        if not check_password(body.password if body else None, settings):
            limiter.record_failure(key)
            return JSONResponse({"detail": "Invalid password"}, status_code=401)
        response = JSONResponse({"ok": True})
        set_session_cookie(response, settings)
        return response

    @app.post("/admin/logout")
    async def admin_logout(request: Request, settings: Settings = Depends(app_settings)) -> JSONResponse:
        revoke_session_token(request.cookies.get(COOKIE_NAME), settings)
        response = JSONResponse({"ok": True})
        clear_session_cookie(response, settings)
        return response

    # -- admin API (all routes require the session cookie) --------------------

    admin = APIRouter(prefix="/admin/api", dependencies=[Depends(require_admin)])

    @admin.get("/session")
    async def admin_session(settings: Settings = Depends(app_settings)) -> dict[str, Any]:
        return {"authenticated": True, "owner_name": settings.owner_name}

    @admin.get("/conversations")
    async def admin_conversations(repo: MessageRepository = Depends(get_repository)) -> dict[str, Any]:
        rows = await repo.list_inbox_rows()
        return {"conversations": summarize_conversations(rows)}

    @admin.get("/conversations/{conversation_id}")
    async def admin_open_conversation(
        conversation_id: UUID, repo: MessageRepository = Depends(get_repository)
    ) -> dict[str, Any]:
        rows = await repo.open_conversation(str(conversation_id))
        if not rows:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return {
            "conversation_id": str(conversation_id),
            "conversation_name": conversation_name_from_rows(rows),
            "messages": [admin_message(r) for r in rows],
        }

    @admin.post("/conversations/{conversation_id}/messages", status_code=201)
    async def admin_post_message(
        conversation_id: UUID, body: HumanMessageBody, repo: MessageRepository = Depends(get_repository)
    ) -> dict[str, Any]:
        # The Avatar does not react to the human's message (no LLM call).
        row = await repo.insert_message(
            str(conversation_id), "human", body.content, read=True, needs_attention=False
        )
        return {"message": admin_message(row)}

    @admin.post("/conversations/{conversation_id}/resolve")
    async def admin_resolve(conversation_id: UUID, repo: MessageRepository = Depends(get_repository)) -> dict[str, bool]:
        await repo.resolve_conversation(str(conversation_id))
        return {"ok": True}

    app.include_router(admin)

    # -- static frontend (after all API routes) --------------------------------

    page_methods = ["GET", "HEAD"]  # HEAD too: uptime monitors and link unfurlers use it

    @app.api_route("/", methods=page_methods, include_in_schema=False)
    @app.api_route("/index.html", methods=page_methods, include_in_schema=False)
    async def visitor_page(settings: Settings = Depends(app_settings)) -> Response:
        return render_page(settings, "index.html")

    @app.api_route("/admin", methods=page_methods, include_in_schema=False)
    @app.api_route("/admin/", methods=page_methods, include_in_schema=False)
    @app.api_route("/admin.html", methods=page_methods, include_in_schema=False)
    async def admin_page(settings: Settings = Depends(app_settings)) -> Response:
        return render_page(settings, "admin.html")

    if settings.static_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.static_dir), name="static")
    else:
        logger.warning("Static directory %s not found; the UI will not be served.", settings.static_dir)

    return app


app = create_app()
