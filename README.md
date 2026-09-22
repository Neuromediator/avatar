# Avatar

A digital twin of Sergei Maslennikov, an LLM engineer and AI practitioner based in Tallinn, Estonia. Visitors chat with the twin about Sergei's background, projects and skills. The real Sergei can join any conversation live from an admin dashboard, so every chat is a three-way conversation between the visitor, the Avatar and the human.

Live: **https://avatar-sergei.fly.dev** (the owner dashboard is at `/admin`).

[SPEC.md](SPEC.md) describes the intended behaviour, `design-system/` defines the look and feel, and [DEPLOY.md](DEPLOY.md) covers production.

## Features

### Visitor chat (`/`)

- Replies stream in token by token, with the twin's tool activity shown as small status lines (for example "Looked up the FAQ · Q6" or "Notified Sergei · push_tool").
- Questions that match one of the 16 FAQ entries are answered from Sergei's own wording, translated into the reply language when needed.
- Typing a bare `Qn` (for example `Q2`) returns that FAQ entry instantly, with no LLM call. The reply restates the question before the answer.
- A deep link such as `https://avatar-sergei.fly.dev/?q=2` asks Q2 as soon as the page opens, then removes `q` from the URL.
- An optional name or initials field. "Keep chat" (on by default) remembers the conversation in a cookie and restores it on the next visit. "Reset" starts a new conversation.
- Three conversation starters on the intro screen; clicking one sends it.
- When Sergei joins, his messages appear as a separate bubble with his photo, a yellow ring and the label "Sergei Maslennikov · live". The page picks them up by polling every 10 seconds, slowing to once a minute after 5 quiet minutes.
- The twin replies in Russian, English or Estonian to match the visitor, and in English otherwise.
- Dark (default) and light themes, responsive down to phone width. The message field keeps focus after every send.

### Admin dashboard (`/admin`)

