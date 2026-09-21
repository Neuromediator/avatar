# Deployment (fly.io)

How to deploy Avatar to [fly.io](https://fly.io) as a single container, run it in production, and verify it. Nothing here is created automatically — the deployment artifacts live in `scripts/` (see below) and you deploy with `scripts/deploy.sh`.

> **Identifiers for this deployment** (owner: Sergei Maslennikov): app **`avatar-sergei`** → `https://avatar-sergei.fly.dev`, region **`lhr`** (London), machine **`shared-cpu-1x` / 512 MB**, always on (~$3.30/month). The app name is set in two places that must stay in sync: `APP="avatar-sergei"` in `scripts/deploy.sh` and `app = "avatar-sergei"` in `scripts/fly.toml`. There is no custom domain yet (section 7 is optional and can wait until the owner's website is deployed).

| | |
|---|---|
| **App** | `avatar-sergei` → `https://avatar-sergei.fly.dev` |
| **Region** | `lhr` (London) |
| **Machine** | `shared-cpu-1x`, 512 MB RAM (~$3.30/month) |
| **Always-on** | yes — `min_machines_running = 1` |
| **Build** | the existing multi-stage `Dockerfile` (builds the Vite frontend, runs the FastAPI backend, copies `knowledge/`) |

### Why this shape

The app is **IO-bound**: a chat reply is dominated by the OpenRouter LLM, which is streamed back **asynchronously** (SSE), so concurrent chats are mostly-idle async tasks relaying tokens — light on CPU. The constraint is **memory** (Python + the Agents SDK + live connections). 512 MB is comfortable for a personal site at a few concurrent visitors, and is the cheapest size that leaves real headroom above the ~150–250 MB the process needs; 256 MB ($2.02) risks the container being killed under load. If traffic ever justifies it, `fly scale vm shared-cpu-1x --memory 1024` is a one-line change (section 8).

**Region:** the Supabase project is in `eu-west-1` (Ireland). Fly has no Irish region, so `lhr` (London) is the closest and keeps the several DB round-trips per request fast. The owner sits in Tallinn, but visitor-to-app latency matters far less than app-to-DB latency here, because the reply time is dominated by the model.

## 1. Prerequisites

- `flyctl` installed and logged in: `fly auth whoami` should print your email.
- The root `.env` fully populated, including `SESSION_SECRET` (see secrets below). `.env` is **never** baked into the image (`.dockerignore` excludes it); its values become Fly secrets.
- No local Docker needed — `fly deploy` builds on Fly's remote builders.

## 2. Deployment artifacts (in `scripts/`)

Keep the Fly config and deploy script alongside the existing `start_mac.sh` / `stop_mac.sh` etc. Two files to add:

### `scripts/fly.toml`

```toml
# Fly.io config for the Avatar app. Deploy with scripts/deploy.sh.
app = "avatar-sergei"
primary_region = "lhr"               # closest Fly region to the Supabase eu-west-1 (Ireland) DB

[env]
  PORT = "8000"                      # matches the Dockerfile's uvicorn --port
  COOKIE_SECURE = "1"                # production is HTTPS -> admin session cookie must be Secure

[http_service]
  internal_port = 8000
  force_https = true
  auto_start_machines = true
  auto_stop_machines = "stop"        # stop EXTRA machines when idle...
  min_machines_running = 1           # ...but always keep 1 warm

  [http_service.concurrency]
    type = "connections"             # SSE holds one connection for the whole streamed reply
    soft_limit = 40                  # (only relevant with >1 machine) start another past this
    hard_limit = 80                  # one machine accepts up to this many — set above your peak

  [[http_service.checks]]
    method = "GET"
    path = "/api/config"             # returns 200 with no DB hit — a clean health check
    interval = "15s"
    timeout = "3s"
    grace_period = "10s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

Note: the `Dockerfile` and build context (`frontend/`, `backend/`, `knowledge/`) are at the **repo root**, but this config lives in `scripts/`. So `deploy.sh` runs from the repo root and passes both `--config scripts/fly.toml` and `--dockerfile Dockerfile` explicitly. For ad-hoc commands (`status`, `logs`, `secrets`), use `-a avatar-sergei`; for `deploy`, use `-c scripts/fly.toml`.

Why the concurrency block matters: if omitted, Fly's defaults are low (~20 soft / 25 hard **connections**). Because every chat reply holds a connection open while it streams, a single machine would refuse the ~26th simultaneous user. `hard_limit = 80` is comfortably above any realistic peak for a personal site while staying within what 512 MB can hold; `soft_limit` only does anything once more than one machine exists.

### `scripts/deploy.sh`

```bash
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
args=()
for k in $KEYS; do
  v=$(grep -E "^${k}=" .env | head -1 | cut -d= -f2-)
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  [ -n "$v" ] && args+=("${k}=${v}")
done
[ ${#args[@]} -gt 0 ] && flyctl secrets set --stage -a "$APP" "${args[@]}"

# 3. Deploy (build context = repo root; start with 1 machine — scale later if needed).
flyctl deploy --config scripts/fly.toml --dockerfile Dockerfile -a "$APP" --ha=false

echo "Deployed: https://${APP}.fly.dev  (admin at /admin)"
```

Make it executable: `chmod +x scripts/deploy.sh`.

## 3. Environment variables / secrets

Set in `scripts/fly.toml` `[env]` (non-sensitive, committed):

| Var | Value | Why |
|---|---|---|
| `PORT` | `8000` | matches the Dockerfile's uvicorn port / `internal_port` |
| `COOKIE_SECURE` | `1` | production is HTTPS, so the admin session cookie must be `Secure` (it defaults off so local http works) |

Set as **Fly secrets** (sensitive, pulled from `.env` by `deploy.sh`):

`OPENROUTER_API_KEY`, `MODEL`, `OWNER_NAME`, `ADMIN_PASSWORD`, `PUSHOVER_USER`, `PUSHOVER_TOKEN`, `SUPABASE_URL`, `SUPABASE_KEY`, `SESSION_SECRET`.

Notes:
- **`SESSION_SECRET`** (now in `.env`) signs the admin session cookie. Setting it explicitly means rotating `ADMIN_PASSWORD` later won't unexpectedly invalidate the session-secret derivation. Use a long random value.
- **`MODEL`** is whatever is in `.env`, already set to `openai/gpt-5.6-luna` for production; `openai/gpt-5.4-nano` is the cheaper dev/test model and the code default. Switch either way later with `fly secrets set -a avatar-sergei MODEL=...`.
- Secrets can be set/changed any time: `fly secrets set -a avatar-sergei KEY=value` (triggers a rolling restart). View names with `fly secrets list -a avatar-sergei` (values are never shown).

## 4. Deploy

First time and every subsequent deploy are the same command:

```bash
scripts/deploy.sh
```

It creates the app if needed, stages secrets, and deploys 1 machine to `lhr`. For redundancy / zero-downtime deploys later, run a second machine:

```bash
fly scale count 2 -a avatar-sergei     # min_machines_running=1 keeps 1 warm; soft_limit balances across both
```

Note: the per-conversation rate limit (20 messages/minute) is held in memory **per machine**, so with more than one machine the effective limit is per machine rather than global. With a single always-on machine (the default here) it is exactly 20/min.

## 5. Testing (post-deploy smoke)

Run against `https://avatar-sergei.fly.dev`. Use `MODEL=openai/gpt-5.4-nano` for cheap test calls if you like, and clean up test data afterwards.

- [ ] `fly status -a avatar-sergei` — 1 machine in `lhr`, state `started`, health check **passing**.
- [ ] `curl -s https://avatar-sergei.fly.dev/api/config` → `{"owner_name":"..."}` (200).
- [ ] `/` loads the visitor UI (dark + light, desktop + mobile); the rings background renders and the footer shows the LinkedIn / GitHub / Hugging Face links (no YouTube).
- [ ] A normal question streams a reply (real LLM call); `Q2` returns the instant FAQ; `https://avatar-sergei.fly.dev/?q=2` opens and immediately answers Q2.
- [ ] FAQ routing works (e.g. ask "what is the tennis dashboard?" → `faq_tool` returns Q12), and links in replies are clickable.
- [ ] `/admin` → wrong password rejected; correct `ADMIN_PASSWORD` opens the dashboard; the inbox lists conversations and a thread opens quickly.
- [ ] Post a human message from admin → it appears in the visitor's chat within ~10 s (polling), styled as the "live" bubble.
- [ ] Contact-capture flow ("I'd like to get in touch", give an email) fires a **Pushover** notification.
- [ ] In DevTools, the admin session cookie has the **`Secure`** flag (confirms `COOKIE_SECURE=1`).
- [ ] `fly logs -a avatar-sergei` shows no errors during the above.
- [ ] Abuse guards work: a >20,000-character message is truncated (note appended), and a 21st message within a minute on one conversation returns HTTP 429 with the slow-down message (no model call).
- [ ] Clean up: delete the test conversation threads from Supabase and any screenshots.

## 6. Success criteria

Deployment is successful when:
- The app is reachable at `https://avatar-sergei.fly.dev` with HTTPS forced, ≥1 machine always running in `lhr`, and the health check green.
- All of the visitor, admin (login-gated), three-way human-in-the-loop, `Qn`/`?q=` instant answers, FAQ-tool routing, and Pushover paths work end to end.
- Secrets are configured via Fly (never baked into the image); the admin cookie is `Secure`.
- Logs are clean and the admin "open conversation" feels snappy (DB round-trips are fast from `lhr`).

## Abuse guards (built in)

Two cheap protections for your OpenRouter key are enforced in the backend, with no configuration:

- Visitor messages longer than 20,000 characters are truncated (with a note appended) before being stored or sent to the model.
- Each `conversation_id` is limited to 20 messages/minute; excess requests get HTTP 429 *before* any LLM call, and the visitor UI shows a friendly slow-down message.

The rate limit is in-memory per machine (see the scale-out note in section 4): one always-on machine gives exactly 20/min per conversation; more than one machine gives 20/min per conversation per machine. Your OpenRouter account limits remain the overall backstop.

## 7. Custom domain (optional)

**Not needed for this build** — the owner's website is not deployed yet, so skip this section until it is. Mapping the app to your own domain is optional; `https://avatar-sergei.fly.dev` works on its own. A subdomain of your site is worth it mainly for clean **iframe embedding**: serving the app from `avatar.<yourdomain>` (the same registrable domain as the host page) keeps the "Keep chat" cookie **first-party**, avoiding third-party-cookie blocking.

1. Request the certificate:

   ```bash
   fly certs add avatar.<yourdomain> -a <your-app>
   ```

2. Add a **CNAME** record at your DNS provider, pointing `avatar` at the Fly hashed target shown by `fly certs show avatar.<yourdomain> -a <your-app>` (e.g. `pq9wl1k.<your-app>.fly.dev`). Prefer this CNAME over the A/AAAA records Fly also lists: the app's IPv4 is a *shared* Fly address (not exclusively yours), and a CNAME automatically tracks any Fly IP change. Use a short TTL (~300s) during setup so corrections propagate quickly.

   - If your domain is behind a **Cloudflare proxy**, set the record to **DNS-only (grey cloud)** and add the `_fly-ownership` TXT record Fly provides, otherwise the Let's Encrypt cert will not issue.

3. Watch issuance with `fly certs check avatar.<yourdomain> -a <your-app>`. Once DNS propagates, Fly issues the cert automatically and the app is served at `https://avatar.<yourdomain>` over HTTPS.

**Embedding.** A ready-to-paste snippet is in `scripts/wordpress-embed.html` (a WordPress "Custom HTML" block): it pins the app full-bleed just below the site nav, overrides the theme's content-column max-width, guards against horizontal overflow on narrow screens, and forwards `?q=N` from the host page into the iframe. Change two values for your own site — the `BASE` constant (your subdomain, e.g. `https://avatar.<yourdomain>`) and the iframe `title` (your own name). See SPEC.md "Tech stack decisions" for the `frame-ancestors` guidance.

## 8. Operations

- Status / logs: `fly status -a avatar-sergei`, `fly logs -a avatar-sergei`.
- Scale up/out: `fly scale vm shared-cpu-1x --memory 1024 -a avatar-sergei` (more RAM), `fly scale count 2 -a avatar-sergei` (more machines).
- Roll back: `fly releases -a avatar-sergei` then `fly deploy` a prior image, or `fly releases rollback -a avatar-sergei`.
- Secrets change: `fly secrets set -a avatar-sergei KEY=value` (rolling restart).
