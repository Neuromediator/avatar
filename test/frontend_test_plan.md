# Frontend Test Plan (Playwright)

SPEC.md, Testing #2: "Rigorously test the frontend. Use Playwright, take multiple screenshots.
Ensure everything works in significant detail." This plan covers the visitor chat (`/`) and the
admin dashboard (`/admin`) against the behaviour in SPEC.md and the interaction contracts and
states matrix in `design-system/docs/ux-flows.md`. Appearance is checked against the
design-system mockups by viewing the screenshots.

## How the suite runs

- Suite: `frontend/e2e/` (Playwright Test, TypeScript). Config: `frontend/playwright.config.ts`.
  Typecheck: `npm run test:e2e:typecheck`.
- Server under test: the real backend serving the built frontend, with the cheap model:
  ```
  cd frontend && npm run build
  cd ../backend && MODEL=openai/gpt-5.4-nano uv run uvicorn app.main:app --app-dir . --port 8100
  cd ../frontend && BASE_URL=http://localhost:8100 npm run test:e2e
  ```
- Projects: `desktop` (Chromium 1440x900; responsive tests resize to 360-1440) and `mobile`
  (390x844, DPR 2, `isMobile` + `hasTouch`; runs the `*.mobile.spec.ts` files). The mobile
  project uses a desktop Chrome user agent: with the Pixel 7 (Android) UA, Google Fonts serves
  Android font files that headless Linux Chromium spaces badly ("lif estyle", "Linked In"), so
  the phone screenshots looked worse than real phones. The app never reads the user agent.
  3 workers (the admin inbox is shared). Test timeout 90 s (150-180 s for real-LLM specs).
- Real services: Supabase (test conversations are written for real), OpenRouter with
  `openai/gpt-5.4-nano`, and exactly one real Pushover notification per suite run
  (`admin-push.spec.ts`). Qn shortcuts (no LLM call) seed most conversations.
- Deterministic stream states: `support/chat-mock.ts` replaces `POST /api/chat` in the page with
  a stream the test feeds event by event (start / tool_called / tool_output / delta / done /
  error / dropped). HTTP errors are produced with `page.route`.
- Every test visitor is named `TEST ...`; tests find their own threads by that unique name or by
  conversation id, so other conversations in the database never interfere.
- The owner's name is read from `GET /api/config` at test time (never hardcoded in tests).
- A global guard (`support/fixtures.ts`) fails any test whose page throws an uncaught error or
  logs a console error (network status logs for deliberately provoked 401/413/429/503 excepted).
- Screenshots: written by the tests to `test/screenshots/frontend/<project>-<name>.png`.

## Final run (2026-09-22, 04:45-04:48 UTC, final code, against the Docker container)

The last full run of this suite, on the final code, against the container built by
`MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh` on `http://localhost:8000` (image code
and `frontend/dist` verified identical to the working tree). All green:

```bash
cd frontend && npm run build && npm run test:e2e:typecheck          # ok, clean
BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e npx playwright test
```

| Project | Passed | Failed | Skipped |
|---|---|---|---|
| `desktop` (13 spec files) | **79** | 0 | 0 |
| `mobile` (2 `*.mobile.spec.ts` files) | **11** | 0 | 0 |
| `three-way` (Docker end-to-end specs, see the e2e plan) | **4** | 0 | 1 (restart, by design) |
| **Total** | **94** | **0** | **1** (95 tests, 2.3 min, 3 workers) |

- All 90 frontend tests passed in one run, including A-O1 (real nano + real Pushover, delivered:
  "Notified you · push_tool" in `desktop-admin-push-thread-flag`) and V-I2 (the English question
  got an English answer this time; see the language-residual note under Observations).
- Every ticked item in this plan passed in this run. No test was retried, skipped or excluded.
- Screenshots: the suite re-took its 110 shots (desktop 85, mobile 25) into `test/screenshots/e2e/`,
  so they show the final UI served by the container. The 110 in `test/screenshots/frontend/` are from
  the local `:8100` gap-closing run (same frontend code; not re-taken in the final run).
- Real Pushover notifications in this run: 2 (A-O1 and TEST Chen in the three-way scenario).

## Run log

- 2026-09-21, run 1 (full suite, both projects, `BASE_URL=http://localhost:8100`): **74 / 74 passed** (1.6 min, 3 workers).
- 2026-09-21, run 2 (identical, flakiness check): **74 / 74 passed** (1.6 min, 3 workers).
- 74 tests in 14 spec files: desktop 67, mobile 7. 82 named screenshots in `test/screenshots/frontend/` (at the time; see below for the current counts).
- 2026-09-22, visual-QA polish (18 findings from three visual QA judges, see "Bugs found and fixed"):
  9 regression tests added (83 tests: desktop 75, mobile 8). Run A (full suite): 82 / 83. A-P2
  failed because the new composer re-enable focused the textarea on every thread open (the phone
  keyboard would pop up). Fixed in `shared/composer.ts` / `admin/thread.ts`. Run B (full suite
  except A-O1, to save one real Pushover notification; A-O1 passed in run A on the same code
  paths): **82 / 82 passed** (1.5 min). All affected screenshots were retaken by the suite and viewed.
