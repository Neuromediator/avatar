# End-to-End Test Plan (Docker container)

SPEC.md, Testing #3: "Build the Docker container and test everything end to end; very
comprehensively." SPEC "Success Criteria": "run the script to build the container, then run the
application end-to-end, carry out full testing with the user, avatar and human participating (and
multiple users with different conversation_ids). The tests should include multiple screenshots."

This plan covers:
- the single container built and run by `scripts/start_mac.sh` (and the Windows twins, as far as
  they can be exercised on this machine);
- the whole Playwright suite run against that container;
- a scripted multi-party scenario: three visitors, the Avatar and the owner, at the same time;
- persistence across a container restart;
- database-level checks, the abuse guards, a real Pushover notification and the container logs;
- the fly.io deployment files and the optional WordPress embed snippet (section D; the deploy
  itself is not run in this phase).

An item is ticked only after it was executed and passed (2026-09-22, against the container on
`http://localhost:8000` with `MODEL_OVERRIDE=openai/gpt-5.4-nano`). Items that could not be
executed are left unticked, with the reason.

**Final build re-verified (2026-09-22, runs 16-23 below).** The visual-QA polish (03:11-03:22
local) and the gap-closing pass changed the frontend, the e2e specs and `backend/app/agent.py`
after runs 1-15. The image was rebuilt with `start_mac.sh` from the final working tree (C8
re-checked byte for byte), and the whole suite (90 tests), the multi-party scenario, the guards and
the restart check were run against it. Every ticked item below holds for that final image.

**Final run (2026-09-22, runs 24-32 below).** The last full run on the final code: a fresh
`start_mac.sh` build (image verified identical to the working tree), the whole Playwright suite in
one command (95 tests: **94 passed, 0 failed, 1 skipped** by design), the restart check, log scans,
and a first real run of the Windows scripts under Windows PowerShell 5.1 with Docker Desktop, which
found and fixed bug 5 (`start_pc.ps1`). Every ticked item below passed in, or was re-verified by,
the final run unless its text says otherwise.

## How to run

```bash
# 1. Build and start (stops a running container first, rebuilds, waits for health)
HOST_PORT=8000 MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh

# 2. The whole Playwright suite against the container (frontend suite + Docker end-to-end specs)
cd frontend
BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e npx playwright test
#    or separately:
BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e npm run test:e2e            # 90 frontend tests (desktop + mobile)
BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e npm run test:e2e:three-way  # multi-party + guards

# 3. Persistence: restart the container, then run the restart check (reads what three-way saved)
cd .. && ./scripts/stop_mac.sh && MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh
cd frontend && AVATAR_AFTER_RESTART=1 BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e \
  npx playwright test --project=three-way restart
rm -f /tmp/avatar-three-way-state.json   # holds an admin session cookie (os.tmpdir(); THREE_WAY_STATE_FILE overrides)

# 4. Stop (safe to repeat)
cd .. && ./scripts/stop_mac.sh && ./scripts/stop_mac.sh
```

Specs added for this plan (Playwright project `three-way`, files `frontend/e2e/*.e2e.spec.ts`):

| Spec | What it does | Real LLM / Pushover |
|---|---|---|
| `three-way.e2e.spec.ts` | Multi-party scenario (section MP), 13 steps, 20 screenshots, database checks | nano (3 replies); 1 real push |
| `guards.e2e.spec.ts` | Abuse guards with database checks (section AG) | 1 nano reply (the clamped message); no push |
| `restart.e2e.spec.ts` | Persistence after a container restart (section RS), 5 screenshots. Skipped unless `AVATAR_AFTER_RESTART=1` | none |

`frontend/e2e/embed.spec.ts` (desktop project, one of the 90) checks the WordPress embed snippet
against the server under test (section D). `backend/tests/test_deploy_config.py` checks the fly.io
files (section D).

Support added: `e2e/support/supabase.ts` (read-only SELECTs on `messages` through Supabase's REST
API; it never writes or deletes), `e2e/support/three-way-state.ts` (conversation ids and browser
storage handed from `three-way` to `restart`, kept in the OS temp dir with mode 0600 because it holds
an admin session cookie; delete it after the restart check), `watchPage()` in
`e2e/support/fixtures.ts` (console and page-error guard for every extra page), and `envValue()` in
`e2e/support/env.ts`.

Visitor names all start with `TEST`: "TEST Alice", "TEST Bob", "TEST Chen", "TEST Guard ...",
"TEST LangProbe ...". Hyphenated names such as "TEST-Alice" would all show the initials "TE", so
the space form gives distinct tokens TA, TB and TC.

## Final run (2026-09-22, 04:40-04:56 UTC)

```bash
# ports 8000/8081/8100 free, no avatar container
MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh                       # build (cached layers), start, health
cd frontend && BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e npx playwright test
cd .. && ./scripts/stop_mac.sh && MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh
cd frontend && AVATAR_AFTER_RESTART=1 BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e \
  npx playwright test --project=three-way restart
rm -f /tmp/avatar-three-way-state.json
cd .. && ./scripts/stop_mac.sh && ./scripts/stop_mac.sh
# Windows PowerShell 5.1 + Docker Desktop, from WSL (interop); MODEL_OVERRIDE passed through WSLENV
MODEL_OVERRIDE=openai/gpt-5.4-nano WSLENV=MODEL_OVERRIDE powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File '\\wsl.localhost\Ubuntu-24.04\home\kasutaja\projects\avatar\scripts\start_pc.ps1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '\\wsl.localhost\...\scripts\stop_pc.ps1'   # x2
```

| Suite | Result |
|---|---|
| Whole Playwright suite (`npx playwright test`, all three projects) | **94 passed, 0 failed, 1 skipped** (95 tests, 2.3 min): `desktop` 79/79, `mobile` 11/11, `three-way` 4 passed + restart skipped (by design) |
| Restart check after `stop_mac.sh` + `start_mac.sh` | **1/1 passed** (15.5 s; container id 666a567c2f5b -> 5b53ba09037e) |
| Image vs working tree (C8) | identical: 9 `backend/app/*.py`, 13 files in `frontend/dist/`, `knowledge/` |
| Container logs (L) | first container 1,178 lines, restarted container 48 lines: 0 tracebacks, 0 ERROR, 0 WARNING, 0 secret values, 0 email addresses |
| Windows scripts (PS6) | `start_pc.ps1` failed on the first try (bug 5), fixed; then start (no container), start over a running container, `stop_pc.ps1` x2 and `HOST_PORT=abc` all behaved as specified |
| Real Pushover notifications | 2 (A-O1 and TEST Chen), both delivered |

## Run log

