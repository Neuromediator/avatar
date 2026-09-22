#!/usr/bin/env bash
# Build and deploy Avatar to fly.io: create the app on first run, stage secrets
# from the root .env, then deploy. Run from anywhere; it finds the repo root.
set -euo pipefail

APP="avatar-sergei"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

command -v flyctl >/dev/null || { echo "flyctl not found — install it first"; exit 1; }
flyctl auth whoami >/dev/null || { echo "Not logged in — run 'fly auth login'"; exit 1; }

# 1. Create the app on first run (name must be globally unique).
flyctl status -a "$APP" >/dev/null 2>&1 || { echo "Creating $APP..."; flyctl apps create "$APP"; }

# 2. Stage secrets from .env (surrounding quotes stripped). PORT/COOKIE_SECURE are
#    set in fly.toml [env], not here. --stage applies them on the next deploy (one rollout).
KEYS="OPENROUTER_API_KEY MODEL OWNER_NAME ADMIN_PASSWORD PUSHOVER_USER PUSHOVER_TOKEN SUPABASE_URL SUPABASE_KEY SESSION_SECRET"
args=(); staged=(); skipped=()
for k in $KEYS; do
  v=$(grep -E "^${k}=" .env | head -1 | cut -d= -f2- || true)
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  if [ -n "$v" ]; then args+=("${k}=${v}"); staged+=("$k"); else skipped+=("$k"); fi
done
echo "Staging secrets: ${staged[*]:-(none)}"
[ ${#skipped[@]} -gt 0 ] && echo "Skipped (missing/empty in .env): ${skipped[*]}"
# Values go over stdin, never argv (argv is visible in ps / /proc/<pid>/cmdline).
if [ ${#args[@]} -gt 0 ]; then
  printf '%s\n' "${args[@]}" | flyctl secrets import --stage -a "$APP"
fi

# 3. Deploy (build context = repo root; start with 1 machine — scale later if needed).
flyctl deploy --config scripts/fly.toml --dockerfile Dockerfile -a "$APP" --ha=false

echo "Deployed: https://${APP}.fly.dev  (admin at /admin)"