- 2026-09-22, gap-closing pass: 7 tests added and 6 extended (90 tests in 15 spec files: desktop 79,
  mobile 11). New: A-L8 (logging-in state), A-P7..P9 (admin at 360 / 768 / 900 px), D-E1 / D-E2
  (the WordPress embed, `embed.spec.ts`), three V-K8 phone tests (429 notice, reply error, after
  Reset). Extended: V-G11 (owner message restores the 10 s cadence) in the cadence test, V-C16 /
  A-N16 (robot and owner images on reply bubbles, emoji scan of the admin dashboard), light-theme
  phone shots of stream-complete and instant.
  Local run (`:8100`, nano, rebuilt `dist/`, backend with the bug 3 fix, see the e2e plan): **89 / 89
  passed** (1.5 min) with A-O1 left out to save a Pushover notification. Against the final Docker
  image (e2e plan runs 18-20): 89 / 90 (V-I2 language residual, then 5 / 5 on repeat) and 89 / 89;
  A-O1 passed there with a delivered push.
- Screenshots in `test/screenshots/frontend/`: 110 (desktop 85, mobile 25). 107 were re-taken in the
  gap-closing local run; the three A-O1 shots (`desktop-admin-push-needs-you-row`,
  `desktop-admin-push-thread-flag`, `desktop-visitor-push-then-owner-reply`) are from run A (A-O1 was
  not run locally this time); their final-image versions are in `test/screenshots/e2e/`.
- Measured: owner message reached the visitor after 10.3 s (V-G1; 10.4 s and 10.3 s against the
  container); fake-clock poll gaps were 29 x 10 s, then 60 s and 61 s (V-G6 / V-G7); after an owner
  message picked up by a 60 s poll the next gaps were 11, 10, 10 s (V-G11; 11, 11, 10 and 10, 10, 11
  against the container).
- Real Pushover notifications from this suite: 3 in total (one per run of `admin-push.spec.ts`, plus one while writing it); the container runs are counted in the e2e plan.

---

## ENV. Setup

- [x] ENV-1 `npm run build` succeeds (tsc + vite) and `frontend/dist` is served by the backend.
- [x] ENV-2 Backend on :8100 with `MODEL=openai/gpt-5.4-nano` (final run: the container on :8000 with `MODEL=openai/gpt-5.4-nano`); `/` and `/admin` are served with `{{OWNER_NAME}}` substituted.
- [x] ENV-3 `npm run test:e2e:typecheck` passes (the suite itself type-checks).

## V-A. Visitor: page shell and identity (SPEC UI, Design System, Q&A #4 / #11)

- [x] V-A1 `<title>` is "<OWNER_NAME> · Avatar"; meta description and og:title contain OWNER_NAME (value from `/api/config`).
- [x] V-A2 No unsubstituted `{{...}}` placeholder anywhere in the rendered page.
- [x] V-A3 Brand "Avatar" with subtitle "<OWNER_NAME> · digital twin"; intro heading and composer placeholder use the owner's first name.
- [x] V-A4 No template-author copy ("Donner"), no YouTube link, no emoji code points in visible text (visitor intro; the admin dashboard is scanned in A-N16).
- [x] V-A5 Footer links exactly: LinkedIn `https://www.linkedin.com/in/sergei-maslennikov-ai`, GitHub `https://github.com/Neuromediator`, Hugging Face `https://huggingface.co/Neuromediator`; each `target=_blank rel=noopener`, with its sprite icon.
- [x] V-A6 Rings background texture: `body.hud-grid::before` is fixed, `z-index:-1`, masked with the rings (circle) SVG at 44px.
- [x] V-A7 Fonts: Newsreader on the intro heading, Hanken Grotesk on the body; both faces loaded.
- [x] V-A8 Dark theme is the default, also when the OS prefers light (nothing stored until the visitor toggles).
- [x] V-A9 A11y basics: labelled name input, labelled composer, Keep chat is `role=switch`, named Reset / Send / theme buttons, `Conversation` region, `Example questions` group, `aria-live=polite` live region, `lang=en`, no unnamed buttons.

## V-B. Visitor: intro and composer