| # | When (UTC) | What | Result |
|---|---|---|---|
| 1 | 23:03 | `start_mac.sh` over a running container (stop, rebuild, health) | ok, 8 s (cached layers; image contents verified identical to the working tree) |
| 2 | 23:04 | `docker build --no-cache` (separate tag, removed afterwards) | ok, 11 s (base images cached locally) |
| 3 | 23:06 | Full Playwright suite (74) against the container | **73/74**: A-L4 got HTTP 500 from Supabase PGRST303 -> bug 1, fixed |
| 4 | 23:12 | Rebuild via `start_mac.sh`; full suite again | **74/74** (68 s) |
| 5 | 23:15 | `three-way` scenario, run 1 | **passed** (47 s); 2 real pushes (the follow-up also pushed, see Observations) |
| 6 | 23:17 | `stop_mac.sh` x2, `start_mac.sh`, restart check | **passed** (15 s) |
| 7 | 23:20 | `guards` x2 | **3/3**, **3/3** |
| 8 | 23:21 | PowerShell: parse check, PSScriptAnalyzer, run under pwsh 7 | see section PS |
| 9 | 23:24 | Full suite without the push test + `three-way` (run 2) + `guards` | **76 passed, 1 failed, 1 skipped**: V-I2 got a Russian reply to an English question -> bug 2 |
| 10 | 23:28-23:38 | Language probes (in-process app, in-memory DB, no push; 1,500+ nano replies) | root cause found; fix chosen by A/B (see Bugs) |
| 11 | 23:39 | Rebuild via `start_mac.sh` with the fix | ok, 6 s |
| 12 | 23:40 | Full suite without the push test + `three-way` (run 3) + `guards` | **76 passed, 1 failed, 1 skipped**: V-I2 again (residual rate, see Bugs); V-I2 then **4/4** on repeat |
| 13 | 23:44 | `stop_mac.sh` + `start_mac.sh`, restart check on run 3's state | **passed** |
| 14 | 23:47 | `three-way` run 4 on a container with the Pushover credentials blanked (verifies the last spec edits; exercises the "push not delivered" path) | **passed** (40 s), no real push |
| 15 | 23:49 | Restart check on run 4's state; `stop_mac.sh` x2 | **passed**; nothing left running |
| | | *Runs 16-23: the final build (after the visual-QA polish and the gap-closing pass), 2026-09-22 UTC* | |
| 16 | 04:29 | `HOST_PORT=8000 MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh` (no container present: build, start, health) | ok, 7 s; `MODEL=openai/gpt-5.4-nano` in the container |
| 17 | 04:29 | C8 re-check: sha256 of `backend/app/*.py` (9 files) and `frontend/dist/**` (13 files) in the image vs the working tree | **identical** (the image has the new `agent.py`) |
| 18 | 04:29 | Full suite, `--project=desktop --project=mobile` (90 tests, includes A-O1 with 1 real push) | **89/90** (102 s): V-I2 got a Russian reply to the English question again (residual of bug 2, see Observations). A-O1 passed, push delivered |
| 19 | 04:31 | V-I2 `--repeat-each=5` | **5/5** |
| 20 | 04:32 | Full suite again without A-O1 (89 tests, no push) | **89/89** (99 s) |
| 21 | 04:34 | `npm run test:e2e:three-way` (three-way run 5 + guards) | **4 passed, 1 skipped** (restart, by design), 42 s; 1 real push, delivered |
| 22 | 04:35 | `stop_mac.sh` + `start_mac.sh` (new container id), `AVATAR_AFTER_RESTART=1 ... restart` | **passed** (16 s); state file deleted afterwards |
| 23 | 04:36 | `guards` on the restarted container, log scan, `stop_mac.sh` x2 | **3/3**; logs clean (L); no container, ports 8000/8081/8100 free |
| | | *Runs 24-32: the final run on the final code, 2026-09-22 UTC* | |
| 24 | 04:44 | Port 8000 free; `MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh` (no container present) | ok (cached layers); `MODEL=openai/gpt-5.4-nano`, healthy, `uid=10001(app)` |
| 25 | 04:45 | C8: `docker cp` of `backend/app`, `frontend/dist`, `knowledge` diffed against the working tree | **identical** |
| 26 | 04:45 | Whole Playwright suite: `BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e npx playwright test` | **94 passed, 1 skipped, 0 failed** (2.3 min). Includes A-O1 (push delivered), three-way run 6 (push delivered) and guards |
| 27 | 04:48 | Log scan of that container | 1,178 lines; 0 tracebacks / ERROR / WARNING; statuses 200 (1,130), 201 (12), 401 (21), 404 (1), 413 (2), 422 (1), 429 (3) |
| 28 | 04:48 | `stop_mac.sh` + `start_mac.sh` (new container id), `AVATAR_AFTER_RESTART=1 ... restart` | **passed** (15.5 s); state file deleted |
| 29 | 04:49 | Log scan of the restarted container; `stop_mac.sh` x2 | 48 lines, all 200, nothing else; second stop "Nothing to stop"; ports free |
| 30 | 04:50 | `start_pc.ps1` under Windows PowerShell 5.1.26100 (Docker Desktop 29.6.2) from the WSL checkout | **failed**: docker got `Microsoft.PowerShell.Core\FileSystem::\\wsl.localhost\...\scripts\..` -> bug 5, fixed |
| 31 | 04:51 | `start_pc.ps1` again (no container), then over the running container | **ok** both (15 s; "Stopping the existing 'avatar' container..." the second time, new id). Container: `MODEL=openai/gpt-5.4-nano`, `PORT=8000`, `StopTimeout=70`, user 10001, healthy, no `.env`, code identical to the tree; `Q2` smoke answered instantly |
| 32 | 04:53 | `stop_pc.ps1` x2, `HOST_PORT=abc start_pc.ps1`; backend suite re-run | stopped, then "Nothing to stop" (exit 0 both); "HOST_PORT must be a number", exit 1; backend **410 passed, 8 skipped**. No container, ports 8000/8081/8100 free |

Totals across runs 3, 4, 9 and 12: 74 + 74 + 77 + 77 frontend/e2e tests executed against the
container. Failures: 1 caused by bug 1, 2 caused by bug 2; both bugs fixed. Runs 18, 20, 21 and 23
on the final image: 90 + 89 + 5 + 3 more (1 failure: the bug 2 residual in V-I2, which passed 5/5
on repeat and in run 20). Final run (runs 26 and 28): 95 + 1 more, 0 failures. Real Pushover
notifications sent by this plan: 10 (the frontend suite's push test in runs 3, 4, 18 and 26; Chen in
`three-way` runs 1, 2, 3, 5 and 26, plus the extra follow-up push in run 1). All ten reported
delivered.

---

## B. Build and scripts (SPEC "Tech stack decisions": single container, start/stop scripts)

- [x] B1 `scripts/start_mac.sh` with a container already running prints "Stopping the existing 'avatar' container...", removes it, rebuilds the image, starts a new container (new id) and exits 0.
- [x] B2 `start_mac.sh` with no container present skips the stop step, builds, starts and exits 0 (run 6, run 13).
- [x] B3 The start script waits for health (`GET /api/config` 200) before returning, then prints the Visitor, Admin, Model-override, Logs and Stop lines.
- [x] B4 `MODEL_OVERRIDE=openai/gpt-5.4-nano` is honoured: `MODEL=openai/gpt-5.4-nano` inside the container, and the script prints "Model: openai/gpt-5.4-nano (override)".
- [x] B5 Without `MODEL_OVERRIDE`, the container's `MODEL` equals the one in `.env` (checked by comparison, not printed; no chat traffic was sent in that window).
- [x] B6 `HOST_PORT=8081` publishes on 8081 (`/api/config` 200 on 8081, 8000 refused, `docker port` shows `8000/tcp -> 0.0.0.0:8081`).
- [x] B7 Invalid input is refused before anything is stopped: `HOST_PORT=abc` -> "HOST_PORT must be a number", exit 1; `HEALTH_TIMEOUT=x` -> exit 1.
- [x] B8 The Dockerfile builds from scratch (`--no-cache`, rc 0) and with the legacy builder (no buildx, run PS3). Warnings seen: only the benign `useradd` uid > SYS_UID_MAX note and the legacy-builder deprecation notice.
- [x] B9 `scripts/stop_mac.sh` stops and removes a running container (1.4 s when idle; the 70 s grace only matters for in-flight replies), exit 0.
- [x] B10 `stop_mac.sh` is idempotent: a second run prints "No 'avatar' container found. Nothing to stop." and exits 0 (checked 3 times).
- [x] B11 After the final stop, no `avatar` container exists and ports 8000, 8081 and 8100 are free.

