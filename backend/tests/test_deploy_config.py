"""Deployment files: scripts/fly.toml, scripts/deploy.sh and scripts/wordpress-embed.html.

SPEC "Tech stack decisions": the app is deployed to fly.io as app `avatar-sergei` in region
`lhr`, on a `shared-cpu-1x` machine with 512 MB RAM, always on, driven by `scripts/fly.toml`
and `scripts/deploy.sh`; `scripts/wordpress-embed.html` is a ready-to-paste embed with a `BASE`
constant and the `?q=` passthrough. Nothing here deploys or calls flyctl: the files are parsed
(and `deploy.sh` is only syntax-checked with `bash -n`, which never executes it).
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tomllib

import pytest

from app.config import REPO_ROOT

SCRIPTS = REPO_ROOT / "scripts"
FLY_TOML = SCRIPTS / "fly.toml"
DEPLOY_SH = SCRIPTS / "deploy.sh"
EMBED = SCRIPTS / "wordpress-embed.html"
DOCKERFILE = REPO_ROOT / "Dockerfile"
DEPLOY_MD = REPO_ROOT / "DEPLOY.md"
MAIN_PY = REPO_ROOT / "backend" / "app" / "main.py"

APP = "avatar-sergei"


@pytest.fixture(scope="module")
def fly() -> dict:
    return tomllib.loads(FLY_TOML.read_text(encoding="utf-8"))


def app_drain_seconds() -> int:
    """The shutdown drain in the app's lifespan: `asyncio.wait(pending, timeout=N)`."""
    match = re.search(r"asyncio\.wait\(pending,\s*timeout=(\d+)\)", MAIN_PY.read_text(encoding="utf-8"))
    assert match, "the lifespan drain was not found in backend/app/main.py"
    return int(match.group(1))


# ---------------------------------------------------------------------------
# scripts/fly.toml
# ---------------------------------------------------------------------------


def test_fly_app_and_region_are_the_spec_values(fly):
    assert fly["app"] == APP
    assert fly["primary_region"] == "lhr"  # London: closest Fly region to Supabase eu-west-1


def test_fly_vm_is_shared_cpu_1x_with_512mb(fly):
    vms = fly["vm"]
    assert len(vms) == 1
    assert vms[0]["size"] == "shared-cpu-1x"
    assert vms[0]["memory"] == "512mb"


def test_fly_machine_is_always_on(fly):
    service = fly["http_service"]
    assert service["min_machines_running"] >= 1  # never scaled to zero
    assert service["auto_start_machines"] is True
    assert service["force_https"] is True


def test_fly_internal_port_matches_the_dockerfile(fly):
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    assert re.search(r"^EXPOSE 8000$", dockerfile, re.M)
    assert re.search(r"^\s*PORT=8000\b", dockerfile, re.M)  # the image's ENV
    assert '--port \\"${PORT:-8000}\\"' in dockerfile  # uvicorn listens on $PORT
    assert fly["http_service"]["internal_port"] == 8000
    assert fly["env"]["PORT"] == "8000"


def test_fly_health_check_is_the_db_free_config_endpoint(fly):
    checks = fly["http_service"]["checks"]
    assert len(checks) == 1
    assert checks[0]["method"] == "GET"
    assert checks[0]["path"] == "/api/config"  # 200 without a database hit (test_public_api.py)


def test_fly_production_cookie_is_secure(fly):
    assert fly["env"]["COOKIE_SECURE"] == "1"


def test_fly_kill_timeout_exceeds_the_app_drain(fly):
    drain = app_drain_seconds()
    assert drain == 60
    assert fly["kill_signal"] == "SIGINT"  # uvicorn shuts down gracefully on SIGINT
    assert drain < fly["kill_timeout"] <= 300  # Fly's maximum is 300 s


def test_fly_env_holds_no_secrets(fly):
    assert set(fly["env"]) == {"PORT", "COOKIE_SECURE"}


def test_fly_concurrency_counts_connections_for_sse(fly):
    concurrency = fly["http_service"]["concurrency"]
    assert concurrency["type"] == "connections"  # a streamed reply holds one connection
    assert concurrency["soft_limit"] < concurrency["hard_limit"]


# ---------------------------------------------------------------------------
# scripts/deploy.sh
# ---------------------------------------------------------------------------


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is not installed")
def test_deploy_script_parses():
    result = subprocess.run(["bash", "-n", str(DEPLOY_SH)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr


def test_deploy_script_targets_the_same_app_and_config():
    script = DEPLOY_SH.read_text(encoding="utf-8")
    assert script.startswith("#!/usr/bin/env bash\n")
    assert "set -euo pipefail" in script
    assert re.search(r'^APP="avatar-sergei"$', script, re.M)
    assert "flyctl deploy --config scripts/fly.toml --dockerfile Dockerfile" in script


def test_deploy_script_stages_every_secret_and_only_secrets():
    script = DEPLOY_SH.read_text(encoding="utf-8")
    keys = re.search(r'^KEYS="([^"]+)"$', script, re.M).group(1).split()
    assert set(keys) == {
        "OPENROUTER_API_KEY", "MODEL", "OWNER_NAME", "ADMIN_PASSWORD", "PUSHOVER_USER",
        "PUSHOVER_TOKEN", "SUPABASE_URL", "SUPABASE_KEY", "SESSION_SECRET",
    }
    # Values travel over stdin, never on the command line.
    assert "flyctl secrets import --stage" in script
    assert "flyctl secrets set" not in script


def test_deploy_md_copies_match_the_scripts():
    doc = DEPLOY_MD.read_text(encoding="utf-8")
    toml = re.search(r"### `scripts/fly.toml`\n\n```toml\n(.*?)```", doc, re.S)
    bash = re.search(r"### `scripts/deploy.sh`\n\n```bash\n(.*?)```", doc, re.S)
    assert toml and bash
    assert toml.group(1) == FLY_TOML.read_text(encoding="utf-8")
    assert bash.group(1) == DEPLOY_SH.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# scripts/wordpress-embed.html
# ---------------------------------------------------------------------------


def embed_script() -> str:
    html = EMBED.read_text(encoding="utf-8")
    scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
    assert len(scripts) == 1
    return scripts[0]


def test_embed_defines_a_base_constant_for_the_app_url():
    match = re.search(r'var BASE = "(https://[^"]+)";', embed_script())
    assert match
    assert match.group(1) == f"https://{APP}.fly.dev"


def test_embed_forwards_q_to_the_iframe_src():
    script = embed_script()
    assert 'new URLSearchParams(window.location.search).get("q")' in script
    assert 'src += "?q=" + encodeURIComponent(q.trim())' in script
    assert "frame.src = src" in script
    # Only a number is forwarded (the visitor page ignores anything else anyway).
    assert r"/^\d{1,3}$/.test(q.trim())" in script
    html = EMBED.read_text(encoding="utf-8")
    assert re.search(r'<iframe\s[^>]*id="avatar-frame"', html)


def test_embed_snippet_has_no_blank_lines_inside_style_or_script():
    # WordPress inserts <p> tags at blank lines inside a Custom HTML block.
    html = EMBED.read_text(encoding="utf-8")
    for body in re.findall(r"<(?:style|script)>(.*?)</(?:style|script)>", html, re.S):
        assert "\n\n" not in body and not re.search(r"\n[ \t]+\n", body)