- [x] V-B1 Intro shows the twin avatar (`avatar-robot-round.png`), the heading (typographic apostrophes: "I’m <first>’s") and 3 example chips (ux-flows.md A: "2–3 suggestion chips").
- [x] V-B2 The composer has focus on page load.
- [x] V-B3 Clicking a chip submits it immediately (request body = chip text), hides the intro, shows the visitor bubble, keeps composer focus.
- [x] V-B4 Enter sends; the composer clears and keeps focus.
- [x] V-B5 Clicking the send button sends; the composer clears and keeps focus.
- [x] V-B6 Shift+Enter inserts a newline without sending; the sent bubble keeps the line break.
- [x] V-B7 Enter on an empty / whitespace-only composer sends nothing.
- [x] V-B8 The composer has focus after the stream completes (mocked and real nano run).
- [x] V-B9 While a reply is in flight the send button is disabled and the textarea stays editable and focused (composer "sending" state).
- [x] V-B10 The composer auto-grows with more lines, caps at 160px, and shrinks back to one row after sending.
- [x] V-B11 A second Enter while a reply is in flight does not send; the draft waits and sends after the reply.
- [x] V-B12 Enter in the name field moves focus to the composer (no send); the name is remembered.
- [x] V-B13 Composer "disabled" state (matrix): the visitor screen never disables the textarea, so focus is never lost; the busy state disables only the send button (V-B9). Verified by code review. (The admin composer is disabled only while a thread failed to open, A-N15.)

## V-C. Visitor: bubbles and stream states (mocked stream, deterministic)

- [x] V-C1 The optimistic visitor bubble appears at once (`data-pending`) with initials from the name field ("TEST Visitor" -> "TV"); the `start` event confirms it (`data-id`).
- [x] V-C2 Unnamed visitor: the token shows the visitor icon (`data-anonymous`), and `name` is sent as null.
- [x] V-C3 Editing the name updates the initials of bubbles already shown.
- [x] V-C4 thinking: avatar bubble with three dots + "thinking" label, `aria-busy=true`.
- [x] V-C5 tool-calling: live mono row "Calling faq_tool…" (JetBrains Mono, animated ellipsis).
- [x] V-C6 tool-returned: row collapses to done "Looked up the FAQ · Q11"; label switches to "writing".
- [x] V-C7 typing: streamed Markdown renders progressively (bold visible mid-stream) with the caret.
- [x] V-C8 complete: the stored content replaces the stream (list, code, link), `data-id` set, `aria-busy` removed, live region announces the reply; screenshots dark + light.
- [x] V-C9 push_tool rows: delivered -> "Notified <first name> · push_tool"; `ok:false` -> "Flagged for <first name> · push_tool".
- [x] V-C10 An `error` event shows an inline error notice inside the reply; composer re-enabled and focused; the visitor can send again.
- [x] V-C11 A dropped stream keeps the partial text and shows "The connection dropped…"; no page error.
- [x] V-C12 Links in replies open in a new tab (`target=_blank`, `rel=noopener noreferrer`); clicking one opens a popup and leaves the chat in place.
- [x] V-C13 Unsafe reply Markdown is sanitised: no `<img>`, `<script>`, `<iframe>`, `javascript:` links, inline handlers, style or class attributes; nothing executes.
- [x] V-C14 The day separator ("Today · <time>") appears as soon as the visitor message is confirmed, not when the reply completes (regression test for the bug fixed below).
- [x] V-C15 An `error` after `tool_called` but before `tool_output` repaints the live row as stopped: "faq_tool · stopped", i-close, muted, no ellipsis, no pulse; the error notice follows (screenshot `visitor-stream-error-mid-tool`).
- [x] V-C16 The Avatar's reply token is the robotic twin (SPEC UI): its computed `background-image` names `avatar-robot` and that URL is served as `image/png` (200), on a streamed reply (desktop, and the phone stream test) and on replies restored from history (V-G9 test); the reply has no owner photo, and the visitor token shows initials ("TS").

## V-D. Visitor: Qn instant answers (real server, no LLM call)

- [x] V-D1 "Q2" -> reply tagged "instant · Q2" (tooltip "no model call"), starting with "**Q2:** <full question from faq.jsonl>" followed by the answer.
- [x] V-D2 "q11" (lowercase) -> Markdown with bold title and >= 2 https links, all new-tab.
- [x] V-D3 "Q99" -> "There is no Q99…" naming the valid range (Q1 to Q16 from faq.jsonl); the tag reads just "instant" (it does not claim a Q99 entry exists).
- [x] V-D4 Instant replies arrive in < 5 s with no tool rows.
- [x] V-D5 Instant rows persist: after a reload (Keep chat) they re-render with the instant tag.
- [x] V-D6 Markdown headings in a reply (the FAQ answer with `###` headings, Q6) render in Newsreader at >= 1.15x the bubble text, with more space above than below, so each groups with its own section (screenshot `visitor-instant-headings`).

## V-E. Visitor: `?q=N` deep link