- Password sign-in with a 7-day session.
- An inbox sorted by latest activity: initials, name, time and the start of the visitor's latest message. Unread conversations have a dot; conversations where the Avatar asked for Sergei show a yellow "Needs you" marker. Filters (All, Needs you, Unread) and search.
- Opening a conversation shows the whole thread, including the twin's tool activity, and marks it read. "Mark resolved" clears "Needs you" without replying.
- Sergei can post into any thread (Enter sends, Shift+Enter adds a line). The Avatar does not reply to his message; it sees it in the transcript on the visitor's next turn.
- Up and Down arrow keys move through the conversation list. The inbox refreshes every 10 seconds.
- On phones (820 px and narrower) it becomes a master/detail flow: the inbox fills the screen, a tap opens the thread at the latest message, and a back control (or the browser's Back) returns to the inbox.

### Notifications

When a visitor wants to get in touch (the twin asks for their email first) or asks something the twin cannot answer, the twin calls `push_tool`. That sends a Pushover notification to Sergei's phone, flags the conversation "Needs you" in the inbox, and the twin tells the visitor it has passed the message on. If delivery fails, the conversation is still flagged and the twin does not claim a notification went out.

## How it works

```
 Visitor browser (/)                    Owner browser (/admin)
   | POST /api/chat  (SSE stream)          | /admin/api/*  (signed session cookie)
   | GET  /api/conversations/{id}  (poll)  |
   v                                       v
 +-----------------------------------------------------------+
 |  FastAPI, one Docker container on Fly.io                  |
 |  - serves the built Vite frontend at / and /admin         |
 |  - OpenAI Agents SDK agent with faq_tool and push_tool    |
 +-----------------------------------------------------------+
        |                     |                       |
        v                     v                       v
   OpenRouter            Supabase               Pushover
   (the MODEL)           messages table         (Sergei's phone)
```

A visitor turn:

1. The message is rate-limited, clamped and stored in the `messages` table.
2. A bare `Qn` is answered straight from `knowledge/faq.jsonl`. Nothing else happens.
3. Otherwise the backend builds one task prompt: the conversation so far, with each message labelled by speaker (visitor, Avatar, or Sergei joining live), followed by the latest visitor message. It is sent as a single user message rather than alternating user/assistant turns, because there are three participants.
4. `Runner.run_streamed` runs the agent. Text deltas and tool calls are streamed to the browser as server-sent events.
5. The final reply is stored with its tool calls. A turn that used `push_tool` is flagged `needs_attention`. The reply is stored even if the visitor closes the page mid-stream.

Sergei's own messages are inserted directly, with no LLM call, and reach the visitor through polling.

The agent uses OpenRouter the way the Agents SDK documents for non-OpenAI providers: an `AsyncOpenAI` client pointed at `https://openrouter.ai/api/v1`, wrapped in `OpenAIChatCompletionsModel` and set on this one agent. Reasoning effort is `low` and SDK tracing is disabled.

### Where the twin's knowledge comes from

There is no vector database. The system prompt is built once at startup from `knowledge/`:

| File | Role |
|---|---|
| `knowledge.md` | Sergei's first-person profile: facts, education, projects, certifications, skills, work, contact. Included in full. |
| `style.md` | Voice, banned phrasing, links, formatting and safety rules. Its `## Language` section sets the reply languages. Included in full. |
| `faq.jsonl` | 16 numbered entries (`faq`, `question`, `answer`, `query`). Only the short `query` phrasings go into the prompt, as a routing list; `faq_tool` and the `Qn` shortcut return the full question and answer. |
| `pic.jpg` | The source photo. The app does not read it at runtime; the avatars in `frontend/public/` (`avatar-human.png`, `avatar-robot.png`, `avatar-robot-round.png`) were generated from it. |

The owner's name is never hardcoded: it comes from `OWNER_NAME` and is filled into the prompts and pages at runtime.

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, FastAPI, uvicorn, managed with uv |
| Agent | OpenAI Agents SDK (`openai-agents` 0.17.4) via OpenRouter |
| Database | Supabase (Postgres through the Data API), `supabase` Python client |
| Frontend | Vanilla TypeScript and Vite (no framework), `marked` and DOMPurify for Markdown |
| Notifications | Pushover |
| Protections | `limits` (moving-window rate limits), `itsdangerous` (signed session cookie) |
| Tests | pytest with httpx, Playwright |
| Hosting | One Docker image on Fly.io |

## Repository layout

| Path | Contents |
|---|---|
| `backend/` | FastAPI app (`app/`), its pytest suite (`tests/`), uv project files |
| `frontend/` | Visitor page (`index.html`), admin page (`admin.html`), TypeScript sources (`src/`), images and icons (`public/`), Playwright specs (`e2e/`) |
| `knowledge/` | What the twin knows and how it speaks (see above) |
| `scripts/` | Docker start/stop scripts for macOS/Linux and Windows, `fly.toml`, `deploy.sh`, `wordpress-embed.html` |
| `test/` | The three test plans and their index |
| `design-system/` | Tokens, components, icons, avatar images, mockups and UX docs the UI is built from |
| `reference/` | Code examples the build started from (earlier twin prompt, FAQ notebook, Pushover example) |
| `Dockerfile` | Two-stage build: Node builds the frontend, Python runs the backend |

## Setup instructions

A fresh checkout needs a `.env` file in the repo root and the `messages` table in Supabase.

### Configuration (`.env`)

Real environment variables take precedence over `.env`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENROUTER_API_KEY` | yes | none | OpenRouter key (https://openrouter.ai/keys). Without it, replies fail. |
| `MODEL` | no | `openai/gpt-5.4-nano` | OpenRouter model id. Production runs `openai/gpt-5.6-luna`; nano is the code default and the model for tests. |
| `OWNER_NAME` | yes | `Owner` (logs a warning) | The person the twin represents: page title, header, how the Avatar refers to itself, and the label on the owner's live messages. |
| `ADMIN_PASSWORD` | yes | none | Password for `/admin`. If empty, nobody can sign in. |
| `PUSHOVER_USER` | no | none | Pushover user key. |
| `PUSHOVER_TOKEN` | no | none | Pushover application token. Without both Pushover values, conversations are still flagged "Needs you" but no phone notification is sent. |
| `SUPABASE_URL` | yes | none | Project URL without `/rest/v1/`. Without the Supabase values, routes that need the database return 503. |
| `SUPABASE_KEY` | yes | none | Supabase secret key (`sb_secret_...`). Server-side only. |
| `SESSION_SECRET` | production | `avatar::<ADMIN_PASSWORD>` | Signs the admin session cookie. Use a long random value (`openssl rand -hex 32`). Changing it signs out every admin session. |
| `COOKIE_SECURE` | production | off | `1` makes the admin cookie `Secure`. Leave it off for local http; `scripts/fly.toml` sets it to `1`. |

`KNOWLEDGE_DIR` and `STATIC_DIR` default to `knowledge/` and `frontend/dist/` and are set by the Dockerfile. `FLY_APP_NAME` is set by Fly.

### Database (Supabase)

The project runs in `eu-west-1` (Ireland). It was created with **Enable Data API** on and **Enable automatic RLS** off; "Automatically expose new tables" can be either, because the SQL grants access explicitly. To recreate the table, run this in the Supabase SQL editor:

```sql
create table public.messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null,
  conversation_name text,
  role            text not null check (role in ('visitor', 'avatar', 'human')),
  content         text not null,
  tool_calls      jsonb,
  needs_attention boolean not null default false,
  read            boolean not null default false,
  created_at      timestamptz not null default now()
);

