"""Settings loading from the environment."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import DEFAULT_MODEL, REPO_ROOT, load_settings

ENV_VARS = [
    "OPENROUTER_API_KEY", "MODEL", "OWNER_NAME", "ADMIN_PASSWORD", "PUSHOVER_USER", "PUSHOVER_TOKEN",
    "SUPABASE_URL", "SUPABASE_KEY", "SESSION_SECRET", "COOKIE_SECURE", "KNOWLEDGE_DIR", "STATIC_DIR",
]


@pytest.fixture
def clean_env(monkeypatch):
    for name in ENV_VARS:
        # setenv first so monkeypatch records (and later restores) the original value,
        # even for variables that load_dotenv sets during a test.
        monkeypatch.setenv(name, "placeholder")
        monkeypatch.delenv(name)
    return monkeypatch


def test_defaults(clean_env):
    settings = load_settings(env_file=None)
    assert settings.model == DEFAULT_MODEL == "openai/gpt-5.4-nano"
    assert settings.cookie_secure is False
    assert settings.knowledge_dir == REPO_ROOT / "knowledge"
    assert settings.static_dir == REPO_ROOT / "frontend" / "dist"
    assert settings.effective_session_secret == "avatar::"


def test_values_from_environment(clean_env, tmp_path):
    clean_env.setenv("MODEL", "openai/gpt-5.6-luna")
    clean_env.setenv("OWNER_NAME", "  Grace Brewster Hopper ")
    clean_env.setenv("ADMIN_PASSWORD", "pw")
    clean_env.setenv("SESSION_SECRET", "s3cret")
    clean_env.setenv("KNOWLEDGE_DIR", str(tmp_path / "k"))
    clean_env.setenv("STATIC_DIR", str(tmp_path / "d"))
    settings = load_settings(env_file=None)
    assert settings.model == "openai/gpt-5.6-luna"
    assert settings.owner_name == "Grace Brewster Hopper"
    assert settings.owner_first_name == "Grace"
    assert settings.effective_session_secret == "s3cret"
    assert settings.knowledge_dir == tmp_path / "k"
    assert settings.static_dir == tmp_path / "d"


@pytest.mark.parametrize("value,expected", [("1", True), ("true", True), ("YES", True), ("0", False), ("", False), ("no", False)])
def test_cookie_secure_parsing(clean_env, value, expected):
    clean_env.setenv("COOKIE_SECURE", value)
    assert load_settings(env_file=None).cookie_secure is expected


def test_session_secret_fallback(clean_env):
    clean_env.setenv("ADMIN_PASSWORD", "hunter2")
    assert load_settings(env_file=None).effective_session_secret == "avatar::hunter2"


def test_env_file_does_not_override_real_environment(clean_env, tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text("MODEL=openai/from-dotenv\nOWNER_NAME=Dot Env\n", encoding="utf-8")
    clean_env.setenv("MODEL", "openai/gpt-5.4-nano")
    settings = load_settings(env_file=env_file)
    assert settings.model == "openai/gpt-5.4-nano"  # the real env var wins
    assert settings.owner_name == "Dot Env"  # filled from .env when unset


def test_missing_owner_name_uses_placeholder(clean_env):
    settings = load_settings(env_file=None)
    assert settings.owner_name
    assert settings.owner_first_name


def test_placeholder_owner_name_is_neutral_and_logged(clean_env, caplog):
    with caplog.at_level("WARNING", logger="avatar.config"):
        settings = load_settings(env_file=None)
    assert settings.owner_name == "Owner"
    assert any("OWNER_NAME is not set" in r.message for r in caplog.records)


def test_blank_or_whitespace_values_fall_back(clean_env):
    clean_env.setenv("MODEL", "   ")
    clean_env.setenv("OWNER_NAME", "  ")
    clean_env.setenv("SESSION_SECRET", "  ")
    clean_env.setenv("ADMIN_PASSWORD", "  pw  ")
    settings = load_settings(env_file=None)
    assert settings.model == DEFAULT_MODEL
    assert settings.owner_name == "Owner"
    assert settings.admin_password == "pw"  # surrounding whitespace is stripped
    assert settings.effective_session_secret == "avatar::pw"


def test_single_word_owner_name_first_name(clean_env):
    clean_env.setenv("OWNER_NAME", "Cher")
    settings = load_settings(env_file=None)
    assert settings.owner_first_name == "Cher"


def test_missing_env_file_is_ignored(clean_env, tmp_path):
    clean_env.setenv("OWNER_NAME", "Env Only")
    settings = load_settings(env_file=tmp_path / "does-not-exist.env")
    assert settings.owner_name == "Env Only"


def test_all_documented_keys_are_read_from_env_file(clean_env, tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "OPENROUTER_API_KEY=sk-or-file\nMODEL=openai/gpt-5.6-luna\nOWNER_NAME=File Owner\nADMIN_PASSWORD=pw\n"
        "PUSHOVER_USER=pu\nPUSHOVER_TOKEN=pt\nSUPABASE_URL=https://x.supabase.co\nSUPABASE_KEY=sb_secret_x\n"
        "SESSION_SECRET=ss\nCOOKIE_SECURE=1\n",
        encoding="utf-8",
    )
    s = load_settings(env_file=env_file)
    assert (s.openrouter_api_key, s.model, s.owner_name, s.admin_password) == ("sk-or-file", "openai/gpt-5.6-luna", "File Owner", "pw")
    assert (s.pushover_user, s.pushover_token) == ("pu", "pt")
    assert (s.supabase_url, s.supabase_key) == ("https://x.supabase.co", "sb_secret_x")
    assert s.effective_session_secret == "ss" and s.cookie_secure is True


def test_model_env_beats_the_real_project_env_file(clean_env):
    """The repo .env holds the production model; MODEL in the environment wins (how tests run cheap)."""
    real_env = REPO_ROOT / ".env"
    if not real_env.exists():
        pytest.skip("no project .env")
    clean_env.setenv("MODEL", "openai/gpt-5.4-nano")
    assert load_settings(env_file=real_env).model == "openai/gpt-5.4-nano"


def test_get_settings_is_loaded_once():
    from app.config import get_settings

    assert get_settings() is get_settings()