- [x] V-E1 Fresh `/?q=2&ref=test#top` auto-submits Q2, renders the answer, removes only `q` (keeps `ref` and the hash); a reload does not re-submit.
- [x] V-E2 `/?q=3` with a kept chat: history loads first, then Q3 is appended (order visitor Q1, avatar Q1, visitor Q3, avatar Q3); same conversation id; name restored.
- [x] V-E3 `/?q=abc` sends nothing and the parameter is still removed.

## V-F. Visitor: session (Keep chat, Reset)

- [x] V-F1 Keep chat defaults on; cookie `avatar_cid` holds a v4 UUID (Path=/, SameSite=Lax, ~1 year).
- [x] V-F2 Keep chat on: reload restores the same id, all messages in order (same ids), the name (also from the server when local storage is empty), scrolled to the latest, composer focused.
- [x] V-F3 Keep chat off: cookie removed, preference stored, live-region note; the chat on screen keeps one id; reload -> fresh chat (intro, new id), switch still off.
- [x] V-F4 Turning Keep chat back on writes the current id to the cookie; reload restores that thread.
- [x] V-F5 Reset: new id in the cookie, thread and day separators cleared, intro back, composer focused, announcement; the old conversation is still on the server.
- [x] V-F6 After Reset, the next message goes to the new id and a reload shows only the new thread.
- [x] V-F7 Reset during a streaming reply drops it cleanly; late events from the old stream are ignored; the next send uses a new id.

## V-G. Visitor: human in the loop and polling

- [x] V-G1 An owner message posted through the real admin API appears within ~12 s (measured) as a human bubble.
- [x] V-G2 Human bubble: owner photo (`avatar-human.png`), 2px yellow ring equal to `--yellow-strong`, halo, spark badge, tinted bubble (gradient layer), glow shadow, label "<OWNER_NAME> · live" with the live icon; screenshots dark + light + close-up.
- [x] V-G3 A Markdown link in the owner's message opens in a new tab; the live region announces "<OWNER_NAME> joined the conversation".
- [x] V-G4 The Avatar does not react: stored roles stay visitor, avatar, human.
- [x] V-G5 No duplicate bubbles after stream + poll (unique `data-id`s, exact count).
- [x] V-G6 Poll cadence is 10 s while active (fake clock: 29 consecutive gaps of 10 s).
- [x] V-G7 After 5 quiet minutes the cadence eases to 60 s (switch at ~300 s), and a send brings the next poll back to ~10 s.
- [x] V-G8 A fresh chat that has sent nothing does not poll.
- [x] V-G9 Scrolled up reading: a new owner message shows the "Latest" pill instead of moving the view; the pill jumps to the latest and refocuses the composer.
- [x] V-G10 A failed history load shows "Couldn't load your earlier messages…" with the neutral alert icon (i-live stays reserved for the human bubble), and the next poll recovers the thread (notice removed).
- [x] V-G11 A message arriving by poll is activity too (`poller.ts`: `gotNew` resets the quiet clock). Fake clock, same test as V-G6/G7: after another 5 quiet minutes the last two gaps are 60-61 s; the owner then posts through the admin API; the next scheduled slow poll (60-61 s after the previous one) brings it and the human bubble renders; the following poll gaps are 10-11 s again (at least 3).

## V-H. Visitor: abuse guards and safety (real server)

- [x] V-H1 The 21st message within a minute (20 real Q1 sends first) gets HTTP 429 and the friendly "You're sending messages too quickly…" notice; nothing stored, no stray bubble, draft restored, composer focused.
- [x] V-H2 Mocked 429: rate-limit notice style (`notice--rate-limit`, clock icon, `role=alert`), dismissible, draft restored.
- [x] V-H3 A message over 512 KiB gets HTTP 413 and the "far too long" error notice; draft restored, nothing shown in the thread.
- [x] V-H4 A 25,000-character message is confirmed as the clamped text (first 20,000 characters + the truncation note), both in the bubble and in storage; the nano reply completes.
- [x] V-H5 Visitor HTML (`<img onerror>`, `<script>`, `<b>`) renders as literal text, live and after reload; no element is created, nothing executes, no dialog.

## V-I. Visitor: real Avatar replies (openai/gpt-5.4-nano)

- [x] V-I1 An example chip streams a real reply: states observed live include typing before complete; tool rows (if any) end done; no error notice; composer focused; screenshots dark + light.
- [x] V-I2 A free-form question ("Which city does <first name> live in now?") is answered from the knowledge (mentions Tallinn) and is still there after a reload.
- [x] V-I3 Two browsers (separate contexts) get different conversation ids and separate threads.

## V-J. Visitor: theme

- [x] V-J1 The toggle switches dark <-> light: `html[data-theme]`, `localStorage['avatar-theme']`, moon/sun icon swap, aria-label update, surfaces change colour; desktop refocuses the composer.
- [x] V-J2 The choice survives a reload and is shared with `/admin`.
- [x] V-J3 Screenshots of intro, stream, instant answer, human bubble and responsive widths in both themes.