## C. Container facts (SPEC "Implementation Decisions", `DEPLOY.md`)

- [x] C1 Runs as an unprivileged user: `id` -> `uid=10001(app) gid=10001(app)`; image `Config.User=10001:10001`; uvicorn is PID 1 (it receives SIGTERM); `StopTimeout=70`.
- [x] C2 The healthcheck passes: `State.Health.Status=healthy`, RestartCount 0.
- [x] C3 No `.env` in the image: no `/app/.env`, no `/app/backend/.env`; `.dockerignore` excludes `.env`, `.env.*`, `**/.env*`.
- [x] C4 No secret values in any image layer, config or history: `docker save avatar` is scanned file by file (12,654 files, 339 MB, nested layer tars included) for the values of OPENROUTER_API_KEY, ADMIN_PASSWORD, PUSHOVER_USER, PUSHOVER_TOKEN, SUPABASE_URL, SUPABASE_KEY and SESSION_SECRET. 0 hits. The scanner was proven to catch a planted value. Only key names are printed.
- [x] C5 The image's baked `ENV` contains only non-secret settings (`KNOWLEDGE_DIR`, `STATIC_DIR`, `PORT`, `PYTHONUNBUFFERED`, `UV_*`, `PATH`). `docker history` holds no secret key names (the only regex match was `os.environ` in the HEALTHCHECK).
- [x] C6 `knowledge/` is present at `/app/knowledge` (`faq.jsonl`, `knowledge.md`, `style.md`, `pic.jpg`).
- [x] C7 No test code, design system, reference or docs in the image (no `/app/backend/tests`; `.dockerignore` excludes them).
- [x] C8 The image's app code and built frontend match the working tree byte for byte (sha256 of `backend/app/*.py` and `frontend/dist/assets/*` compared), after each rebuild that mattered. Re-checked on the final image (run 17): all 9 `backend/app/*.py` files and all 13 files under `frontend/dist/` (pages, PNGs, sprite, hashed assets) identical to the working tree.
- [x] C9 Static serving from the container: `/`, `/index.html`, `/admin`, `/admin/` -> 200 HTML with `{{...}}` placeholders substituted (title "Sergei Maslennikov · Avatar", from `OWNER_NAME`). `/icons.svg`, `/favicon.svg`, the three avatar PNGs and the hashed JS/CSS assets -> 200 with correct types. Unknown path -> 404. `/admin/api/*` signed out -> 401. HTML is `Cache-Control: no-cache`, with no `X-Frame-Options`/CSP (embeddable, per SPEC).

The `Dockerfile`, `.dockerignore`, `start_mac.sh` and `stop_mac.sh` have not changed since runs
1-15, so B1-B11 and C1-C7 carry over to the final image; on it, B2, B3, B4, B9, B10, B11 and C1
(`uid=10001(app)`) were seen again in runs 16-23, and B1 (restart over a running container), B2,
B3, B4, B9, B10, B11, C1, C2 (healthy, RestartCount 0), C3 (no `/app/.env`), C6 and C8 once more in
the final run (runs 24-32).

## PS. Windows scripts (`scripts/start_pc.ps1`, `scripts/stop_pc.ps1`)

pwsh is not installed on this machine, but a local `mcr.microsoft.com/powershell` image (pwsh 7.4.2) was available.
In the final run the scripts were also run for real on Windows: WSL interop reaches
`powershell.exe` (Windows PowerShell 5.1.26100) and Docker Desktop's `docker.exe` (29.6.2), so
PS6 was executed (runs 30-32).

