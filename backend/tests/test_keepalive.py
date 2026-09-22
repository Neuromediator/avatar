"""The database keep-alive loop that stops Supabase pausing the project for inactivity."""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app import main
from app.main import KEEPALIVE_FIRST_DELAY_SECONDS, KEEPALIVE_INTERVAL_SECONDS, keep_database_awake

from .conftest import FakeRepository


def fake_app(repository, settings=None):
    return SimpleNamespace(state=SimpleNamespace(repository=repository, settings=settings))


async def run_until(predicate, coro_factory, timeout=2.0):
    """Run the loop as a task until ``predicate()`` holds, then cancel it."""
    task = asyncio.create_task(coro_factory())
    try:
        async with asyncio.timeout(timeout):
            while not predicate():
                await asyncio.sleep(0.001)
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def test_schedule_is_sane():
    assert KEEPALIVE_FIRST_DELAY_SECONDS <= 5 * 60
    # Supabase pauses after about 7 days; ping far more often than that.
    assert KEEPALIVE_INTERVAL_SECONDS <= 24 * 60 * 60


def test_loop_pings_repeatedly():
    repo = FakeRepository()
    app = fake_app(repo)
    asyncio.run(run_until(lambda: repo.calls.count("ping") >= 3,
                          lambda: keep_database_awake(app, first_delay=0, interval=0)))
    assert set(repo.calls) == {"ping"}  # it only pings: no reads or writes of messages


def test_failed_ping_is_logged_and_the_loop_keeps_going(caplog):
    class FlakyRepository(FakeRepository):
        async def ping(self):
            self.calls.append("ping")
            if len(self.calls) == 1:
                raise RuntimeError("Supabase unreachable")

    repo = FlakyRepository()
    with caplog.at_level(logging.INFO, logger="avatar"):
        asyncio.run(run_until(lambda: len(repo.calls) >= 2,
                              lambda: keep_database_awake(fake_app(repo), first_delay=0, interval=0)))
    assert "keep-alive ping failed: Supabase unreachable" in caplog.text
    assert "keep-alive ping OK" in caplog.text


def test_loop_creates_the_repository_when_none_exists(monkeypatch):
    created = FakeRepository()
    monkeypatch.setattr(main, "create_repository", lambda settings: created)
    app = fake_app(None, settings=object())
    asyncio.run(run_until(lambda: "ping" in created.calls,
                          lambda: keep_database_awake(app, first_delay=0, interval=0)))
    assert app.state.repository is created


def test_app_lifespan_does_not_ping_immediately(app, repo):
    # The first ping waits KEEPALIVE_FIRST_DELAY_SECONDS, so a short app lifetime (like a
    # test) never touches the database, and shutdown cancels the loop cleanly.
    with TestClient(app) as client:
        assert client.get("/api/config").status_code == 200
    assert "ping" not in repo.calls