## V-K. Visitor: responsive and touch

- [x] V-K1 360 / 390 / 768 / 1024 / 1440 px with a thread holding a long unbroken URL + word, links, an instant answer and a human bubble: no horizontal overflow; no bubble past the viewport.
- [x] V-K2 At each width the composer dock's bottom edge is the viewport's bottom edge and the textarea is fully on screen; the owner's name stays visible in the header.
- [x] V-K3 Screenshots at every width (dark) plus light at 390 / 768 / 1440, and the intro at every width.
- [x] V-K4 (mobile, touch) Tapping Theme, Keep chat and Reset never focuses the composer (the keyboard does not pop up).
- [x] V-K5 (mobile) Two-row top bar (name + Keep chat on row 2), icon-only Reset, short placeholder, no key hints, docked composer, 16px inputs, >= 40px touch targets.
- [x] V-K6 (mobile) Tap to send a Qn; tap a chip; stream states (tool-calling, typing, complete) and the human bubble render without overflow; screenshots dark + light. No sticky hover on touch: with the pointer left on the send button it keeps its resting purple (`(hover: hover)` is false; hover rules are scoped to hover-capable devices).
- [x] V-K8 (mobile) Phone shots in both themes of states that only had desktop or dark coverage: stream-complete and instant answer in light (`visitor-stream-complete-light`, `visitor-instant-light`); the rate-limit notice from a mocked 429 (draft kept, notice in view, the 22 px close icon hit-tests as a 40 px target: taps 8 px outside it on all four sides still hit it; dismissible) (`visitor-rate-limit-dark/-light`); a reply `error` event (inline notice in view, send re-enabled) (`visitor-stream-error-dark/-light`); the intro after Reset (new cookie id, portrait and headline in view, composer docked) (`visitor-after-reset-dark/-light`). No horizontal overflow in any of them.
- [x] V-K7 Short viewports (390x640, 1280x600, 844x390): the intro opens scrolled to the top with the portrait and headline in view, also after a reload of a kept (empty) chat; at 390x640 and 1280x600 the three chips fit above the composer too (short-height intro tightening). Screenshots `visitor-intro-short-*`.

## A-L. Admin: auth gate (SPEC Q&A #6)

- [x] A-L1 Signed out: `/admin` shows the gate (GET `/admin/api/session` -> 401), password field focused (idle), owner name in the lede, no dashboard; screenshots dark + light.
- [x] A-L2 Wrong password (a single attempt, failed logins are rate limited): "Incorrect password" (`role=alert`), `aria-invalid`, field refocused with text selected; typing clears the error.
- [x] A-L3 Empty submit: "Enter the admin password." without any request.
- [x] A-L4 Correct password -> dashboard (app bar, Admin pill, Secure session, inbox, placeholder); the session cookie is httpOnly (not visible to page scripts).
- [x] A-L5 The session survives a reload.
- [x] A-L6 Sign out -> gate (field focused), admin API 401 afterwards; a session revoked mid-use sends the dashboard back to the gate with "Your session has ended…".
- [x] A-L7 Every admin API route (session, list, open, post, resolve) is 401 without the cookie, and with a forged cookie.
- [x] A-L8 Logging in (ux-flows.md states matrix: gate · logging-in · error · logged-in): with the correct password's `POST /admin/login` held by `page.route`, the submit button is disabled with `is-busy` and the label "Signing in…", the form has `aria-busy=true`, no error, no dashboard; a second Enter sends no second request (screenshot `admin-gate-logging-in`). Released: 200, then the dashboard, still exactly one login request.

## A-M. Admin: inbox

- [x] A-M1 Rows show the initials token, visitor name, time, and the preview (beginning of what the visitor said).
- [x] A-M2 Most recent first (seed A then B -> B above A); a new visitor message in A moves it back to the top.
- [x] A-M3 New conversations show the unread dot; after opening and moving on, the row shows the read check.
- [x] A-M4 Needs-you rows: yellow row background + "Needs you" badge; "Needs you" chip gets `has-items` and a count (list decorated for the screenshot; the real flag is A-O). At <= 1180px (1024) the compact yellow dot (mockup) replaces the pill so the preview keeps its room (screenshot `admin-inbox-needs-you-1024`).
- [x] A-M5 Active row styling (`is-active`, `aria-selected`) and hover styling (background change).
- [x] A-M6 Search by name, by conversation id, by a phrase from the visitor's message (A-O); "No matches" empty state; Esc clears; Enter opens the first match.
- [x] A-M7 Filter chips: Needs you and Unread filter the list (with counts), clicking the active chip returns to All.
- [x] A-M8 The tab title "(n) Avatar Admin" equals the number of unread rows; the thread being viewed counts as read.
- [x] A-M9 Live refresh: a visitor message in an existing thread and a brand-new conversation both appear within ~12 s without a reload.
- [x] A-M10 Visitor-supplied HTML in the name and in a message renders as text in the inbox row, thread head and thread (stored-XSS check); nothing executes.
- [x] A-M11 Tabbing into the inbox list before any row is selected shows a focus ring on the list; once a row is active the ring moves to that row (screenshot `admin-inbox-list-focus`).

