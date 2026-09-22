# Avatar - Spec

## Introduction

Avatar is Sergei Maslennikov's online Digital Twin, with a twist. It is live at `https://avatar-sergei.fly.dev` (owner dashboard at `/admin`); the source is `github.com/Neuromediator/avatar`.

It's a web application that allows visitors to interact with a Digital Twin Avatar of the human who runs the site.

The Avatar is implemented with the OpenAI Agents SDK, with tools to look up the owner's FAQ and to notify the owner.

There's an added dimension: the human (who the twin represents) can join any of the conversations and weigh in. The conversations are 3-way: between the visitor, the Avatar, and the human.

This SPEC describes the app as built and deployed, and is the contract for further changes.

## User Experiences

### The Interactive Chat Experience

A visitor comes to the web app. They are presented with a modern, sharp, fresh Avatar web app. At the top there is an optional field for them to enter their first name or initials (up to 60 characters). There's also a switch "Keep chat" that defaults to on.

The browser assigns a unique conversation_id (a UUID) to this chat. If Keep chat is on, the browser reuses the conversation_id held in its `avatar_cid` cookie (1 year, `SameSite=Lax`) when there is one, and calls the server to obtain the chat so far. With Keep chat off, every page load starts a new conversation and the cookie is removed.

There's also a Reset chat button that clears the chat and assigns a new conversation_id. The old conversation stays on the server.

The chat is presented as an instant message experience, more refined than a typical chatbot screen. The visitor's messages carry their initials in a bubble. Responding to the visitor is the digital twin, and in some cases the human responds in addition to the Avatar; the human's bubble is labelled `<OWNER_NAME> · live`. The Avatar's reply streams in as it is written, and each tool call shows as a small status line (for example "Looked up the FAQ · Q3", "Notified <first name> · push_tool", or "Flagged for <first name> · push_tool" when the phone notification was not delivered).

The visitor chat is fully responsive and works great on mobile as well as desktop, in both dark and light mode. The intro screen offers three example prompts (conversation starters; see Tech stack decisions); clicking one submits it immediately. Typing a bare `Qn` (e.g. `Q2`, case-insensitive) is an instant-answer shortcut that returns that FAQ with no LLM call; the reply restates the question before the answer (e.g. "**Q2:** ...the question... / ...the answer..."). A number with no FAQ entry gets a short reply naming the valid range (Q1 to Q16), also with no LLM call. A deep link `?q=N` (e.g. `/?q=2`, or `/?q=Q2`) opens the page and immediately submits that `Qn`, so a single shared link can answer a specific question on arrival; the parameter is then cleared from the URL.

### The Human Admin Experience

The human (the owner of this app) can bring up a browser at /admin and enter a password. They are then presented with a dashboard. The left hand sidebar contains a list of conversations (like an email inbox), most recent activity on top. They are shown as initials (or `Visitor · xxxx` when no name was given), timestamp, and the beginning of the visitor's latest message.