create index messages_conversation_id_idx on public.messages (conversation_id);
create index messages_created_at_idx on public.messages (created_at desc);

-- Give the backend's secret key (service_role) access to the table.
-- Required if "Automatically expose new tables" is off; harmless otherwise.
grant select, insert, update, delete on public.messages to service_role;
```

Supabase warns that the table has no Row Level Security; choose **Run without RLS**. This is intentional: only the backend touches the table, using the secret key, and no publishable/anon key is used anywhere, so no browser can reach it. The backend enforces admin access itself.

- `role` is `visitor`, `avatar` or `human` (Sergei). `conversation_name` holds the visitor's optional name.
- `tool_calls` records the tools the Avatar used in that reply (or an `instant` marker for a `Qn` answer).
- `needs_attention` is set on the reply of a turn that used `push_tool`. `read` tracks whether Sergei has seen the row. Opening a thread in admin clears both in one call.
- `SUPABASE_URL` is the API URL from **Settings > Data API**, without the trailing `/rest/v1/`. `SUPABASE_KEY` is a secret key from **Settings > API Keys** (not the legacy `anon` / `service_role` tab). Keep it out of git and out of the frontend.

### Validate

```
cd backend && uv run pytest tests/test_supabase_connection.py -v
```

The three tests check that `SUPABASE_URL` and `SUPABASE_KEY` are present and correctly prefixed, that the table is reachable through the Data API, and that a row can be inserted and deleted.

## Running locally

### Docker

The whole app runs as one container, built and started from the repo root. Docker must be running.

| | macOS / Linux | Windows (PowerShell) |
|---|---|---|
| Build and start | `./scripts/start_mac.sh` | `.\scripts\start_pc.ps1` |
| Stop | `./scripts/stop_mac.sh` | `.\scripts\stop_pc.ps1` |

The start script stops and removes any running `avatar` container, rebuilds the image, runs it with the root `.env`, and waits until `/api/config` answers. Then open http://localhost:8000 and http://localhost:8000/admin.

Optional variables: `HOST_PORT` (default 8000), `MODEL_OVERRIDE` (replaces `MODEL` for this run) and `HEALTH_TIMEOUT` (seconds, default 60). To run on the cheap model:

```
MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh
```

On Windows, set `$env:MODEL_OVERRIDE = 'openai/gpt-5.4-nano'` before running `start_pc.ps1`.

### Development (two terminals)

```
cd backend
uv run uvicorn app.main:app --reload --app-dir .
```

```
cd frontend
npm install
npm run dev
```

Vite serves the visitor page at http://localhost:5173 and the admin page, also with hot reload, at http://localhost:5173/admin.html. It proxies `/api` and `/admin` (login, logout and the admin API) to the backend on port 8000; set `AVATAR_BACKEND_URL` to point elsewhere. The backend on port 8000 serves the built frontend from `frontend/dist/`, so its own pages return 503 until you run `npm run build`.

## Updating the twin's knowledge

1. Edit the files in `knowledge/`. For example, to add a project, add it to the Projects section of `knowledge.md` and append a row to `faq.jsonl` (one JSON object per line):

   ```json
   {"faq": 17, "question": "Tell me about the ... project", "answer": "Markdown answer in Sergei's words, with links.", "query": "... project"}
   ```

   Keep `query` short and specific: it is what the model matches a visitor's question against. A malformed row stops the app at startup with the file and line number.

2. Run the backend tests: `cd backend && uv run pytest -q`. They read the FAQ range from `faq.jsonl`, so new entries need no test changes.
3. Commit and push.
4. Redeploy with `scripts/deploy.sh` (see [DEPLOY.md](DEPLOY.md)). Knowledge is read once at startup and copied into the image, so a change needs a backend restart locally, a rebuild with the start script in Docker, and a redeploy on Fly.

Some owner-specific copy is hand-written in the frontend rather than read from `knowledge/`, and needs a frontend rebuild (and redeploy) when it changes:

- `frontend/index.html`: the intro text and the three conversation starters (in `#intro`), the meta and Open Graph descriptions, and the footer links to LinkedIn, GitHub and Hugging Face (`nav.social`).
- `frontend/public/`: the avatar images, identical copies of `design-system/assets/`.
- `frontend/src/styles/tokens.css`: the background texture (`--grid-mark`; options in `design-system/docs/background-texture.md`).