## A-N. Admin: thread

- [x] A-N1 Opening a thread renders every message in order (visitor / avatar roles) and scrolls to the latest.
- [x] A-N2 Opening marks it read and clears needs-you: the admin API then reports `unread_count` 0 and `needs_attention` false; the row reads as read after moving on.
- [x] A-N3 Thread head: visitor name, initials, `conv_<first 6 hex>`, "started <time>", "<n> messages" (updates on new messages), full id as tooltip.
- [x] A-N4 Instant tags ("instant · Q2", "instant · Q12") and done tool rows ("Looked up the FAQ · Q15", "Notified you · push_tool").
- [x] A-N5 "Avatar asked for you" flag + Mark resolved when the thread needs the owner; Mark resolved calls the API, hides both and refocuses the composer.
- [x] A-N6 The posting-as note names the owner "<OWNER_NAME> · live" (from config) and says the Avatar won't reply; no em-dash (style.md).
- [x] A-N7 Enter sends a human message: bubble labelled "You · sent to visitor", composer cleared and focused; click-to-send works too; stored with role human.
- [x] A-N8 Shift+Enter inserts a newline; the message is stored and shown with the line break.
- [x] A-N9 The visitor (another browser, chat open) sees the owner's messages within ~12 s labelled "<OWNER_NAME> · live".
- [x] A-N10 ArrowDown / ArrowUp move between conversations from the search field and from an empty composer (stops at the ends); Enter on the focused list opens the active conversation.
- [x] A-N11 Arrows do not switch conversations while typing in the composer or while the thread itself has focus (reading); drafts are kept per conversation.
- [x] A-N12 The open thread updates live when the visitor sends a new message (~12 s).
- [x] A-N13 A reply that fails to post shows "Not sent: <detail>", keeps the draft and stores nothing.
- [x] A-N14 Switching threads while the next one loads (fetch held): the head shows the new visitor and the body shows only the "Loading conversation" status, never the previous visitor's bubbles; then the new thread renders (screenshot `admin-thread-switching`).
- [x] A-N16 Identity images and no emoji on the dashboard (SPEC UI): in an open thread the Avatar's rows carry the robotic twin (`avatar-robot`, served as PNG) and never the owner photo, the owner's own rows carry `avatar-human.png` (served as PNG), visitor rows carry initials and no picture; with the inbox filtered to that thread and the thread open, the visible text has no `\p{Extended_Pictographic}` code point.
- [x] A-N15 A thread that fails to open (503): the error with Try again; the row keeps `is-attention`, `is-unread` and the pill, the "Needs you" count is unchanged; the composer and send button are disabled. Try again renders the thread, re-enables and focuses the composer, and the row reads as read (screenshot `admin-thread-open-failed`).

## A-O. Admin: real push, end to end (one Pushover notification per run)

Last passed in the final run (2026-09-22 04:45 UTC, against the container, push delivered); before that against the Docker image in e2e plan run 18, after the 03:22 `admin/thread.ts` / `shared/composer.ts` change and the bug 3 fix in `backend/app/agent.py`.

- [x] A-O1 A visitor asks to get in touch and leaves an email -> the Avatar calls push_tool (real nano + real Pushover); the admin API reports `needs_attention` true and unread > 0.
- [x] A-O2 The inbox row shows "Needs you" on a yellow row; opening shows "Avatar asked for you" and the push_tool row; the API then reports `needs_attention` false, `unread_count` 0 and every row read.
- [x] A-O3 The owner replies from the composer -> the flag goes, the row is no longer yellow; the visitor's page shows the push row ("<first name> · push_tool") and the owner's reply labelled "<OWNER_NAME> · live".

## A-P. Admin: responsive (SPEC: master/detail on mobile)

