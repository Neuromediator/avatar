"""Runtime configuration, read from environment variables.

The repo-root ``.env`` is loaded with ``override=False`` so that real environment
variables always win (e.g. ``MODEL=openai/gpt-5.4-nano uv run ...`` beats the value
in ``.env``). Nothing owner-specific is hardcoded here: the owner's name comes from
``OWNER_NAME``.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

logger = logging.getLogger("avatar.config")

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL = "openai/gpt-5.4-nano"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
_TRUTHY = {"1", "true", "yes", "on"}


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip()


@dataclass(frozen=True)
class Settings:
    openrouter_api_key: str = ""
    model: str = DEFAULT_MODEL
    owner_name: str = "Owner"
    admin_password: str = ""
    pushover_user: str = ""
    pushover_token: str = ""
    supabase_url: str = ""
    supabase_key: str = ""
    session_secret: str = ""
    cookie_secure: bool = False
    knowledge_dir: Path = REPO_ROOT / "knowledge"
    static_dir: Path = REPO_ROOT / "frontend" / "dist"

    @property
    def owner_first_name(self) -> str:
        parts = self.owner_name.split()
        return parts[0] if parts else self.owner_name

    @property
    def effective_session_secret(self) -> str:
        """SESSION_SECRET, or the documented fallback derived from ADMIN_PASSWORD."""
        return self.session_secret or f"avatar::{self.admin_password}"


def load_settings(env_file: Path | None = REPO_ROOT / ".env") -> Settings:
    """Build Settings from the environment (after loading ``.env`` without overriding)."""
    if env_file is not None and env_file.exists():
        load_dotenv(env_file, override=False)

    owner_name = _env("OWNER_NAME")
    if not owner_name:
        logger.warning("OWNER_NAME is not set; using a neutral placeholder name.")
        owner_name = "Owner"

    admin_password = _env("ADMIN_PASSWORD")
    return Settings(
        openrouter_api_key=_env("OPENROUTER_API_KEY"),
        model=_env("MODEL") or DEFAULT_MODEL,
        owner_name=owner_name,
        admin_password=admin_password,
        pushover_user=_env("PUSHOVER_USER"),
        pushover_token=_env("PUSHOVER_TOKEN"),
        supabase_url=_env("SUPABASE_URL"),
        supabase_key=_env("SUPABASE_KEY"),
        session_secret=_env("SESSION_SECRET"),
        cookie_secure=_env("COOKIE_SECURE").lower() in _TRUTHY,
        knowledge_dir=Path(_env("KNOWLEDGE_DIR") or REPO_ROOT / "knowledge"),
        static_dir=Path(_env("STATIC_DIR") or REPO_ROOT / "frontend" / "dist"),
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings, loaded once."""
    return load_settings()