When the human clicks on a conversation in the left hand sidebar, the main panel shows the complete interaction with that visitor and the Avatar (and possibly the human). The human can choose to add a message; it is posted as the owner, and the Avatar does not reply to it (Q&A #4).

It's clear in the sidebar which conversations have unread messages. If a conversation needs the human's involvement (because the Avatar used the push tool) it is marked **Needs you** until the human opens it; inside the thread an "Avatar asked for you" flag stays until the human replies or presses **Mark resolved**. Filter chips (All / Needs you / Unread) and a search box narrow the list. Arrow keys can be used to efficiently move up and down the conversations, and Enter sends a message (Shift+Enter for a multi-line message). The inbox refreshes every 10 seconds. Sign out ends the session.

The admin dashboard is also usable on mobile (at 820px wide and below), as a master/detail flow: the inbox fills the screen, tapping a conversation opens its full thread (scrolled to the latest message) with a back control to return to the inbox. The desktop side-by-side layout is unchanged.

## Implementation Decisions

- Conversations are stored in the Supabase `messages` table, one row per message: `id`, `conversation_id` (UUID), `conversation_name` (the visitor's optional name), `role` (`visitor`, `avatar` or `human`), `content`, `tool_calls` (jsonb record of tool use: FAQ lookups, push calls, instant answers), `needs_attention`, `read` and `created_at`. The DDL, indexes and grants are in the README.
- The admin password is the environment variable `ADMIN_PASSWORD`, compared in constant time. Only a signed-in admin can list conversations or read other people's conversations; a visitor reads only the conversation whose UUID they hold. Every `/admin/api/*` route requires the session cookie (Q&A #6).
- The admin session is the httpOnly `avatar_admin` cookie: signed with `SESSION_SECRET` (itsdangerous), valid 7 days, `SameSite=Lax`, `Secure` when `COOKIE_SECURE` is set, and carrying a random token id. `POST /admin/logout` revokes that token id until its natural expiry. The revocation list is in memory per process, so it does not survive a restart.
- Failed admin sign-ins are throttled per client at 10 per minute and 50 per hour (moving window, in memory per process). Over the limit, `POST /admin/login` returns HTTP 429 with `Retry-After` before the password is checked. Successful sign-ins are not counted and there is no global cap, so failures from other addresses cannot lock the owner out. On Fly (`FLY_APP_NAME` set) the client key is the `Fly-Client-IP` header; elsewhere it is the socket peer address, because `X-Forwarded-For` can be spoofed.
- The LLM call uses the OpenAI Agents SDK. The instructions explain the full situation. The user prompt (task) summarizes the full conversation so far (i.e. 1 user prompt to handle all roles, rather than user/assistant, because of the human). Its transcript is capped at 60 messages and 60,000 characters (8,000 per message); the owner's messages are kept first, then the newest visitor/Avatar messages, and gaps are marked as omitted.
- The prompts are owner-agnostic: the owner's name comes only from `OWNER_NAME`, and every owner fact, voice note and rule comes from `knowledge/`. The visitor-language rule is read from the `## Language` section of `knowledge/style.md` (currently: reply in Russian, English or Estonian to match the visitor, otherwise English) and is repeated after every `faq_tool` answer so the Avatar translates it. The code names no language.
- `push_tool` flags the conversation (`needs_attention` on the Avatar's row for that turn) whether or not the Pushover notification is delivered. Its output tells the Avatar what to tell the visitor: that it has passed this on when delivered, otherwise that it has flagged it for the owner in the dashboard, with no claim of a phone notification. The `tool_output` SSE event for `push_tool` carries `ok` (delivered or not), which the visitor UI shows as "Notified" or "Flagged for".
- The frontend polls the backend every 10 seconds for any updates from the human (slowing down to every minute after 5 mins have passed with no activity; a send or a new message returns it to 10 seconds). It polls only once the conversation has messages, pauses while a send is in flight, uses an `?after_id=` cursor, and polls at once when the tab becomes visible again.
- The OpenRouter API key is `OPENROUTER_API_KEY` in `.env`. The model is read from `MODEL` (an OpenRouter `openai/...` identifier; Q&A #2): `openai/gpt-5.4-nano` is the code default in `config.py` and the model for development and testing; production runs `openai/gpt-5.6-luna`. The agent runs with reasoning effort `low` (`ModelSettings(reasoning=Reasoning(effort="low"))`), which makes FAQ routing and pushing on unknowns reliable.
- Conversation reads use a single Supabase round-trip. Opening a thread in admin marks every row read, clears the needs-attention flag, and returns the updated rows in one PostgREST "update ... returning" call; the public conversation fetch derives the conversation name from the rows it already loaded (no extra query). The `messages` table is indexed on `conversation_id` and `created_at` (see the README), keeping these reads fast as volume grows.
- Abuse guards protect the API key (no configuration). Visitor input is sanitized (NUL characters and lone surrogates removed), stripped, then clamped: a message longer than 20,000 characters is truncated to 20,000 and the note `[...message truncated as it's too long; ask the visitor to send something more concise]` is appended; the clamped text is what is stored AND what is sent to the LLM. An empty message returns 422. The visitor name is collapsed to single spaces and cut to 60 characters. The owner's admin messages are limited to 20,000 characters and rejected (422) above that, not truncated.
- Each `conversation_id` is rate-limited to 20 chat messages per minute (a moving-window limiter from the `limits` package, held in memory per process). Excess requests return HTTP 429 with `Retry-After` *before* any database write or LLM call; `Qn` and empty messages count toward the limit. The frontend shows a friendly "you're sending messages too quickly" message and restores the draft. In-memory state is sufficient because OpenRouter caps overall spend and a browser's requests stick to one machine. (See Q&A #12.)
- Request bodies are capped at 512 KiB by an ASGI middleware (checked against `Content-Length`, and counted as chunked bodies arrive). Larger bodies return HTTP 413 before they are buffered.
- Each chat turn runs as its own asyncio task, so the reply is generated and stored even if the visitor disconnects; the visitor UI then picks it up by polling. On shutdown the app waits up to 60 seconds for unfinished turns before exiting. If a turn fails after `push_tool` fired, a fallback reply is stored with `needs_attention` set, so the owner still sees the request.
- HTTP surface. Public: `GET /api/config` (`owner_name`, `owner_first_name`; no database call; the health check for Docker and Fly), `GET /api/conversations/{id}` (optional `?after_id=`; never exposes `read` or `needs_attention`), `POST /api/chat` (SSE). Admin: `POST /admin/login`, `POST /admin/logout`, and behind the session `GET /admin/api/session`, `GET /admin/api/conversations`, `GET /admin/api/conversations/{id}` (marks read), `POST /admin/api/conversations/{id}/messages`, `POST /admin/api/conversations/{id}/resolve` (clears `needs_attention` only). Malformed conversation ids return 422. `HEAD` is answered on `/api/config`, `/api/conversations/{id}`, the page routes (`/`, `/index.html`, `/admin`, `/admin/`, `/admin.html`) and static files. The OpenAPI docs routes are disabled.

### Use of OpenAI Agents SDK

The Avatar uses current, idiomatic OpenAI Agents SDK (`openai-agents`, version locked in `backend/uv.lock`), with OpenRouter wired the way the SDK documents for non-OpenAI providers: an `AsyncOpenAI` client with base URL `https://openrouter.ai/api/v1`, wrapped in `OpenAIChatCompletionsModel` and set on this one agent. Tracing is disabled. The agent has two tools, `faq_tool(question_number)` and `push_tool(message)`, and replies stream through `Runner.run_streamed`. Changes keep to current, idiomatic SDK usage.

### Tech stack decisions

- The frontend is an HTML/TS/Vite static site in `frontend/` (vanilla TypeScript, no framework), built to `frontend/dist`.
- The backend is FastAPI in a uv project in `backend/`. It serves the static UI at `/` and `/admin`, filling `{{OWNER_NAME}}` and `{{OWNER_FIRST_NAME}}` into the pages on each request.
- The platform is built as a single Docker container (Node builds the frontend; Python 3.12 runs the backend as a non-root user; no secrets in the image). The `scripts/` folder has `start_mac.sh`, `stop_mac.sh`, `start_pc.ps1` and `stop_pc.ps1`. The start scripts stop the Docker container if running, then rebuild, run it with the root `.env` and wait until `/api/config` answers. `HOST_PORT` (default 8000) and `MODEL_OVERRIDE` adjust a run. The stop grace is 70 seconds, longer than the app's 60-second shutdown drain.
- The platform is deployed to fly.io as the single container the Dockerfile and `scripts/` build and run: app `avatar-sergei` in region `lhr` (London, the closest Fly region to the Supabase project in eu-west-1 / Ireland), on one `shared-cpu-1x` machine with 512 MB RAM, always on, at `https://avatar-sergei.fly.dev`. `scripts/fly.toml` sets `COOKIE_SECURE="1"`, `kill_signal = "SIGINT"` and `kill_timeout = 75` (longer than the 60-second drain, so in-flight replies are stored), and health-checks `/api/config`. `scripts/deploy.sh` creates the app on first run, imports the nine secrets from `.env` over stdin (`flyctl secrets import --stage`, never on the command line) and deploys. The mechanics (app, region, secrets, custom domain, smoke tests) are documented in `DEPLOY.md`. The chat limiter, the login throttle and logout revocation are in memory per process, which fits this one-machine deployment.
- Continuous deployment: `.github/workflows/deploy.yml` runs on every push to `main` that changes `knowledge/`, `backend/`, `frontend/`, the `Dockerfile`, `.dockerignore`, `scripts/fly.toml` or the workflow. It runs the backend pytest suite (without secrets; the connectivity check stays local) and the frontend typecheck + build, and only if both pass runs `flyctl deploy --remote-only` with the repository secret `FLY_API_TOKEN`. `scripts/fly.toml` uses `strategy = "bluegreen"`, so traffic moves to a new version only once its health check passes. `scripts/deploy.sh` remains the manual path.
- Database keep-alive: Supabase pauses free-plan projects after about a week without activity, and the Fly health check never touches the database, so the app pings the `messages` table (a one-row select) 60 seconds after startup and then every 12 hours. A failed ping is logged as a warning and never stops the app.
- Embedding the app in the owner's own website (e.g. a WordPress page) via an `<iframe>` is optional future work: that website is not live yet and no custom domain is configured. The app stands on its own at `https://avatar-sergei.fly.dev`. Notes for the embed:
  - The visitor page reads `?q=N` from its own URL, so the iframe's `src` can carry it. The host page copies its own `?q=` onto the iframe (server-side in a template/shortcode, or a few lines of JS) so that, e.g., `yourdomain.com/avatar?q=2` answers Q2 inside the iframe. A ready-to-paste embed snippet ships at `scripts/wordpress-embed.html` (full-bleed below the site nav, a content-column max-width override, an overflow-x guard, and the `?q=` passthrough). Its `BASE` constant is `https://avatar-sergei.fly.dev` and its iframe `title` is "Sergei Maslennikov · digital twin"; point `BASE` at the custom subdomain once one exists.
  - The app sets no `X-Frame-Options`/CSP, so it can be framed. If security headers are added later, prefer `Content-Security-Policy: frame-ancestors <host>` over `X-Frame-Options: DENY`.
  - "Keep chat" relies on a `SameSite=Lax` cookie, which a browser treats as third-party inside a cross-site iframe (so persistence may not stick). To keep cookies first-party, serve the app from a subdomain of the host (e.g. `avatar.example.com`) via a fly.io custom domain and embed that. Map the subdomain with a **CNAME** to the Fly hashed target (e.g. `<hash>.<app>.fly.dev`), not A/AAAA records: the app's IPv4 is a *shared* Fly address and a CNAME auto-tracks Fly IP changes. Let's Encrypt then issues the cert. If the host domain is behind a Cloudflare proxy, the record must be DNS-only (grey cloud) plus a `_fly-ownership` TXT record. See `DEPLOY.md`.
- The folder `knowledge/` holds the owner knowledge factored into the system prompt: `knowledge.md` (a rich first-person profile), `style.md` (voice, formatting, language and safety rules), `faq.jsonl` (the numbered FAQ, 16 entries Q1 to Q16; each row has `faq`, a concise `query` for routing, and the full original `question` and `answer`), and `pic.jpg` (the owner's source photo for the avatar images; not read at runtime). Knowledge is loaded once at startup and copied into the image, so an edit takes effect after a backend restart locally, a container rebuild, or a redeploy on Fly.
- Static visitor copy is hand-written in `frontend/index.html`, derived from `knowledge/` but not loaded from it: the meta and OG description, the intro text, the footer links and the three conversation starters (`.chip[data-prompt]` buttons in `#intro`): "What is {{OWNER_FIRST_NAME}}’s educational background?", "What projects have you built?" and "What are {{OWNER_FIRST_NAME}}’s interests, values and lifestyle habits?". Only `{{OWNER_NAME}}` and `{{OWNER_FIRST_NAME}}` are filled in at runtime, so changing the starters or the intro means editing that file.

### The Reference Files

`reference/` keeps the three files the build drew on. They are reference only: no code imports them and they are not copied into the Docker image.

1. `context.py`: the prompt of an earlier single-user Digital Twin, and the source of the contact-capture behaviour (Q&A #10). The Avatar's prompts go further because the conversation is multi-way. It still imports `pypdf` and reads a `linkedin.pdf`; this project uses neither.
2. `next_level.ipynb`: the source of the `faq_tool`, the `Qn` instant-answer shortcut, and the pattern of streaming the reply with tool use shown in a small font. Its Agentic RAG parts (a Qdrant vector database over MCP, built by an `ingest.ipynb` that is not in this repo) are out of scope: per Q&A #3 this project has NO vector DB and NO MCP server.
3. `push.py`: the Pushover call behind `push_tool`. The Avatar uses the tool when the visitor wants to get in touch or asks a question that needs human involvement. If the Avatar can't answer a question, it uses the tool to tell the human and mentions in the chat that it has done that.

## UI

The platform must look great in dark mode and light mode.
The palette is:
- Accent Yellow: `#ecad0a` - accent lines, highlights
- Blue Primary: `#209dd7` - links, key sections
- Purple Secondary: `#753991` - submit buttons, important actions
- Dark Navy: `#032147` - main headings
- Gray Text: `#888888` - supporting text, labels

IMPORTANT: Do not have classic LLM tells like gradients, overuse of purple, and the line on the left of panels.
Do not have a standard Chatbot style.
The look must be sharp, compelling, exciting, modern.
Vector symbols are great where useful; but strictly no emojis.

Both the visitor chat and the admin dashboard must look and work great on mobile as well as desktop (responsive layouts), in dark and light mode.

Ensure that the chat message field takes focus for the user when they bring up the page, and that it regains focus after sending a message (by clicking or by hitting enter).

The owner's photo (from `knowledge/pic.jpg`, shipped as `avatar-human.png`) is the Avatar icon for the Human, and a robotic version of it (`avatar-robot.png`, `avatar-robot-round.png`) is the Avatar icon for the Avatar, looking like a Digital Twin of the human. The images are served from `frontend/public/` and are byte-identical to `design-system/assets/`.

## Design System

The visual and interaction system is in the `design-system/` directory (produced by the sister product Claude Design). It pairs with this SPEC. The split is explicit: **SPEC.md governs behaviour and the backend; `design-system/` governs look and feel.** When the two disagree, SPEC wins on behaviour, the design system wins on appearance.

### Structure of `design-system/`

- **`Avatar Design System.html`** - the navigable design-system document (it dogfoods its own tokens). Open this rendered first.
- **`SKILL.md`** - the front-end build brief the UI was built from, plus an acceptance checklist.
- **`README.md`** - overview and contents table.
- **`tokens.css`** - single source of truth: brand palette, type scale, spacing, radii, motion, and full **dark** (the hero) and **light** themes, switched via `[data-theme="dark"|"light"]` on `<html>`. Role colours are baked in: visitor = blue, avatar (twin) = cyan, human = yellow.
- **`components.css`** - build-ready component classes shared by the mockups and the doc: buttons, fields, the Keep-chat switch, badges, the three message bubbles, tool-status lines, the `Qn` instant-tag, the composer, inbox rows, and avatars. Depends on `tokens.css`.
- **`icons.svg`** - icon sprite, used as `<use href="icons.svg#i-...">`; icons inherit `currentColor`.
- **`doc.css`** - styles for the doc page only (NOT product code).
- **`assets/`** - `avatar-human.png` (the owner's real photo), `avatar-robot.png` (synthetic twin, square with HUD frame), `avatar-robot-round.png` (twin tuned for circular chat avatars).
- **`mockups/`** - hi-fi reference screens `Visitor Chat.html` and `Admin Dashboard.html` (both with a dark/light toggle). These are the literal build targets.
- **`docs/`** - `ux-flows.md` (every interaction contract plus a states matrix to design and test against), `components.md` (component-by-component class reference), `avatar-generation.md` (the recipe that produced the twin image from the owner's photo), `background-texture.md` (the `--grid-mark` background texture variants; this build uses "rings").

### Design language

Dark-first, navy-tinted surfaces; editorial serif **Newsreader** (display) + crisp grotesque **Hanken Grotesk** (UI) + **JetBrains Mono** (technical layer); **blue-led** identity with **yellow as the "spark" reserved for the human-in-the-loop**, and **purple locked to primary actions only**. No gradients in chrome, no purple wash, no left-edge accent bars, no emoji. This matches the SPEC palette and the "not a generic chatbot" mandate.

### How the frontend uses it

The frontend is vanilla TypeScript + Vite. `frontend/src/styles/` holds `tokens.css` and `components.css` from the design system, loaded as `tokens.css` -> `components.css` -> page CSS; `icons.svg` and the avatar PNGs are in `frontend/public/`; the Google Fonts (Newsreader, Hanken Grotesk, JetBrains Mono) are imported. The two screens compose the component classes and follow the mockups, which are the tie-breaker for any visual ambiguity. The default theme is dark, persisted in `localStorage['avatar-theme']` and shared by the visitor and admin pages. Do not invent new colours - derive from tokens.

### Notes

- The design system says "no left-edge accent bars," yet `.convo-item.is-active::before` in `components.css` draws a small left bar on the *active admin inbox row*. This is acceptable: that rule is about message/content panels (and is honoured on the human bubble); the inbox bar is a selection indicator. Follow the mockups.
- The design-system docs and mockups describe the human bubble as anonymous (photo, no name). SPEC overrides this on behaviour: the visitor sees the owner's name on it, `<OWNER_NAME> · live` (Q&A #4 and #11); in admin the owner's own messages read "You · sent to visitor".
- The PNGs in `design-system/assets/` were generated from this owner's `knowledge/pic.jpg` and are the source of truth for the avatar images; use them as they are rather than re-deriving them.
- **Owner:** this site belongs to **Sergei Maslennikov** (LLM engineer / AI practitioner, Tallinn, Estonia).
  - `knowledge/knowledge.md`, `style.md` and `faq.jsonl` are his. All static UI copy (intro screen, conversation starters, meta description) is derived from them and describes only him.
  - **Footer social links** (`frontend/index.html`): LinkedIn `https://www.linkedin.com/in/sergei-maslennikov-ai`, GitHub `https://github.com/Neuromediator`, Hugging Face `https://huggingface.co/Neuromediator`. There is **no YouTube link** - do not add one.
  - The owner's name comes from the `OWNER_NAME` env var (`Sergei Maslennikov`) and is shown in the UI: the page title `<OWNER_NAME> · Avatar`, the brand subtitle `<OWNER_NAME> · digital twin`, and the human bubble `<OWNER_NAME> · live`. It must always be read from that config and never hardcoded in code (per Q&A #4 and #11).

## Testing

Testing is absolutely crucial for the success of this project. It has three layers, each with a comprehensive test plan in `test/` whose checkboxes are all checked off:

1. The backend is tested thoroughly with comprehensive unit tests, including tests that the admin API routes are only available when logged in. Plan: `test/backend_test_plan.md`.
2. The frontend is tested rigorously with Playwright (desktop and mobile), taking multiple screenshots and checking everything in significant detail. Plan: `test/frontend_test_plan.md`.
3. The Docker container is built by the start script and everything is tested end to end, very comprehensively, including three-way conversations. Plan: `test/e2e_test_plan.md`, which also records the production smoke test on Fly.

`test/README.md` is the index: recorded results and the sequence to re-run each layer.

It's good to use the model and Pushover as part of testing, with the model set to `openai/gpt-5.4-nano` to reduce costs (`MODEL_OVERRIDE=openai/gpt-5.4-nano` for the container; the real-LLM backend tests run with `-m llm`). It's fine to call the LLM for tests and to write test conversations in the Supabase database; the OpenRouter key has sensible rate limits.

When testing is complete, delete the screenshots and the test conversation threads in Supabase, and check off those items in the test plans.

## Setup and Validation

Before running or developing the app, the environment must be set up and validated:

1. **Follow the README setup instructions.** The "Setup instructions" section in `README.md` covers obtaining an OpenRouter API key, creating the Supabase project and `messages` table, and putting all required keys into `.env` (`OPENROUTER_API_KEY`, `MODEL`, `OWNER_NAME`, `ADMIN_PASSWORD`, `PUSHOVER_USER`, `PUSHOVER_TOKEN`, `SUPABASE_URL`, `SUPABASE_KEY`), plus the optional `SESSION_SECRET` (signs the admin session cookie; defaults to `avatar::<ADMIN_PASSWORD>` if unset, so set an explicit value for production) and `COOKIE_SECURE` (set to `1` in production so the session cookie is `Secure` over HTTPS; unset/0 for local http). On Fly, `scripts/deploy.sh` imports the nine secrets from `.env` and `scripts/fly.toml` sets `COOKIE_SECURE`. `KNOWLEDGE_DIR` and `STATIC_DIR` default to the repo's `knowledge/` and `frontend/dist` (the Dockerfile sets them for the container), and `FLY_APP_NAME` is set by Fly itself.

2. **Run the connectivity test to validate.** After the README steps are complete, run the Supabase connectivity test to confirm the credentials work and the `messages` table is reachable and writable:

   ```
   cd backend && uv run pytest tests/test_supabase_connection.py -v
   ```

   All tests must pass before proceeding. This validates that the `.env` values are correct and that the Data API, table, and grants are configured as expected.

## Success Criteria

The project is successful when the script builds the container, the application runs end to end, and full testing passes with the visitor, the Avatar and the human participating (and multiple visitors with different conversation_ids), with multiple screenshots and the tests fully documented in the `test/` folder. These criteria were met for the build and for the Fly deployment (`test/e2e_test_plan.md`); changes to behaviour are verified to the same standard.

## Questions and Answers

Decisions agreed before the build. They still hold, and code comments cite them by number.

1. **Supabase.** The Supabase project is in region eu-west-1 (Ireland). The `messages` table, its indexes and grants are set up per the README, and `backend/tests/test_supabase_connection.py` validates the `.env` credentials.

2. **Model.** The model name is read from the `MODEL` env var (OpenRouter `openai/...` prefix). `openai/gpt-5.4-nano` is the cheap default for development and testing (and the code default in `config.py`); production runs `openai/gpt-5.6-luna`. Changing it needs no code change.

3. **Knowledge / RAG.** No vector DB. The system prompt is composed from `knowledge/knowledge.md` (a rich first-person profile of the owner) and `knowledge/style.md` (the owner's voice plus formatting, language and safety rules), together with the numbered `faq.jsonl`. Each FAQ row carries a concise `query` (these short phrasings are listed in the prompt so the model can route a visitor's question to a number) alongside the full original `question` and `answer`; both the `faq_tool` and the `Qn` instant-answer shortcut return the full original question and answer.

4. **Human-in-the-loop semantics.** When the human posts from admin, the Avatar does NOT react to it. The human's message is inserted into the thread; the full conversation (including it) is provided to the Avatar the next time the visitor submits something. To the visitor, the human's message renders as a separate bubble using the profile pic, distinguished by image + yellow ring + tint + glow (per the design system).

   **Owner name.** The owner's name comes from the `OWNER_NAME` env var (see #11) and IS shown in the UI, including on the human's bubble (`<OWNER_NAME> · live`, e.g. "Sergei Maslennikov · live") to avoid an awkward anonymous bubble. The name must always be read from `OWNER_NAME` config and NEVER hardcoded.

5. **Needs-human + read/unread state.** Persisted as fields on each message row: a `needs_attention` flag (set on the Avatar's row of a turn where `push_tool` fired, or on the fallback row when that turn failed) and a `read` marker (visitor and Avatar rows start unread; the owner's rows are stored read). Opening the thread in admin marks every row read and clears `needs_attention`; `POST /admin/api/conversations/{id}/resolve` (the thread's Mark resolved button) clears `needs_attention` only.

6. **Admin auth.** `POST /admin/login` with `ADMIN_PASSWORD` returns a signed session token (httpOnly cookie, 7 days, revoked by `POST /admin/logout`) guarding every `/admin/api/*` route. `/admin/login`, `/admin/logout` and the `/admin` page itself are open; the page shows a sign-in gate. Failed sign-ins are throttled (see Implementation Decisions). Visitors stay anonymous, addressed only by an unguessable `conversation_id` UUID held in their cookie (possession of the id = access to that thread).

7. **Avatar's robotic icon.** Both images ship in `design-system/assets/`, generated from this owner's `knowledge/pic.jpg`, and are copied unchanged to `frontend/public/`: `avatar-human.png` is the human icon, `avatar-robot.png` / `avatar-robot-round.png` are the Avatar icons. They are not regenerated.

8. **Frontend.** Vanilla TypeScript with Vite; no React/Vue framework.

9. **Streaming vs polling.** The Avatar's reply streams to the active visitor via SSE (showing tool use in small font): `start`, then `instant` (Qn only), `delta`, `tool_called` and `tool_output` events, then exactly one `done` or `error`. The tool's output text is not streamed. The 10s/60s poll is only for picking up the human's async messages (and a reply whose stream was interrupted).

10. **Contact capture.** Keep the behavior from `context.py`: when a visitor wants to get in touch, the twin asks for their email and pushes it to the human via Pushover.

11. **Owner name configuration.** `OWNER_NAME` in `.env` holds the name of the person the twin represents. It is shown in the site header/subtitle, the page title, how the Avatar refers to itself, and on the human's messages when the owner joins from admin (`<OWNER_NAME> · live`). Always sourced from config, never hardcoded.

12. **Abuse guards.** Two cheap protections for the OpenRouter key are enforced in the backend, with no configuration: (a) a visitor message longer than 20,000 characters is truncated to 20,000 and a note is appended before it is stored or sent to the LLM; (b) each `conversation_id` is limited to 20 chat messages per minute (a moving-window limiter from the `limits` package, in-memory per process), returning HTTP 429 before any LLM call. No overall/global chat limit is added because OpenRouter already caps total spend. Two further guards, also without configuration, protect the server: request bodies over 512 KiB return HTTP 413, and failed admin sign-ins are throttled at 10 per minute and 50 per hour per client (see Implementation Decisions).