- [x] A-P1 (mobile) The inbox fills the screen and the thread pane is hidden; no horizontal overflow.
- [x] A-P2 (mobile) Tapping a conversation opens its full thread scrolled to the latest message, with a back control; one history entry is pushed; the keyboard does not pop up.
- [x] A-P3 (mobile) The back control and the browser Back both return to the inbox (row still active); Forward re-opens the thread; replying from the phone works.
- [x] A-P4 (mobile) Screenshots of gate, inbox and thread in dark and light.
- [x] A-P5 (desktop) Sidebar and thread side by side at 1440 and 1024, no overflow, no back control; the filter chips stay on one row (three-digit counts at 1024); the posting-as note uses `text-wrap: pretty` (no single-word last line).
- [x] A-P7 (360 x 780, desktop Chromium resized) A flagged thread (list decorated) whose owner reply holds a 160-character URL and a 120-character word: master/detail applies (`data-view=inbox`, sidebar full width, thread pane hidden, compact yellow dot not the pill); a click opens `data-view=thread` with the back control, the flag and Mark resolved, 5 messages, "You · sent to visitor", scrolled to the latest; the owner chip shrinks to the photo (<= 460 px rule); no horizontal overflow, no bubble past the viewport, composer dock on screen (screenshots `admin-width-360-inbox-dark`, `admin-width-360-dark`).
- [x] A-P8 (768 x 1024, tablet portrait) Same checks as A-P7: master/detail with the back control (<= 820 px), no overflow; screenshots `admin-width-768-inbox-dark`, `admin-width-768-dark`, `admin-width-768-light`.
- [x] A-P9 (900 x 800, the 821-1040 px rules) Side by side: the 320 px sidebar left of the thread at the same top, no back control, the secure note hidden, the flag and Mark resolved shown, the long URL wraps inside its bubble, no overflow (screenshot `admin-width-900-dark`).
- [x] A-P6 (mobile) A flagged thread: the inbox row shows the compact yellow dot (not the pill); in the thread head the "Avatar asked for you" flag and Mark resolved sit side by side (<= 16px apart), both 40px tall; no overflow; screenshots dark + light.

## A-Q. Admin: theme

- [x] A-Q1 Dashboard with an open thread screenshotted in dark and light; the theme toggle persists (shared `avatar-theme`).

## Bugs found and fixed

- **Day separator popped in when the first reply finished (visitor).** The confirmed visitor
  bubble got its timestamp from the SSE `start` event, but day separators were only
  re-derived on `done`, so "Today · <time>" appeared at the end of the first reply and the
  thread jumped by one row (most visible on multi-second LLM replies; seen in the
  `visitor-stream-*` and `visitor-llm-in-flight` screenshots). Fix: `frontend/src/visitor/chat.ts`
  calls `updateDaySeparators(thread)` right after `confirmMessage()` on `start`. Regression
  test: V-C14 (in the stream-states test). Frontend rebuilt, both full runs green after the fix.

### Visual-QA polish, 2026-09-22 (18 findings from three visual QA judges)

Each finding was checked against the running UI (probe scripts plus the suite), then fixed within
the design system (tokens only; mockups as tie-breaker) or skipped with a reason.

- **Intro opened scrolled to the bottom on short viewports** (major). `ThreadScroller` started with
  auto-stick on, and its ResizeObserver snapped to the bottom while only the intro was shown
  (390x640: headline cut in half; 1280x600: portrait off-screen). Fix: `visitor/scroller.ts` has an
  intro mode (no stick, top in view) driven by `VisitorChat.syncIntro()`. `visitor/chat.ts` no longer
  scrolls an empty kept chat to the bottom. `visitor.css` tightens the intro under `max-height: 720px`.
  Test: V-K7.
- **Error mid-tool left a live "Calling faq_tool" row.** Fix: `shared/messages.ts` `fail()`
  repaints live rows as stopped ("faq_tool · stopped", i-close, muted); `base.css` styles
  `.is-stopped`, and only live rows pulse. Test: V-C15.
- **Connection notice used the human's i-live icon.** Fix: `createNotice()` defaults info notices to
  i-alert. Test: V-G10.
- **Sticky purple hover on the send button after a tap (touch).** Fix: hover rules for buttons,
  chips, icon buttons, social links, the Latest pill, filter chips and notice close are wrapped in
  `@media (hover: hover)` (`components.css`, `base.css`, `visitor.css`, `admin.css`). Test: V-K6.
- **Four suggestion chips (design: 2 to 3).** Dropped "What are your top skills?" (`index.html`). Test: V-B1.
- **"INSTANT · Q99" for a non-existent FAQ.** Fix: the tag shows "instant · Qn" only when the reply
  restates the question ("**Qn:** ...", the SPEC format), else "instant" (`instantHit()` in
  `shared/messages.ts`; also for streaming and stored rows). Test: V-D3.
- **Broken letter spacing in mobile screenshots** (test setup). Fix: desktop Chrome user agent for the
  `mobile` project in `playwright.config.ts` (and the phone contexts in `restart.e2e.spec.ts` /
  `three-way.e2e.spec.ts`; those Docker end-to-end specs were type-checked, not re-run here).
- **Switching threads showed the new head over the previous visitor's messages.** Fix:
  `admin/thread.ts` `beginOpen()` always clears the body and shows the loading status when
  switching; `admin.css` fades the status in after 180 ms, so a fast switch does not flash. Test: A-N14.
- **Phone/tablet: the flag and Mark resolved sat far apart at different heights.** Fix: at
  `max-width: 820px`, `.thread-actions` uses `justify-content: flex-start`, gap 8px, and the flag is
  40px tall. Test: A-P6.
