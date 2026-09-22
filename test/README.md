# Tests

SPEC "Testing" asks for three layers of testing, each with a written plan whose checkboxes are
ticked only once the item has actually been run and passed. The plans live in this folder:

| Plan | Layer | Suite |
|---|---|---|
| [`backend_test_plan.md`](backend_test_plan.md) | FastAPI backend: config, knowledge, prompts, Agents SDK wiring, SSE chat, abuse guards, public and admin APIs (every admin route refused without a valid session), static serving, real Supabase, real LLM, the fly.io deployment files | `backend/tests/` (pytest, 418 tests) |
| [`frontend_test_plan.md`](frontend_test_plan.md) | Visitor chat and admin dashboard in a real browser: focus, streaming, `Qn` and `?q=N`, Keep chat and Reset, polling, owner messages, inbox and keyboard use, dark and light, desktop, tablet and phone widths, the WordPress embed, with screenshots | `frontend/e2e/` (Playwright, 90 tests in the `desktop` and `mobile` projects) |
| [`e2e_test_plan.md`](e2e_test_plan.md) | The single Docker container built and run by `scripts/start_mac.sh`, tested end to end: the whole Playwright suite, visitor, Avatar and owner in several conversations at once, persistence across a restart, abuse guards, logs, deployment files | Docker + Playwright (the whole suite, 95 tests; the `three-way` project's 5 tests are the end-to-end specs) against the container, plus the start/stop scripts on macOS/Linux and Windows |

Each plan records its run log, the evidence (conversation ids, timings, screenshots), the bugs the
testing found and how they were fixed, and anything left open with the reason. Each plan starts with
a **"Final run"** section: the last full run on the final code (2026-09-22), with the exact commands
and counts. Final results: backend 410 passed, 8 skipped (+ 8/8 real-LLM, 3/3 connectivity);
Playwright 94 passed, 0 failed, 1 skipped by design (95 tests) against the container; restart check
1/1; Windows scripts run under Windows PowerShell 5.1.

## Re-run everything (the final-run sequence)

From the repo root, after the setup below. It sends 2 real Pushover notifications (A-O1 and TEST
Chen) and writes `TEST ...` conversations to Supabase.

```bash
# 1. Build the frontend; backend suites
(cd frontend && npm install && npx playwright install chromium && npm run build && npm run test:e2e:typecheck)
(cd backend && uv run pytest -q)                                      # 410 passed, 8 skipped
(cd backend && uv run pytest tests/test_supabase_connection.py -v)    # 3 passed
(cd backend && MODEL=openai/gpt-5.4-nano uv run pytest -m llm -q)     # 8 passed

# 2. Container (port 8000 must be free), then the WHOLE Playwright suite against it:
#    desktop + mobile (90 frontend tests) + three-way (multi-party scenario, guards; restart skipped)
MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh
(cd frontend && BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e npx playwright test)

# 3. Persistence across a restart (reads the state the three-way spec saved), then clean up
./scripts/stop_mac.sh && MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh
(cd frontend && AVATAR_AFTER_RESTART=1 BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e \
  npx playwright test --project=three-way restart)
rm -f /tmp/avatar-three-way-state.json    # holds an admin session cookie

# 4. Stop (safe to repeat); nothing should be left on port 8000
./scripts/stop_mac.sh
```

Windows: run `scripts\start_pc.ps1` / `scripts\stop_pc.ps1` in PowerShell (set
`$env:MODEL_OVERRIDE = 'openai/gpt-5.4-nano'` first). From WSL, the same scripts can be run on the
Windows side through interop:

```bash
MODEL_OVERRIDE=openai/gpt-5.4-nano WSLENV=MODEL_OVERRIDE powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$(wslpath -w scripts/start_pc.ps1)"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w scripts/stop_pc.ps1)"
```

The sections below explain each layer in more detail.

## Before you run anything

Follow the "Setup instructions" in the root `README.md` (OpenRouter key, Supabase project and
`messages` table, `.env`), then validate the database (SPEC "Setup and Validation"):

```bash
cd backend && uv run pytest tests/test_supabase_connection.py -v
```

All three tests must pass.

**Always test with the cheap model.** `.env` holds the production `MODEL`; override it for every
test run: `MODEL=openai/gpt-5.4-nano` for local processes (the environment beats `.env`), and
`MODEL_OVERRIDE=openai/gpt-5.4-nano` for `scripts/start_mac.sh`.

## Backend (pytest)

```bash
cd backend
uv run pytest -q                                   # fast, deterministic suite (no LLM calls)
MODEL=openai/gpt-5.4-nano uv run pytest -m llm -q  # real LLM tests via OpenRouter
```

- The fast suite uses an in-memory repository, a scripted fake of the Agents SDK stream and a
  recorder for Pushover. It also runs the real-Supabase integration tests when `.env` has
  credentials (they skip otherwise); those delete exactly the rows they create.
- Pushover is mocked in every backend test, including the LLM ones; a real request fails the test.
- `llm` tests are skipped unless selected with `-m llm`. They always use `openai/gpt-5.4-nano`.
  Run them twice to spot flakiness. Add `SUPABASE_URL= SUPABASE_KEY=` to run them on the
  in-memory repository (nothing written to Supabase).
- `tests/test_deploy_config.py` checks `scripts/fly.toml`, `scripts/deploy.sh` (`bash -n` only) and
  `scripts/wordpress-embed.html`; it never deploys.

## Frontend (Playwright)

```bash
cd frontend && npm install && npx playwright install chromium
npm run build
(cd ../backend && MODEL=openai/gpt-5.4-nano uv run uvicorn app.main:app --app-dir . --port 8100) &
BASE_URL=http://localhost:8100 npm run test:e2e        # = --project=desktop --project=mobile
npm run test:e2e:typecheck                             # the suite type-checks
```

Projects (see `frontend/playwright.config.ts`):

- `desktop` (Chromium 1440x900; responsive tests resize down to 360 px) runs every spec except
  `*.mobile.spec.ts` and `*.e2e.spec.ts`;
- `mobile` (390x844, DPR 2, touch) runs the `*.mobile.spec.ts` files;
- `three-way` runs the `*.e2e.spec.ts` files, the Docker end-to-end specs (below). They are not
  part of `npm run test:e2e`.

One test (`admin-push.spec.ts`, A-O1) sends a real Pushover notification; add
`--grep-invert "A-O1"` to skip it.

## Docker end to end

The concrete sequence from [`e2e_test_plan.md`](e2e_test_plan.md) ("How to run"):

```bash
# 1. Build and start (stops a running container first, rebuilds, waits for health)
HOST_PORT=8000 MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh

# 2. The frontend suite, then the multi-party scenario and the abuse guards, against the container
cd frontend
BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e npx playwright test --project=desktop --project=mobile
BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e npm run test:e2e:three-way   # three-way + guards (restart is skipped here)

# 3. Persistence: restart the container, then run the restart check (reads what three-way saved)
cd .. && ./scripts/stop_mac.sh && MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh
cd frontend && AVATAR_AFTER_RESTART=1 BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e \
  npx playwright test --project=three-way restart
rm -f /tmp/avatar-three-way-state.json   # it holds an admin session cookie (path: os.tmpdir())

# 4. Stop (safe to repeat)
cd .. && ./scripts/stop_mac.sh
```

`npx playwright test` with no `--project` runs all three projects in one go (95 tests; this is what
the final run used). The scenario sends one real Pushover notification per run (TEST Chen's contact
request), the frontend suite one more (A-O1). Windows: `scripts/start_pc.ps1` / `scripts/stop_pc.ps1`
(see "Re-run everything" for running them from WSL).

## Screenshots

Screenshots are written under `test/screenshots/`, one folder per suite:

- `test/screenshots/frontend/` - Playwright specs against a local server (`<project>-<name>.png`, e.g.
  `desktop-visitor-deeplink-q2.png`; override with `SCREENSHOT_DIR`)
- `test/screenshots/e2e/` - the Docker end-to-end run: the same suite's shots re-taken against the
  container, plus `three-way-*` (the multi-party scenario and the restart check)

The backend suite takes no screenshots.

## Test data and cleanup policy

- Test conversations may be written to the real Supabase project. Every test uses a fresh
  `conversation_id` (uuid4), and visitors are named `TEST ...` wherever a name is entered, so test
  threads are easy to find in the admin inbox and in the table.
- The automated backend tests that write to Supabase delete exactly the conversation they
  created, and nothing else. Browser and end-to-end runs leave their threads in place for review.
- Real Pushover notifications are allowed in the browser and Docker runs, but keep them to a
  handful; the backend suite never sends one.
- When all testing is complete, and only then, the screenshots are deleted and the test
  conversation threads are removed from Supabase. These are the last two items of every plan and
  stay unticked until that final cleanup is done.