- [x] PS1 Both scripts parse with no errors (`[System.Management.Automation.Language.Parser]::ParseFile`: 0 errors; 775 and 193 tokens).
- [x] PS2 PSScriptAnalyzer 1.22.0: no Error-severity findings. Warnings are style only: Write-Host (right for an interactive console script), two deliberately empty `catch` blocks in the health-poll loop, `Stop-WithError` without ShouldProcess, and plural nouns in helper names. Nothing to change.
- [x] PS3 Real run under pwsh 7 (Linux) against the Docker daemon (socket and static docker CLI mounted, host networking). `start_pc.ps1` stopped the running container, rebuilt (legacy builder), started it with `MODEL_OVERRIDE` honoured (`MODEL=openai/gpt-5.4-nano`), `PORT=8000`, `StopTimeout=70` and port 8000, waited for `/api/config` and printed the URLs. Exit 0, 40 s.
- [x] PS4 `stop_pc.ps1` run twice: first "Stopped and removed 'avatar'.", then "No 'avatar' container found. Nothing to stop.". Both exit 0.
- [x] PS5 Branches: without docker, `stop_pc.ps1` prints "docker was not found..." and exits 0, while `start_pc.ps1` prints "Error: docker was not found..." and exits 1. `HOST_PORT=abc` -> "HOST_PORT must be a number", exit 1, before anything is stopped.
- [x] PS6 Run on Windows (Windows PowerShell 5.1 / Docker Desktop), final run 30-32: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\wsl.localhost\Ubuntu-24.04\home\kasutaja\projects\avatar\scripts\start_pc.ps1` with `MODEL_OVERRIDE=openai/gpt-5.4-nano` (passed through `WSLENV`). The first attempt failed at the build step (bug 5: a provider-qualified UNC path handed to docker); after the fix: with no container it built, started and waited for health, printing the Visitor/Admin/Model-override/Logs/Stop lines (exit 0, 15 s); run again over the running container it printed "Stopping the existing 'avatar' container...", rebuilt and started a new container (exit 0). The container had `MODEL=openai/gpt-5.4-nano`, `PORT=8000`, `StopTimeout=70`, port 8000, user 10001, healthy, no `.env`, and app code and `dist/` identical to the working tree; a `Q2` chat returned `start, instant, delta, done`. `stop_pc.ps1` x2: "Stopped and removed 'avatar'.", then "No 'avatar' container found. Nothing to stop." (exit 0 both). `HOST_PORT=abc`: "Error: HOST_PORT must be a number (got 'abc').", exit 1. The 5.1-specific paths (native stderr with `ErrorActionPreference`, `Invoke-WebRequest -UseBasicParsing`) worked.

## S. The whole Playwright suite against the container (SPEC Testing #2 and #3)

- [x] S1 All 90 frontend tests (desktop 79 + mobile 11) pass against the final image. **Final run (run 26): 90/90 in one run** (A-O1 included, push delivered; V-I2 passed), together with the `three-way` project (4 passed, restart skipped by design): 94 passed, 0 failed, 1 skipped. Before that: run 18 **89/90** (the one failure is the known bug 2 residual in V-I2, which then passed 5/5 in run 19), run 20 **89/89** (all but A-O1, which passed in run 18). This includes the 9 polish regression tests and the 7 tests added by the gap-closing pass (V-G11 in the cadence test, A-L8, A-P7..P9, D-E1, D-E2, three V-K8 phone tests). (Earlier build: 74/74 in run 4.)
- [x] S2 Runs 9 and 12 (the 74 minus the real-push test, plus the e2e specs): 76 passed, 1 failed (V-I2, bug 2), 1 skipped (restart, by design). After the fix V-I2 passed 4/4 on repeat (the residual rate is below).
- [x] S3 The real-push frontend test (`admin-push.spec.ts`, A-O1..O3) passed against the container in runs 3, 4 and 18 (final image, push delivered). It was left out of runs 9, 12 and 20 to limit Pushover notifications.
- [x] S4 The Playwright suite typechecks (`npm run test:e2e:typecheck`) after the new specs and support changes; `npm run test:e2e` lists exactly the 90 frontend tests (15 files) and `--project=three-way` the 5 end-to-end tests (3 files).

## MP. Multi-party scenario (SPEC "Success Criteria"; `three-way.e2e.spec.ts`)

Participants, each in its own browser context: **TEST Alice** (desktop 1440x900, dark), **TEST Bob**
(phone 390x844, touch, light), **TEST Chen** (desktop, light), the **owner** in the admin
dashboard (desktop, dark) and later the owner on a phone. Passed in runs 1, 2, 3 and 4, and in run 5
(run 21) on the final image: Bob's Q2 in 377 ms, Alice's streamed reply (`tool-calling ->
tool-returned -> typing -> complete`, 31 text steps, `faq_tool` Q11) in 4.5 s, Chen's push in the
first turn ("Notified Sergei · push_tool", delivered) in 4.0 s, owner -> Chen 8.0 s, owner -> Alice
9.0 s, Chen's follow-up "He suggested Thursday at 14:00 (Tallinn time) for the call." Chen's first
reply: "Hi Chen. I passed your email (test.chen@example.com) and your request about an AI
engineering job to Sergei. He has been notified and can follow up with you by email."
Passed again in the final run (run 26, three-way run 6, 42 s): Bob's Q2 in 982 ms; Alice's reply
streamed (`tool-calling -> tool-returned -> typing -> complete`, 29 text steps, `faq_tool` Q11) in
4.5 s; Chen's push in the first turn ("Notified Sergei · push_tool", delivered) in 3.9 s, reply
"Hi Chen. I passed your message and email (test.chen@example.com) to Sergei, and the conversation
is flagged for him in the dashboard. He’ll follow up by email."; opening Chen cleared the flag in
the database; owner -> Chen 8.1 s, owner -> Alice 9.1 s; Chen's follow-up "The real Sergei
suggested a call on Thursday at 14:00 Tallinn time." Final DB order: Alice `visitor, avatar, human`;
Bob `visitor, avatar, visitor, avatar` (all unread); Chen `visitor, avatar, human, visitor, avatar`
(all read).

- [x] MP-1 Three contexts get three different conversation ids (the `avatar_cid` cookie, UUID v4). Names are entered and themes set (Bob and Chen light, Alice dark).
- [x] MP-2 Bob taps send on "Q2": instant answer (0.4-0.9 s) with the tag "instant · Q2", the restated "**Q2:** <question>" and no LLM call. His visitor token shows "TB".
- [x] MP-3 Alice and Chen send at the same time (two concurrent SSE streams from different conversations).
  - Alice's reply streams: its bubble is on screen while incomplete (screenshot 02). States went `tool-calling -> tool-returned -> typing -> complete`, and the text grew in 31-61 steps. It shows a done `faq_tool` row ("Looked up the FAQ · Q11"), mentions the Autonomous Trading Floor, and the composer is focused afterwards.
  - Chen's job enquiry with an email triggers `push_tool` in the first turn in all 4 runs. The row "Notified Sergei · push_tool" appears (real Pushover delivered, runs 1-3), and "Flagged for Sergei · push_tool" in run 4 (credentials blanked).
- [x] MP-4 Supabase rows before the owner looks:
  - Alice: `[visitor, avatar]`, with `conversation_name="TEST Alice"` and the exact visitor text. The avatar row's `tool_calls` hold `faq_tool` with `question_number` (11, sometimes also 1) and the stored output.
  - Bob: `tool_calls=[{"type":"instant","faq":2}]`.
  - Chen: the avatar row has `push_tool` in `tool_calls`, the push arguments contain the visitor's email, and `needs_attention=true`.
  - Every row has `read=false`; Alice's and Bob's rows have `needs_attention=false`.
- [x] MP-5 Bob opens `/?q=5` in a new tab of the same browser. His kept thread is restored, Q5 is submitted immediately (tag "instant · Q5"), `?q=5` is removed from the URL, and the cookie id is unchanged. His first tab picks up the two new rows by polling within 13 s.
- [x] MP-6 Owner inbox (desktop): all three conversations are listed with their names and previews.
  - Chen: "Needs you" badge and `is-attention`.
  - Alice and Bob: `is-unread` with the dot.
  - The "Needs you" chip `has-items`; Bob (newest activity) is above Chen and Alice.
- [x] MP-7 The owner opens Chen: "Avatar asked for you" flag and the push row are shown. Straight from Supabase, all of Chen's rows are now `read=true`, `needs_attention=false`. Alice's and Bob's rows are untouched (`read=false`).
- [x] MP-8 The owner replies to Chen (Enter). Admin shows "You · sent to visitor", the flag goes and the composer keeps focus. **Chen's page shows the human bubble "Sergei Maslennikov · live"** (from `OWNER_NAME`), with the owner photo and the text, **within 7.9-8.9 s**. No Avatar message follows the owner's. The DB row is `role=human`, `read=true`, `needs_attention=false`, with the exact text.
- [x] MP-9 The owner opens Alice. The inbox then shows the three states at once: Chen read (check mark), Alice active, Bob unread. The owner replies to Alice; **Alice sees "Sergei Maslennikov · live" within 9.0-9.6 s**, and the Avatar does not react.
- [x] MP-10 Chen asks a follow-up and **the Avatar builds on the owner's message**. The reply names Thursday (and 14:00), offers no other weekday, and speaks of the owner in the third person. The DB order after the human row is exactly `human, visitor, avatar` (the Avatar never replied to the human by itself). Reply texts, one per run:
  - run 1: "Hi Chen. The real Sergei suggested a call on Thursday at 14:00 Tallinn time. As for preparation, he hasn't specified anything yet in this chat. ..."
  - run 2: "The real Sergei suggested Thursday at 14:00 Tallinn time for the call."
  - run 3: "He suggested Thursday at 14:00 Tallinn time."
  - run 4: "The real Sergei suggested Thursday at 14:00 Tallinn time for the call."
  - run 5 (final image): "He suggested Thursday at 14:00 (Tallinn time) for the call."
  - run 6 (final run): "The real Sergei suggested a call on Thursday at 14:00 Tallinn time."
- [x] MP-11 Chen's follow-up turns the row unread in the owner's inbox (poll, within 15 s). Re-opening shows the full three-way thread (visitor, Avatar with push row, "You · sent to visitor", visitor, Avatar) scrolled to the latest message, in dark and light. All rows are read afterwards.
- [x] MP-12 Isolation:
  - Bob's page holds none of Alice's or Chen's text, emails or owner replies, and has no human bubble (4 messages). Alice's and Chen's pages hold nothing from each other.
  - Bob's `GET /api/conversations/<own id>` returns only his 4 rows, without `needs_attention` or `read`.
  - `GET /api/conversations` (no id) -> 404. A malformed id -> 422. An unknown UUID -> 200 with `messages: []` and name null, so reading a thread requires its UUID.
  - From Bob's browser, every admin route -> 401, and a spoofed owner POST -> 401 and is not stored.
- [x] MP-13 The owner on a phone: the inbox fills the screen (`data-view=inbox`), Bob still unread. Tapping Chen opens the thread (`data-view=thread`) with the back control and the last message in view. Back returns to the inbox; light theme checked too.
- [x] MP-14 No uncaught page errors or unexpected console errors in any participant's page (7 pages, `watchPage`).

## RS. Persistence across a container restart (`restart.e2e.spec.ts`)

After `stop_mac.sh` + `start_mac.sh` (a new container with no in-memory state), the same "browsers"
come back from the saved storage state. Passed 4 times: after runs 1, 3 and 4, and after run 5 on
the final image (run 22: new container id, 16 s; Alice unread count 0 in the admin after the
restart until her Q3 arrived). Passed a fifth time in the final run (run 28, after three-way run 6:
container 666a567c2f5b -> 5b53ba09037e, 15.5 s, Alice unread 0 after the restart).

- [x] RS-1 Each visitor's kept chat is restored from Supabase under the same conversation id (cookie). The message count and role order equal the database, the name field is restored, the intro is hidden, the owner bubbles show "Sergei Maslennikov · live", Bob has none, and the themes persist (Alice dark, Bob and Chen light).
- [x] RS-2 The owner's session cookie survives the restart (signed with the unchanged `SESSION_SECRET`): `/admin` opens the dashboard with no login gate. Inbox state is intact: Chen read with no flag, Alice read, Bob unread. The database agrees.
- [x] RS-3 A restored conversation carries on: Alice sends Q3 after the restart (instant answer, same id, 2 new rows), and her row turns unread in the owner's inbox.

## DB. Database-level verification (SPEC "Implementation Decisions", Q&A #5)

Read straight from Supabase (`e2e/support/supabase.ts`, SELECT only) inside the specs.

- [x] DB1 Every row has `conversation_id`, `created_at`, `role` in {visitor, avatar, human} and `content`. `conversation_name` is set on visitor rows from the name field (MP-4).
- [x] DB2 `tool_calls` records tool use: `faq_tool` (arguments and output), `push_tool` (arguments with the visitor email), and `{"type":"instant","faq":N}` for the Qn shortcut (MP-4, MP-5).
- [x] DB3 `needs_attention` is set only on the row whose turn called `push_tool`, and cleared (with `read=true` on every row) by opening the thread in admin (MP-4, MP-7).
- [x] DB4 Owner messages are stored as `role=human`, `read=true`, `needs_attention=false` (MP-8).
- [x] DB5 A new visitor message after the owner opened the thread is stored `read=false` (the row turns unread again) until the owner looks (MP-11, RS-3).

## AG. Abuse guards end to end (SPEC "Implementation Decisions", Q&A #12; `guards.e2e.spec.ts`)

Passed in 4 runs, and twice more on the final image (runs 21 and 23: clamp 25,006 -> 20,089
characters; 20 accepted in 4.2 / 4.7 s, the 21st -> 429 with `Retry-After: 56`; 614,400 characters -> 413, 0 rows),
and once more in the final run (run 26: clamp 25,006 -> 20,089; 20 accepted in 4.5 s, the 21st ->
429 with `Retry-After: 56`; 614,400 characters -> 413, 0 rows).

- [x] AG-1 A 25,006-character message is stored as exactly the first 20,000 characters + `\n\n[...message truncated as it's too long; ask the visitor to send something more concise]` (20,089 characters). The SSE `start` event echoes the same clamped text, and the Avatar still replies (the clamped text is what went to the model).
- [x] AG-2 20 messages in 4.3-4.5 s for one conversation are all answered. The 21st gets HTTP 429 with `Retry-After: 56` and the "too quickly" detail, and so does an immediate retry. Exactly 40 rows are stored (the rejected ones are not). A different conversation is unaffected.
- [x] AG-3 A 614,400-character body gets HTTP 413 ("far too long") and nothing is stored for that conversation.
- [x] AG-4 The visitor-facing messages for 429 and 413, and the 20,000-character clamp in the browser, pass against the container through the frontend suite (V-H1..H3, screenshots `desktop-visitor-rate-limit-real`, `desktop-visitor-too-large`).

## PO. Pushover (SPEC reference `push.py`, Q&A #10)

- [x] PO1 Contact capture sends a real Pushover notification: Chen's enquiry with an email calls `push_tool` and the tool reports delivery (`ok: true`, "Notified Sergei · push_tool") in runs 1-3 and 5 (final image), and in the final run (run 26, `pushover_delivered: true`). The owner saw "Notified you · push_tool" in admin.
- [x] PO2 With Pushover credentials missing (run 4), `push_tool` still flags the thread ("Needs you" in admin, `needs_attention=true`). The visitor sees "Flagged for Sergei · push_tool" and the reply says the conversation was flagged for him, without claiming a phone notification.
- [x] PO3 The notification count stayed small: 10 real notifications from this plan in total (runs 1-15: 6; final image: A-O1 in run 18 and Chen in run 21; final run: A-O1 and Chen in run 26).
- [x] PO4 After pushing, the Avatar tells the visitor in the chat that it has done so (SPEC reference `push.py`; ux-flows.md F2). Final image, run 5: Chen's reply "I passed your email (test.chen@example.com) and your request about an AI engineering job to Sergei. He has been notified...". The unknown-question case is pinned by the real-LLM backend test (backend plan 23.6) after bug 3 below.

## L. Container logs

Scanned after every run by a script that prints only counts and key names.

- [x] L1 No tracebacks and no ERROR lines in the logs after bug 1 was fixed (runs 4-15: 938, 944, 1,067 and 48 lines). The only WARNING lines are "Supabase rejected a request with PGRST303 (clock skew); retrying", 3 in total: the fix at work, each followed by success.
- [x] L2 No secret values in the logs (same 7 keys as C4).
- [x] L3 No visitor email addresses in the logs (tool use is logged by name only: "Conversation <id> used tools: ['push_tool']").
- [x] L4 HTTP status mix as expected: 200/201 plus only the deliberately provoked 401 (signed-out checks, spoof, wrong password), 404, 413, 422 and 429.
- [x] L6 Final run (runs 27 and 29), scanned by the same script: the container that ran the whole suite had 1,178 log lines, the restarted one 48; both 0 tracebacks, 0 ERROR, 0 WARNING (no PGRST303 retry was needed), none of the 7 secret values, 0 email addresses. Statuses: 200 (1,130), 201 (12), 401 (21: the signed-out and forged-cookie checks, the wrong password, the spoofed owner POST), 404 (1), 413 (2), 422 (1), 429 (3); after the restart only 200 (44).
- [x] L5 Final image, restarted container (runs 22-23: restart check + guards): 74 log lines, 0 tracebacks, 0 ERROR, 0 WARNING, none of the 7 secret values, 0 email addresses; statuses 200 (67), 413 (1), 429 (2). The logs of the run 18-21 container were not captured before `stop_mac.sh` removed it (the script runs `docker rm`); nothing in that window failed, and runs 18-21 passed.

## D. Deployment files and the WordPress embed (SPEC "Tech stack decisions")

The deploy itself (`scripts/deploy.sh`, any mutating `flyctl` command) is not run in this phase.
The files it is driven by are checked statically by `backend/tests/test_deploy_config.py` (16
tests; `tomllib` parse, `bash -n`, text checks; nothing executes flyctl) and the embed snippet in
a browser by `frontend/e2e/embed.spec.ts`. All passed on 2026-09-22 (backend suite 410 passed;
frontend suite runs 18 and 20 against the container, and locally on :8100).

- [x] D1 `scripts/fly.toml` holds the SPEC values: `app = "avatar-sergei"`, `primary_region = "lhr"`, one `[[vm]]` with `size = "shared-cpu-1x"` and `memory = "512mb"` (`test_fly_app_and_region_are_the_spec_values`, `test_fly_vm_is_shared_cpu_1x_with_512mb`).
- [x] D2 Always on: `http_service.min_machines_running = 1` (>= 1), `auto_start_machines = true`, `force_https = true` (`test_fly_machine_is_always_on`).
- [x] D3 `internal_port = 8000` and `env.PORT = "8000"` match the Dockerfile (`EXPOSE 8000`, `ENV PORT=8000`, uvicorn `--port "${PORT:-8000}"`) (`test_fly_internal_port_matches_the_dockerfile`).
- [x] D4 One HTTP health check, `GET /api/config` (200 with no database hit) (`test_fly_health_check_is_the_db_free_config_endpoint`).
- [x] D5 Production cookie: `env.COOKIE_SECURE = "1"`; `[env]` holds only `PORT` and `COOKIE_SECURE`, no secrets (`test_fly_production_cookie_is_secure`, `test_fly_env_holds_no_secrets`).
- [x] D6 Graceful shutdown: `kill_signal = "SIGINT"` and `kill_timeout = 75`, more than the app's 60 s lifespan drain (read from `backend/app/main.py`) and within Fly's 300 s maximum (`test_fly_kill_timeout_exceeds_the_app_drain`). Concurrency counts connections (SSE), soft < hard limit (`test_fly_concurrency_counts_connections_for_sse`).
- [x] D7 `scripts/deploy.sh` passes `bash -n` (syntax only, never executed), uses `set -euo pipefail`, targets `APP="avatar-sergei"` with `flyctl deploy --config scripts/fly.toml --dockerfile Dockerfile`, and stages exactly the 9 secret keys over stdin (`flyctl secrets import --stage`, never `secrets set` on the command line) (`test_deploy_script_parses`, `test_deploy_script_targets_the_same_app_and_config`, `test_deploy_script_stages_every_secret_and_only_secrets`).
- [x] D8 The copies of `fly.toml` and `deploy.sh` printed in `DEPLOY.md` are identical to the files (`test_deploy_md_copies_match_the_scripts`).
- [x] D9 `scripts/wordpress-embed.html` defines `var BASE = "https://avatar-sergei.fly.dev";`, forwards only a numeric `?q=` into the iframe `src`, and keeps its `<style>`/`<script>` free of blank lines (WordPress would insert `<p>`) (`test_embed_defines_a_base_constant_for_the_app_url`, `test_embed_forwards_q_to_the_iframe_src`, `test_embed_snippet_has_no_blank_lines_inside_style_or_script`).
- [x] D-E1 In a browser: the snippet pasted into a host page served from `127.0.0.1` (a different site from the app on `localhost`), with `BASE` pointed at the server under test, opened as `/avatar?q=2`: the iframe `src` is `<BASE>/?q=2`, the visitor page inside answers Q2 on arrival ("instant · Q2", "**Q2:** ..."), clears `?q` from its own URL, and the frame is full-bleed below the 80 px nav with no sideways scrolling (screenshot `desktop-embed-wordpress-q2`).
- [x] D-E2 A non-numeric `?q` (`2"><script>...`) is not forwarded: the iframe `src` is `<BASE>/` and the intro shows with no message sent.
- [x] D10 `fly deploy` and the `DEPLOY.md` smoke tests against `https://avatar-sergei.fly.dev`. Deployed by the owner with `scripts/deploy.sh` on 2026-09-22 (app created, 1 machine `shared-cpu-1x` in `lhr`, image 101 MB, health check passing, http redirects to https). DEPLOY.md section 5 smoke run on production (model `openai/gpt-5.6-luna`), 19/19 passed:
  - `/api/config` 200 in 0.19 s; `/`, `/admin` and static assets 200; title from `OWNER_NAME`, no `{{` placeholders, no YouTube link; footer links LinkedIn / GitHub / Hugging Face.
  - Composer focused on load and after a reply; the three new conversation starters shown.
  - "What is the Tennis Match Research Dashboard?" streamed a reply via `faq_tool` Q12 with clickable links (`target=_blank`); `Q2` instant with the tag; `/?q=2` answered on arrival and cleared the param (phone, light).
  - Admin: wrong password rejected; login sets the `avatar_admin` cookie with `Secure`, `HttpOnly`, `SameSite=Lax` (confirms `COOKIE_SECURE=1`); a thread opened in 225 ms; the owner's reply reached the visitor page as "SERGEI MASLENNIKOV · LIVE".
  - Contact capture fired `push_tool` (one real Pushover notification) and the admin row showed "Needs you".
  - Abuse guards: the 21st message in a minute got 429; a 25,200-char message was stored as 20,000 chars plus the exact note.
  - No page errors; `fly logs`: 0 tracebacks, 0 ERROR/WARNING lines, 0 5xx.
  - The 5 smoke conversations (53 rows) and the smoke screenshots were deleted afterwards.

---

## Evidence

**Conversation ids** (all `TEST ...` threads; the orchestrator's cleanup removes them):

| Run | TEST Alice | TEST Bob | TEST Chen |
|---|---|---|---|
| 1 | `3ea3ac59-8d83-4296-a67f-3d651eee6e3c` | `eef7e941-e46d-47d8-99b5-6a5777ab5a56` | `7d09b380-31a5-426a-896a-6b79f71d5a4b` |
| 2 | `af0c6814-a642-4a22-a8e3-3f847a7655fa` | `0a065a8f-c8e3-492e-880b-5fb78da98b5f` | `6bec2d95-2824-4461-aa7e-d7d6efd447ef` |
| 3 | `788d4267-1357-46c0-bbcb-499c17a82479` | `521aae04-36fd-400c-8ede-cb1331e20a01` | `a885730c-e696-42e6-979a-3c19492778f9` |
| 4 (no push) | `b61fd699-06cb-4729-a23a-5bbb083f1590` | `3934263b-c468-4f43-b690-2507fdea10b5` | `b8f9eaf1-c5a1-4333-ad90-f5f8d7a763c4` |
| 5 (final image) | `b06f7e5a-810f-46f5-86f5-fd0a7b6ea678` | `bc6a40c4-3f85-4008-ad92-8e438fd185a3` | `52b86553-646c-4d7d-878d-b289f71d85f8` |
| 6 (final run) | `237fc365-83fa-4c3e-babf-52aff12d9008` | `c4b3084f-3fd0-4107-bc25-318b2589cc25` | `87bbce55-4d5e-4662-99f0-1d9f88e0f44d` |

Guards (runs 9 and 12):
- clamp: `4681cba5-aa41-4674-8e3c-a16dac981c54`, `b9ab3897-7d96-4986-bb9e-4f0b6a7cda2e`
- rate limit: `4a50659d-eb0d-4eed-840e-def4446d0280`, `4583b87a-816a-48ea-b89e-407447813795`
- 413 (no rows): `f18ce8c3-...`, `b459bde5-...`

Guards on the final image (runs 21 and 23):
- clamp: `9de54d4a-87b0-4106-bbd5-f3e519ca58e6`, `a2a8d65e-d3b5-4b28-ae0c-a01acd7c6f43`
- rate limit: `7cc1d4d5-a97c-4b87-879c-6ca4ed495a58`, `c17a9b2c-8a85-40ed-b46b-26a45460d3bf`
- 413 (no rows): `e3e331a0-a8eb-42b5-81b8-9db2e3d1f96f`, `4f4d3907-8d6a-4ef8-8de9-19d54eb4eac2`

Final run (run 26): clamp `b34b9c5a-8e1e-460a-b52a-408fd4e419d6`, rate limit
`789b7a9b-0bff-4e0a-9867-177443069417`, 413 (no rows) `69c7b97e-bb1f-4b6a-b3a2-e991d784045d`.
Windows smoke (run 31): "TEST WinPS" `e573fea4-926d-402e-b84e-2e1c826317e2` (Q2, 2 rows).

Two earlier guard runs did not log ids. Also written: 40 "TEST LangProbe ..." threads (run 10, through the container) and every frontend-suite thread from runs 3, 4, 9, 12, 18, 19 and 20 (all named `TEST ...`).

**Timings** (runs 1 / 2 / 3 / 4 / 5 on the final image / 6 in the final run):

| Measure | Values |
|---|---|
| Bob Q2 instant answer | 905 / 447 / 386 / 884 / 377 / 982 ms |
| Alice reply (faq_tool, streamed) | 4.0 / 6.2 / 6.0 / 5.4 / 4.5 / 4.5 s |
| Chen reply (push_tool) | 5.0 / 4.0 / 4.9 / 4.4 / 4.0 / 3.9 s |
| Chen follow-up reply | 3.9 / 1.8 / 2.3 / 1.8 / 1.9 / 1.8 s |
| **Owner -> Chen's screen** | **8.9 / 8.5 / 8.0 / 7.9 / 8.0 / 8.1 s** (10 s poll) |
| **Owner -> Alice's screen** | **9.4 / 9.5 / 9.6 / 9.0 / 9.0 / 9.1 s** |
| Whole scenario | 47 / ~40 / ~40 / 40 / 39 / 40 s |
| `start_mac.sh` (cached build) | 4-8 s (7 s for the final image) |
| `start_pc.ps1` (legacy builder, pwsh 7 in Docker) | 40 s |
| `start_pc.ps1` (Windows PowerShell 5.1, Docker Desktop, cached build) | 15 s |
| `stop_mac.sh` | 1.4 s idle; 0.7 s when absent |

**Screenshots** (`test/screenshots/e2e/`, 135 files, plus 25 in `no-push/`). All 135 were re-taken
in the final run (runs 26 and 28, 04:45:31-04:48:47 UTC), so they show the final UI (three suggestion
chips, the neutral alert icon on notices, "instant" without a number for Q99). Viewed by hand from the
final run: `three-way-10`, `three-way-15`, `three-way-19`, `mobile-visitor-stream-complete-light`,
`desktop-admin-push-thread-flag`; all as described below:
- `three-way-01` ... `three-way-20` (three-way run 6), `three-way-r1` ... `r5` (restart after run 6):
  - Bob on the phone: Q2, `?q=5` deep link, first tab synced, isolated.
  - Alice: streaming, before and after the owner joins.
  - Chen: push, sees the owner, follow-up.
  - Admin desktop: inbox with three visitors, Chen flagged, reply, read/active/unread, full three-way thread in dark and light.
  - Admin phone: inbox dark, Chen thread, inbox light.
  - After the restart: restored visitors, admin inbox, carrying on.
- `desktop-*` / `mobile-*` (110: desktop 85, mobile 25): the frontend suite's screenshots, re-taken against the container (final run 26), including the gap-closing additions (`admin-width-{360,768,900}`, `admin-gate-logging-in`, `embed-wordpress-q2`, phone `visitor-rate-limit-*`, `visitor-stream-error-*`, `visitor-after-reset-*`, `visitor-instant-light`, `visitor-stream-complete-light`).
- `no-push/`: run 4 and its restart check (the "Flagged for Sergei" variant). These are from the earlier build (before the visual-QA polish) and are superseded by the root folder; kept for the orchestrator's review.
- Viewed by hand (about 15 from runs 1-15, and 8 from the final image: `three-way-15`, `desktop-visitor-instant-q99`, the embed, the admin widths and the phone notices): all match the design system in both themes. The owner bubble has photo, yellow ring, tint and glow with "SERGEI MASLENNIKOV · LIVE"; admin shows "You · sent to visitor". There are no emoji, no gradients in chrome, and purple only on the send buttons. Nothing looked wrong.

---

## Bugs found and fixed

1. **Transient Supabase error -> HTTP 500 (run 3, test A-L4).** Container log:
   `postgrest.exceptions.APIError: {'message': 'JWT issued at future', 'code': 'PGRST303'}` on
   `GET /admin/api/conversations`. With the `sb_secret_` API key, Supabase's gateway mints a
   short-lived JWT per request, and slight clock skew makes PostgREST reject one now and then.
   postgrest-py only retries 503/520 on GET, so every blip became a 500 (inbox), a 503 "couldn't
   save your message" (chat insert) or a failed reply.
   **Fix:** `backend/app/db.py`. Every repository query goes through a new `execute()` that
   retries PGRST303 twice (after 0.25 s and 0.75 s), then re-raises; other errors are not retried.
   The request is refused while its JWT is checked, before any SQL runs, so retrying writes is safe.
   **Tests:** 3 new in `backend/tests/test_db.py` (`test_clock_skew_rejection_*`,
   `test_other_postgrest_errors_are_not_retried`). Backend suite: 390 passed, 8 skipped.
   **Verified live:** the retry fired 3 times in later container runs, with no 500.
2. **English questions sometimes answered in Russian (runs 9 and 12, test V-I2).** "Which city
   does Sergei live in now?" got "Я из небольшого эстонского города Пярну...". That is the right
   FAQ (Q2), wrongly translated.
   **Root cause:** `faq_tool` output ended with the quoted style-guide rules ("I speak Russian
   (native), English and Estonian..."), the last thing the model read before writing.
   **A/B on nano** (in-process app, in-memory DB, Pushover blanked). Wrong-language replies to the
   English question:

   | Variant | Wrong-language replies |
   |---|---|
   | Original order | 11/118 (9%) |
   | **Rules first, generic reminder last (chosen)** | **5/240 + 4/160 on the implemented code (2%)** |
   | Rules dropped from the output | 3/160 |
   | Plus the visitor's message quoted | 2/160 |
   | Pointing at the rules without quoting | 5/120 |
   | Adding "not the owner's native language" | 4/80 (worse) |
   | Adding "do not translate if already in that language" | 8/160 (worse) |

   The chosen order kept Russian and Estonian questions at 20/20 each, and FAQ routing for a
   Russian project question was unchanged (36/40 old, 35/40 new).
   **Fix:** `backend/app/knowledge.py`, `faq_language_note()`: the quoted rules come first and the
   generic reminder ("the language of the visitor's latest message") is last. It stays
   owner-agnostic (the `test_no_owner_specific_literals_in_code` guard passes).
   **Tests:** two tests in `backend/tests/test_prompts_knowledge.py` updated to pin the new order.
   Real-LLM tests re-run: 8/8, with the in-memory repository so no Supabase rows were deleted.
   Measured through the container afterwards: 1/40.

3. **The Avatar often did not tell the visitor it had passed an unanswerable question on (found by
   the gap-closing pass, 2026-09-22).** SPEC reference `push.py`: "If the Avatar can't answer a
   question, it should use the tool to tell the human and mention in the chat that it's done that."
   The real-LLM test `test_real_unknown_question_pushes_the_owner` gained an assertion on the reply
   (the owner's first name plus a done-form "passed on / notified / flagged" phrase) and failed.
   A probe (in-process app, in-memory repository, Pushover stubbed, nano, 20 runs) showed `push_tool`
   was called 20/20, but 7 replies said nothing about it and some offered "If you want, I can pass
   this on" after it was already done.
   **Fix:** `backend/app/agent.py` `notify_owner()`: the tool output, the last thing the model reads
   before it writes, now ends with what the reply must say: delivered -> "Tell the visitor in your
   reply that you have passed this on to <first>."; not configured / failed -> "... that you have
   flagged this for <first>, who will see it in the dashboard; do not claim a phone notification."
   (owner-agnostic; `push_delivered()` still classifies all three correctly).
   **Measured after the fix:** delivered 30/30 and 30/30 (the second run with the stricter done-form
   check), Pushover unconfigured 20/20 with "flagged" wording and no claim of a phone notification.
   **Tests:** `test_agent.py` pins the three texts (4 new tests); `test_llm.py` asserts the mention
   (3 real-LLM runs, 8/8 each). Verified end to end on the final image (PO4).
4. **Stale backend test after the polish (test only).** `test_public_api.py::test_real_built_frontend_is_templated_from_config`
   still looked for "Grace's" with a straight apostrophe; the visual-QA polish changed the intro and
   composer copy to U+2019. The assertion now uses the typographic apostrophe.

5. **`scripts/start_pc.ps1` could not build from a UNC path (final run, run 30).** Run from Windows
   PowerShell 5.1 on the WSL checkout (`\\wsl.localhost\Ubuntu-24.04\...`, i.e. this owner's own
   Windows + WSL setup), the build failed at once: `unable to prepare context: path
   "Microsoft.PowerShell.Core\FileSystem::\\wsl.localhost\...\scripts\.." not found`.
   **Root cause:** `$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path`. For a UNC path
   `.Path` carries PowerShell's provider prefix and leaves the `..` uncollapsed; PowerShell's own
   `Test-Path` accepts that, docker does not. (On a drive-letter checkout `.Path` is plain, which is
   why pwsh 7 in PS3 and a C:\ checkout never showed it.)
   **Fix:** `$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))`, a plain,
   normalised filesystem path for both `C:\...` and `\\server\share\...` (checked with a probe:
   `\\wsl.localhost\Ubuntu-24.04\home\kasutaja\projects\avatar`, and `C:\Windows` for a local path).
   `stop_pc.ps1` does not use the repo path. **Verified:** PS6 (runs 31-32).

Bugs 1-4 are also recorded in `backend_test_plan.md` ("Findings and fixes during this pass"); bug 5
is noted there too.

## Observations and open items

- **Residual language slip on nano (about 2%).** Even after fix 2, nano occasionally translates an
  English FAQ answer into the owner's native language, so the frontend test V-I2 can still fail now
  and then. It happened once more on the final image (run 18: "Я из маленького эстонского города
  Пярну, и сейчас я нахожусь в Таллине, Эстония."); V-I2 then passed 5/5, again in run 20, and in
  the final run (run 26). The stronger production model is expected to do better; not verified here, because tests must use nano.
- **The owner's "otherwise English" rule is not followed by nano.** A German question gets a German
  reply 20/20 with the original code and with the fix alike. This is pre-existing, and prompt
  wording did not change it (3 variants tried); left for the owner or a stronger model.
- **An unanswerable follow-up pushes again (correct behaviour).** In run 1, Chen also asked "is there
  anything I should prepare?". The Avatar answered from the owner's message and pushed that
  question (a second real notification). The scenario's follow-up now asks only about what the owner
  said, so each run sends one notification.
- **The admin composer placeholder uses the first word of the name** ("Write a message to TEST..."
  for "TEST Chen"). This is an artefact of test naming and fine for real names.
- **With delivery failed or unconfigured, the reply said "I've passed your email ... to the real
  Sergei, and the conversation has been flagged"** (run 4). It does not claim a phone notification,
  so it is acceptable; noted because the prompt asks for "flagged" wording.
- **Changes after the last run with a real push.** The MP-6 ordering check (relative order instead of
  "top three rows", which is fragile when other specs run in parallel) and the 0600 state file were
  verified in run 4 (no-push container) and its restart check.
- **Embedded in a cross-site iframe, Chromium logs "Blocked autofocusing on a <textarea> element in
  a cross-origin subframe."** The visitor page's composer has the `autofocus` attribute (the script
  also focuses it); browsers refuse autofocus inside a cross-origin frame and log this as a console
  error. The chat works (D-E1). The embed is optional and not part of this build, so the app was
  not changed; `embed.spec.ts` tolerates exactly this message. Dropping the redundant `autofocus`
  attribute would silence it if the owner embeds the app.
- `test/README.md` now carries the concrete Docker commands (it was generic before).

## Cleanup (orchestrator)

State of the `messages` table after the final run (read-only count, 2026-09-22 04:56 UTC): **3,475
rows in 851 conversations**, all written by testing (first row 2026-09-21 09:35 UTC, ids 59-17,215;
no deploy was run in this phase). 840 conversations are named `TEST ...`; the other 11 are test
threads too: 9 unnamed (API, embed and unit-style checks that sent `Q1`, `Q2` or `Q99` without a
name) and 2 named "Sergei Maslennikov (the real human, joined live)" (the name-forging
prompt-injection test, `75914359-...` and `4b8967ee-...`). The final run added 58 of them (248 rows).
Screenshots: `test/screenshots/e2e/` 135 PNGs + `no-push/` 25, `test/screenshots/frontend/` 110.

- [x] Delete screenshots (2026-09-22: all 270 PNGs in test/screenshots/ removed, plus frontend/test-results and frontend/playwright-report)
- [x] Delete test conversation threads in Supabase (2026-09-22: 851 conversations / 3,475 rows deleted; messages table verified at 0 rows)