- **Filter chips wrapped at 821-1180px with three-digit counts.** Fix: tighter chip padding, gap and
  tracking in that range (`admin.css`). Test: A-P5.
- **Posting-as note left "it." alone on its last line.** Fix: `text-wrap: pretty` plus a non-breaking
  space in "to it." (`admin.css`, `admin/thread.ts`). The same wrapping was added to notice text. Test: A-P5.
- **Every flagged row used the wide pill, hiding previews on narrow sidebars.** Fix: flagged rows
  carry both markers and CSS shows the compact yellow dot at <= 1180px, the pill above that
  (`admin/inbox.ts`, `admin.css`). Tests: A-M4, A-P6.
- **A thread that failed to open lost its needs-you/unread markers; the composer stayed live.** Fix:
  `admin/dashboard.ts` `rowState()` treats the viewed thread as read only once it has loaded;
  `ThreadPanel.showError()` disables the composer, and a successful render re-enables it (focused
  on desktop). `shared/composer.ts` `setDisabled()` no longer moves focus itself. This regression
  came up in run A as A-P2: the phone keyboard popped up on every thread open. Test: A-N15.
- **No focus indicator when tabbing into the inbox with nothing selected.** Fix:
  `.convo-list:focus-visible:not(:has(.convo-item.is-active))` gets the inset focus ring. Test: A-M11.
- **Bubble headings looked smaller than the body text and crowded the previous paragraph.** Fix:
  `base.css` sets h1-h6 to 1.4 / 1.3 / 1.2 / 1.1em with `margin: 1em 0 0.3em`. Test: V-D6.
- **Em-dash in the posting-as hint** (style.md forbids them). Now "Posting as you. The visitor sees
  this…". Test: A-N6.
- **Straight apostrophes in the serif headline.** Changed to U+2019 in the intro heading, intro text
  and composer placeholder / label. Tests: V-A3, V-B1, V-K5.

## Observations (not changed)

- The "instant · Qn" vs "instant" tag distinction uses the SPEC's reply format (a hit restates
  "**Qn:** <question>"). The backend stores `{"type": "instant", "faq": n}` for hits and misses
  alike, so a `found` flag on that marker would be a cleaner signal (backend, out of this scope).

- Clicking the send button while a reply is streaming (the button is disabled) moves focus off
  the composer, because a disabled button cannot keep focus in place. Enter while streaming
  keeps focus and the draft (V-B11). Minor; left as is.
- With Keep chat off, the name field is still remembered in `localStorage` (only the
  conversation id is dropped). This matches the implementation's documented intent.
- Initials use the first letters of the first and last words, so "TEST Layout 1GCXO" shows "T1".
  This is expected for names ending in a number.
- (Added by the Docker end-to-end run, 2026-09-22; see `e2e_test_plan.md`.) This suite also ran
  against the container on :8000: 73/74 (A-L4 hit a transient Supabase 500, fixed in
  `backend/app/db.py`), then 74/74, then twice 72/73 with the push test left out. V-I2 ("Which city does <first> live in
  now?") failed twice on a Russian reply to the English question. That was a real backend bug
  (about 9% of nano runs), fixed in `backend/app/knowledge.py`; about 2% remains on nano, so V-I2
  can still fail occasionally (it passed 4/4 on a repeat right after the fix). The assertion was left
  strict because an English question should get an English answer. On the final image (e2e plan
  runs 18-20, 90 tests) it failed once more the same way, then passed 5/5 and in the next full run
  (89/89).
- (Added by the Docker end-to-end run.) Shared suite files changed for the end-to-end specs:
  `support/fixtures.ts` exports `watchPage()` (the same console/page-error guard, reusable for extra
  pages), `support/env.ts` gained `envValue()` (`adminPassword()` uses it), and
  `playwright.config.ts` gained a `three-way` project for `*.e2e.spec.ts` (excluded from `desktop`).
  `npm run test:e2e` selects `--project=desktop --project=mobile`: 74 tests then, 90 now.
- (Gap-closing pass.) `support/ui.ts` gained `expectTokenImage()` (a token's computed picture names
  the expected file and that URL is served as a PNG) and `expectNoEmoji()`. `embed.spec.ts` runs in
  the desktop project; it serves its stand-in host page from a real `127.0.0.1` server because
  Chromium's local-network checks refuse a `localhost` frame inside a routed (fake-host) page, and it
  tolerates the one console message Chromium logs for `autofocus` inside a cross-origin frame (see the
  e2e plan, Observations).

## Cleanup (orchestrator)

- [x] Delete screenshots (2026-09-22: all 270 PNGs in test/screenshots/ removed, plus frontend/test-results and frontend/playwright-report)
- [x] Delete test conversation threads in Supabase (2026-09-22: 851 conversations / 3,475 rows deleted; messages table verified at 0 rows)
