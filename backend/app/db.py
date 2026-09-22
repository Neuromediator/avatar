"""Data layer: the ``messages`` table in Supabase.

``SupabaseRepository`` wraps the synchronous supabase client; every call runs in a
worker thread (``asyncio.to_thread``) so the event loop is never blocked. Routes get
the repository through the ``get_repository`` FastAPI dependency, so tests can inject
an in-memory fake with the same async interface.

Reads are single round-trips:
* a conversation fetch is one ``select`` (optionally ``id > after_id``); only a
  conversation longer than Supabase's 1000-row response cap needs a further page;
* opening a thread in admin is one PostgREST ``update ... returning`` call that marks
  every row read, clears ``needs_attention`` and returns the updated rows;
* the admin inbox selects every row WITHOUT ``content`` (it only needs a 140-character
  preview per conversation). Previews are cached by row id - a row's content never
  changes - so a steady-state poll fetches no content at all, and only a conversation
  with a new latest visitor message costs one extra ``select id,content``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any, Protocol

from fastapi import HTTPException, Request

from .config import Settings

logger = logging.getLogger("avatar.db")

TABLE = "messages"
PAGE_SIZE = 1000  # Supabase caps a single response at 1000 rows
PREVIEW_CHARS = 140
PREVIEW_FETCH_CHUNK = 200  # ids per "in" filter, keeping the request URL short
INBOX_COLUMNS = "id,conversation_id,conversation_name,role,needs_attention,read,created_at"
# "JWT issued at future": with the sb_ API keys, Supabase's gateway mints a short-lived
# JWT per request, and slight clock skew makes PostgREST reject it now and then.
CLOCK_SKEW_CODE = "PGRST303"
CLOCK_SKEW_RETRY_DELAYS = (0.25, 0.75)  # seconds before each retry

Row = dict[str, Any]


def execute(query: Any) -> Any:
    """Run a PostgREST query, retrying the transient clock-skew rejection (PGRST303).

    The request is refused while its JWT is checked, before any SQL runs, so sending it
    again is safe for writes too. (postgrest-py itself only retries 503/520 on GET.)
    """
    from postgrest.exceptions import APIError

    for delay in (*CLOCK_SKEW_RETRY_DELAYS, None):
        try:
            return query.execute()
        except APIError as exc:
            if exc.code != CLOCK_SKEW_CODE or delay is None:
                raise
            logger.warning("Supabase rejected a request with %s (clock skew); retrying", exc.code)
            time.sleep(delay)


class MessageRepository(Protocol):
    async def insert_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        *,
        conversation_name: str | None = None,
        tool_calls: list[dict[str, Any]] | None = None,
        needs_attention: bool = False,
        read: bool = False,
    ) -> Row: ...

    async def get_conversation(self, conversation_id: str, after_id: int | None = None) -> list[Row]: ...

    async def list_inbox_rows(self) -> list[Row]: ...

    async def open_conversation(self, conversation_id: str) -> list[Row]: ...

    async def resolve_conversation(self, conversation_id: str) -> None: ...

    async def delete_conversation(self, conversation_id: str) -> None: ...


# ---------------------------------------------------------------------------
# Pure helpers (shared by the real repository, the fake one and the routes)
# ---------------------------------------------------------------------------


def parse_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def sort_key(row: Row) -> tuple[datetime, int]:
    return parse_timestamp(row.get("created_at")), int(row.get("id") or 0)


def sort_rows(rows: Iterable[Row]) -> list[Row]:
    return sorted(rows, key=sort_key)


def conversation_name_from_rows(rows: Iterable[Row]) -> str | None:
    """The latest non-null conversation_name among the rows."""
    name: str | None = None
    for row in sort_rows(rows):
        value = row.get("conversation_name")
        if value:
            name = value
    return name


def _preview_source(ordered: list[Row]) -> Row:
    """The row a conversation's inbox preview comes from: its latest visitor message,
    or its latest message of any role when it has none. ``ordered`` is sorted."""
    visitor_rows = [r for r in ordered if r.get("role") == "visitor"]
    return visitor_rows[-1] if visitor_rows else ordered[-1]


def _group_by_conversation(rows: Iterable[Row]) -> dict[str, list[Row]]:
    grouped: dict[str, list[Row]] = {}
    for row in rows:
        grouped.setdefault(str(row["conversation_id"]), []).append(row)
    return grouped


def preview_source_ids(rows: Iterable[Row]) -> dict[str, int]:
    """conversation_id -> id of the row its inbox preview comes from."""
    return {
        conversation_id: _preview_source(sort_rows(convo_rows))["id"]
        for conversation_id, convo_rows in _group_by_conversation(rows).items()
    }


def summarize_conversations(rows: Iterable[Row]) -> list[dict[str, Any]]:
    """Aggregate message rows into inbox summaries, most recent activity first."""
    summaries: list[dict[str, Any]] = []
    for conversation_id, convo_rows in _group_by_conversation(rows).items():
        ordered = sort_rows(convo_rows)
        first, last = ordered[0], ordered[-1]
        preview_source = _preview_source(ordered)
        summaries.append(
            {
                "conversation_id": conversation_id,
                "conversation_name": conversation_name_from_rows(ordered),
                "started_at": first.get("created_at"),
                "last_message_at": last.get("created_at"),
                "message_count": len(ordered),
                "unread_count": sum(1 for r in ordered if not r.get("read")),
                "needs_attention": any(bool(r.get("needs_attention")) for r in ordered),
                "preview": str(preview_source.get("content") or "")[:PREVIEW_CHARS],
                "last_role": last.get("role"),
            }
        )
    summaries.sort(key=lambda s: (parse_timestamp(s["last_message_at"]), s["conversation_id"]), reverse=True)
    return summaries


# ---------------------------------------------------------------------------
# Supabase implementation
# ---------------------------------------------------------------------------


class SupabaseRepository:
    def __init__(self, url: str, key: str) -> None:
        from supabase import create_client
        from supabase.lib.client_options import SyncClientOptions

        options = SyncClientOptions(
            auto_refresh_token=False,
            persist_session=False,
            postgrest_client_timeout=20,
        )
        self._client = create_client(url, key, options=options)
        self._previews: dict[int, str] = {}  # row id -> first PREVIEW_CHARS of its content

    def _table(self):
        return self._client.table(TABLE)

    # -- sync bodies, run in a worker thread ---------------------------------

    def _insert(self, record: Row) -> Row:
        result = execute(self._table().insert(record))
        return result.data[0]

    def _select_conversation(self, conversation_id: str, after_id: int | None) -> list[Row]:
        """One select; only a conversation longer than 1000 rows needs further pages."""
        rows: list[Row] = []
        start = 0
        while True:
            query = self._table().select("*").eq("conversation_id", conversation_id)
            if after_id is not None:
                query = query.gt("id", after_id)
            result = execute(query.order("created_at").order("id").range(start, start + PAGE_SIZE - 1))
            page = list(result.data or [])
            rows.extend(page)
            if len(page) < PAGE_SIZE:
                return rows
            start += PAGE_SIZE

    def _select_inbox(self) -> list[Row]:
        rows: list[Row] = []
        start = 0
        while True:
            result = execute(
                self._table().select(INBOX_COLUMNS).order("id").range(start, start + PAGE_SIZE - 1)
            )
            page = list(result.data or [])
            rows.extend(page)
            if len(page) < PAGE_SIZE:
                break
            start += PAGE_SIZE
        self._attach_previews(rows)
        return rows

    def _attach_previews(self, rows: list[Row]) -> None:
        """Give each conversation's preview-source row its (cached) truncated content."""
        wanted = set(preview_source_ids(rows).values())
        missing = sorted(wanted - self._previews.keys())
        for i in range(0, len(missing), PREVIEW_FETCH_CHUNK):
            chunk = missing[i : i + PREVIEW_FETCH_CHUNK]
            result = execute(self._table().select("id,content").in_("id", chunk))
            for fetched in result.data or []:
                self._previews[fetched["id"]] = str(fetched.get("content") or "")[:PREVIEW_CHARS]
        # Drop superseded rows and deleted conversations from the cache.
        self._previews = {row_id: text for row_id, text in self._previews.items() if row_id in wanted}
        for row in rows:
            if row.get("id") in wanted:
                row["content"] = self._previews.get(row["id"], "")

    def _open(self, conversation_id: str) -> list[Row]:
        result = execute(
            self._table().update({"read": True, "needs_attention": False}).eq("conversation_id", conversation_id)
        )
        return sort_rows(result.data or [])

    def _resolve(self, conversation_id: str) -> None:
        from postgrest import ReturnMethod

        execute(
            self._table()
            .update({"needs_attention": False}, returning=ReturnMethod.minimal)
            .eq("conversation_id", conversation_id)
        )

    def _delete(self, conversation_id: str) -> None:
        from postgrest import ReturnMethod

        execute(self._table().delete(returning=ReturnMethod.minimal).eq("conversation_id", conversation_id))

    # -- async interface -----------------------------------------------------

    async def insert_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        *,
        conversation_name: str | None = None,
        tool_calls: list[dict[str, Any]] | None = None,
        needs_attention: bool = False,
        read: bool = False,
    ) -> Row:
        record: Row = {
            "conversation_id": conversation_id,
            "conversation_name": conversation_name,
            "role": role,
            "content": content,
            "tool_calls": tool_calls,
            "needs_attention": needs_attention,
            "read": read,
        }
        return await asyncio.to_thread(self._insert, record)

    async def get_conversation(self, conversation_id: str, after_id: int | None = None) -> list[Row]:
        return await asyncio.to_thread(self._select_conversation, conversation_id, after_id)

    async def list_inbox_rows(self) -> list[Row]:
        return await asyncio.to_thread(self._select_inbox)

    async def open_conversation(self, conversation_id: str) -> list[Row]:
        return await asyncio.to_thread(self._open, conversation_id)

    async def resolve_conversation(self, conversation_id: str) -> None:
        await asyncio.to_thread(self._resolve, conversation_id)

    async def delete_conversation(self, conversation_id: str) -> None:
        await asyncio.to_thread(self._delete, conversation_id)


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------


def create_repository(settings: Settings) -> SupabaseRepository:
    if not settings.supabase_url or not settings.supabase_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_KEY must be set")
    return SupabaseRepository(settings.supabase_url, settings.supabase_key)


def get_repository(request: Request) -> MessageRepository:
    """The app's repository, created lazily on first use (so the app imports without it)."""
    state = request.app.state
    repository = getattr(state, "repository", None)
    if repository is None:
        try:
            repository = create_repository(state.settings)
        except Exception as exc:  # misconfiguration: surface as 503, keep the app alive
            logger.error("Database is not configured: %s", exc)
            raise HTTPException(status_code=503, detail="The database is not configured.") from exc
        state.repository = repository
    return repository
