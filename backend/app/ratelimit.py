"""In-memory rate limits (``limits`` package, moving window), held per process.

* Chat: 20 messages per minute per conversation. That is enough here: OpenRouter caps
  total spend, and a browser's requests stick to one machine.
* Admin login: failed sign-ins per client are capped (10 a minute, 50 an hour) so the
  admin password cannot be brute-forced. Successful logins are not counted, and there
  is deliberately no global cap (it would let anyone lock the owner out).
"""

from __future__ import annotations

import math
import time

from limits import parse, parse_many
from limits.storage import MemoryStorage
from limits.strategies import MovingWindowRateLimiter

CHAT_LIMIT = "20/minute"
RATE_LIMIT_DETAIL = "You're sending messages too quickly. Please wait a moment and try again."

LOGIN_LIMITS = "10/minute;50/hour"
LOGIN_RATE_LIMIT_DETAIL = "Too many sign-in attempts. Please wait a minute and try again."


class ConversationRateLimiter:
    def __init__(self, limit: str = CHAT_LIMIT) -> None:
        self.item = parse(limit)
        self.storage = MemoryStorage()
        self.limiter = MovingWindowRateLimiter(self.storage)

    def hit(self, conversation_id: str) -> bool:
        """Record one message; False when this conversation is over the limit."""
        return self.limiter.hit(self.item, "chat", conversation_id)

    def retry_after(self, conversation_id: str) -> int:
        """Seconds until the window frees a slot (at least 1)."""
        stats = self.limiter.get_window_stats(self.item, "chat", conversation_id)
        return max(1, math.ceil(stats.reset_time - time.time()))

    def reset(self) -> None:
        self.storage.reset()


class LoginRateLimiter:
    """Failed admin sign-ins per client key (the client IP)."""

    def __init__(self, limits: str = LOGIN_LIMITS) -> None:
        self.items = parse_many(limits)
        self.storage = MemoryStorage()
        self.limiter = MovingWindowRateLimiter(self.storage)

    def allowed(self, key: str) -> bool:
        """Whether this client may try a password now (checks only, records nothing)."""
        return all(self.limiter.test(item, "login", key) for item in self.items)

    def record_failure(self, key: str) -> None:
        for item in self.items:
            self.limiter.hit(item, "login", key)

    def retry_after(self, key: str) -> int:
        """Seconds until every exhausted window frees a slot (at least 1)."""
        waits = [1]
        for item in self.items:
            stats = self.limiter.get_window_stats(item, "login", key)
            if stats.remaining == 0:
                waits.append(math.ceil(stats.reset_time - time.time()))
        return max(waits)

    def reset(self) -> None:
        self.storage.reset()