## Testing

| Suite | Command | Size |
|---|---|---|
| Backend (pytest) | `cd backend && uv run pytest -q` | 418 tests; the 8 real-LLM tests are skipped unless selected |
| Real LLM | `cd backend && MODEL=openai/gpt-5.4-nano uv run pytest -m llm -q` | 8 tests via OpenRouter |
| Supabase connectivity | `cd backend && uv run pytest tests/test_supabase_connection.py -v` | 3 tests |
| Frontend (Playwright) | build, run the backend on port 8100, then `cd frontend && BASE_URL=http://localhost:8100 npm run test:e2e` | 90 tests, desktop and mobile |
| Docker end to end | `MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh`, then `cd frontend && BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e npx playwright test` | 95 tests, including the three-way visitor, Avatar and owner scenarios |

The backend suite runs on an in-memory repository and a fake agent stream, and covers every admin route being refused without a valid session. Always test with `openai/gpt-5.4-nano`. Some browser and Docker runs send real Pushover notifications and write `TEST ...` conversations to Supabase.

The plans, with every item ticked, are `test/backend_test_plan.md`, `test/frontend_test_plan.md` and `test/e2e_test_plan.md`. [test/README.md](test/README.md) indexes them and gives the full re-run sequence. Final run (2026-09-22): backend 410 passed and 8 skipped, plus 8/8 real-LLM and 3/3 connectivity; Playwright against the container 94 passed and 1 skipped by design; production smoke test 19/19.

## Deployment

Production is the same container on Fly.io:

- App `avatar-sergei` at https://avatar-sergei.fly.dev, region `lhr` (London, the closest Fly region to the Supabase project in Ireland).
- One `shared-cpu-1x` machine with 512 MB RAM, always on (about $3.30/month).
- `scripts/fly.toml` sets `COOKIE_SECURE=1`, forces HTTPS, health-checks `/api/config`, and allows 75 seconds for shutdown so in-flight replies (up to 60 seconds) are saved.
- `scripts/deploy.sh` creates the app if needed, stages the secrets from `.env` as Fly secrets (passed over stdin, never baked into the image), and deploys.

There is no custom domain yet. [DEPLOY.md](DEPLOY.md) covers the full procedure, secrets, the post-deploy smoke test, operations, and how to add a subdomain later. `scripts/wordpress-embed.html` is a ready iframe snippet for a WordPress page; it forwards the host page's `?q=` to the app. Inside a cross-site iframe the "Keep chat" cookie may not persist, which is why DEPLOY.md recommends serving the app from a subdomain of the host site.

## Protections

Built in, with no configuration:

| Guard | Behaviour |
|---|---|
| Chat rate limit | 20 messages per minute per `conversation_id` (moving window). Excess requests get HTTP 429 before any database write or LLM call, and the chat shows "You're sending messages too quickly. Please wait a moment and try again." `Qn` requests count too. |
| Message length | A visitor message over 20,000 characters is cut to 20,000 and `[...message truncated as it's too long; ask the visitor to send something more concise]` is appended. The clamped text is what is stored and sent to the model. Empty messages are rejected. |
| Request size | Request bodies over 512 KiB get HTTP 413. |
| Other input | Visitor names are cut to 60 characters. The owner's messages are limited to 20,000 characters (rejected, not truncated). NUL characters and lone surrogates are stripped. |
| Admin sign-in | Failed attempts are limited to 10 per minute and 50 per hour per client IP (HTTP 429). Successful sign-ins are not counted and there is no global cap, so Sergei cannot be locked out. The password is compared in constant time. |
| Admin session | Signed, httpOnly, `SameSite=Lax` cookie valid for 7 days, `Secure` in production. Signing out revokes the token until the process restarts. |
| Prompt | The transcript sent to the model is capped at 60 messages and 60,000 characters (8,000 per message). Text that imitates the prompt's own tags is neutralised. |

Limits are held in memory per process. There is no global chat limit because OpenRouter caps total spend.

## Credits and licence

Built with Claude Code, starting from the Avatar course template by Ed Donner. MIT licence, see [LICENSE](LICENSE).
