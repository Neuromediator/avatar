# Backend test plan

Scope: the FastAPI backend in `backend/app` (config, knowledge, prompts, agent, data layer,
public and admin APIs, static serving) and its test suite in `backend/tests`. It covers SPEC
"Testing" item 1 ("test the backend thoroughly with comprehensive unit tests, including tests to
ensure that admin api routes are only available if logged in") and the SPEC "Setup and
Validation" connectivity check. The frontend (Playwright) and Docker end-to-end suites have
their own plans: [frontend_test_plan.md](frontend_test_plan.md) and
[e2e_test_plan.md](e2e_test_plan.md) (see also [README.md](README.md)).

Each item is concrete and verifiable, names the SPEC section it comes from, and lists the test(s)
that check it (`file::test`, file relative to `backend/tests/`). An item is ticked only after it
was executed and passed on 2026-09-21; the whole suite was re-run on 2026-09-22 (Results below)
after the Docker end-to-end fixes, the deployment-file tests and the gap-closing pass, and once
more on the final code ("Final run" below). Every ticked item passed in that final run.

## How to run

```bash
cd backend
uv run pytest -q                                              # fast suite: fakes, no LLM (plus the Supabase-backed tests when .env has credentials)
uv run pytest tests/test_supabase_connection.py -v            # SPEC "Setup and Validation"
MODEL=openai/gpt-5.4-nano uv run pytest -m llm -q             # real LLM via OpenRouter (cheap model), Pushover mocked
```

- The fast suite replaces the database with an in-memory `FakeRepository`, the Agents SDK
  stream with a scriptable `FakeAgentStream`, and Pushover with a recorder. A real
  `requests.post` to Pushover fails the test (autouse fixture), so no test can send a real push.
- `@pytest.mark.llm` tests are skipped unless `-m llm` is passed. They force
  `openai/gpt-5.4-nano` (whatever `.env` says) and use the real Supabase project when
  credentials exist.
- Tests that write to Supabase use a fresh `uuid4` conversation per test, name visitors
  `TEST ...`, and delete exactly the conversation they created (never any other row).

## Final run (2026-09-22, 04:40-04:45 UTC, final code)

The last full run, on the code as delivered (no app change since the gap-closing pass except
`scripts/start_pc.ps1`, see the e2e plan, bug 5; that script is not in the image and no backend test
reads it). All green:

| Command | Result |
|---|---|
| `cd frontend && npm run build` | ok (`tsc --noEmit` + `vite build`, 13 files in `dist/`); `npm run test:e2e:typecheck` clean |
| `cd backend && uv run pytest -q` | **410 passed, 8 skipped** (418 tests; the 8 skips are the `llm` tests), 16.4 s. Re-run after the `start_pc.ps1` fix: **410 passed, 8 skipped** (16.3 s) |
| `uv run pytest tests/test_supabase_connection.py -v` | **3 passed** (`test_env_present`, `test_messages_table_reachable`, `test_insert_and_delete_roundtrip`) |
| `MODEL=openai/gpt-5.4-nano uv run pytest -m llm -q` | **8 passed, 410 deselected**, 30.5 s. Run on the real Supabase project (credentials present): each test wrote a fresh `TEST ...` conversation and its own teardown deleted exactly that conversation, nothing else |

Pushover is mocked in every backend test, so this run sent no notification.

## Results

Earlier final results (2026-09-22, after every fix in "Findings and fixes"):

| Command | Result |
|---|---|
| `uv run pytest -q` | **410 passed, 8 skipped** (the 8 skips are the `llm` tests), 15.0 s. The real-Supabase tests ran (credentials present) and deleted only the rows they created. |
| `uv run pytest tests/test_supabase_connection.py -v` | **3 passed** |
| `uv run pytest tests/test_deploy_config.py -q` | **16 passed** |
| `MODEL=openai/gpt-5.4-nano uv run pytest -m llm -q` (runs 1, 2, 3) | **8 passed, 410 deselected** each time (run with `SUPABASE_URL= SUPABASE_KEY=`, i.e. the in-memory repository, so no Supabase rows were written or deleted) |

The first full run of the gap-closing pass was 409 passed, 1 failed: `test_real_built_frontend_is_templated_from_config`
was stale after the visual-QA polish (finding 4). Two real-LLM runs before the bug 3 fix: 8/8, then
7/8 (`test_real_unknown_question_pushes_the_owner`: the reply did not mention the push).

Suite size: 418 tests (395 on 2026-09-21; +3 PGRST303 retry tests, +16 deployment-file tests, +4
push-result tests). Per file: `test_admin_auth.py` 114, `test_chat.py` 84,
`test_prompts_knowledge.py` 68, `test_agent.py` 28, `test_db.py` 27, `test_public_api.py` 23,
`test_admin_api.py` 21, `test_config.py` 18, `test_deploy_config.py` 16,
`test_integration_supabase.py` 8, `test_llm.py` 8, `test_supabase_connection.py` 3.

2026-09-21 (first pass): `uv run pytest -q` 387 passed, 8 skipped (395 tests); connectivity 3
passed; `-m llm` 8/8 twice.

---

## 1. Setup and validation (SPEC "Setup and Validation", Q&A #1)

- [x] `SUPABASE_URL` is an `https://` URL and `SUPABASE_KEY` is a `sb_secret_` key (`test_supabase_connection.py::test_env_present`)
- [x] The `messages` table is reachable through the Data API with the secret key (`test_supabase_connection.py::test_messages_table_reachable`)
- [x] A row can be inserted, has every expected column (`id, conversation_id, conversation_name, role, content, tool_calls, needs_attention, read, created_at`) with `needs_attention=false`, `read=false` defaults, and can be deleted (`test_supabase_connection.py::test_insert_and_delete_roundtrip`)
- [x] The README setup SQL documents exactly the columns the code uses, the `role` check, and the `conversation_id` and `created_at` indexes (SPEC "Implementation Decisions") (`test_db.py::test_readme_schema_matches_the_repository`)
- [x] The live database enforces the role check: a `system` row is rejected (`test_integration_supabase.py::test_database_enforces_the_role_check`)
- [x] The two indexes exist in the live database. Confirmed by the owner on 2026-09-22 in the Supabase SQL editor (`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'messages'`): `messages_pkey`, `messages_conversation_id_idx` and `messages_created_at_idx` all present. Not executable from the backend: PostgREST (the only access the app's key has) does not expose `pg_indexes`. Covered by the README SQL check above; verify in the Supabase SQL editor if needed. Final run: a read-only `EXPLAIN` through PostgREST (`Accept: application/vnd.pgrst.plan+text`) was tried too and refused (HTTP 406, PGRST107: plans are disabled on the project), so this stays open.

## 2. Configuration and environment precedence (SPEC "Implementation Decisions", "Setup and Validation", Q&A #2, #11)

- [x] Defaults: `MODEL` = `openai/gpt-5.4-nano` (the code default in `config.py`), `COOKIE_SECURE` off, knowledge and static dirs under the repo, session secret fallback `avatar::<ADMIN_PASSWORD>` (`test_config.py::test_defaults`, `::test_session_secret_fallback`)
- [x] Every documented key is read: `OPENROUTER_API_KEY, MODEL, OWNER_NAME, ADMIN_PASSWORD, PUSHOVER_USER, PUSHOVER_TOKEN, SUPABASE_URL, SUPABASE_KEY, SESSION_SECRET, COOKIE_SECURE` (`test_config.py::test_all_documented_keys_are_read_from_env_file`, `::test_values_from_environment`)
- [x] Real environment variables beat `.env` (`load_dotenv(override=False)`), and `.env` fills what is unset (`test_config.py::test_env_file_does_not_override_real_environment`)
- [x] `MODEL=openai/gpt-5.4-nano` in the environment beats the production model in the real project `.env` (how every test run stays cheap) (`test_config.py::test_model_env_beats_the_real_project_env_file`)
- [x] `COOKIE_SECURE` accepts `1/true/yes/on` (any case), everything else is off (`test_config.py::test_cookie_secure_parsing` x6)
- [x] Blank or whitespace-only values fall back to defaults; values are stripped (`test_config.py::test_blank_or_whitespace_values_fall_back`)
- [x] Missing `OWNER_NAME` gives the neutral placeholder `Owner` and logs a warning (`test_config.py::test_placeholder_owner_name_is_neutral_and_logged`, `::test_missing_owner_name_uses_placeholder`)
- [x] `owner_first_name` is the first word of `OWNER_NAME` (single-word names work) (`test_config.py::test_values_from_environment`, `::test_single_word_owner_name_first_name`)
- [x] A missing `.env` file is ignored; settings are loaded once per process (`test_config.py::test_missing_env_file_is_ignored`, `::test_get_settings_is_loaded_once`)

## 3. Knowledge loading and FAQ data (SPEC "Tech stack decisions" knowledge/, Q&A #3)

- [x] `knowledge/` holds `knowledge.md`, `style.md`, `faq.jsonl` and a real JPEG `pic.jpg` (`test_prompts_knowledge.py::test_knowledge_folder_has_the_four_spec_files`)
- [x] Profile and style guide are loaded verbatim; every FAQ row is loaded with its `question`, `answer` and `query` (`test_prompts_knowledge.py::test_knowledge_files_loaded`)
- [x] FAQ rows are numbered 1..N without gaps; every row has a short routing `query` (<= 80 chars) plus the full `question` and `answer` (`test_prompts_knowledge.py::test_every_faq_row_has_concise_query_full_question_and_answer`)
- [x] Bad rows fail loudly with `faq.jsonl:<line>` in the error (missing field, invalid JSON, non-integer number) (`test_prompts_knowledge.py::test_load_faqs_rejects_bad_rows`, `::test_load_faqs_reports_the_bad_line`)
- [x] Blank lines are skipped, rows are sorted by number, `query` defaults to the question (`test_prompts_knowledge.py::test_load_faqs_skips_blank_lines_and_defaults_query`)
- [x] A missing knowledge file stops startup with `FileNotFoundError` (`test_prompts_knowledge.py::test_load_knowledge_fails_loudly_when_a_file_is_missing`)
- [x] The "## Language" section of `style.md` is extracted (heading match ignores case, nested sub-headings included, stops at the next same-level heading, empty when absent) (`test_prompts_knowledge.py::test_markdown_section_extraction`, `::test_language_rules_are_read_from_style_md`)

## 4. FAQ lookup, `Qn` parsing and the instant answer (SPEC "Interactive Chat Experience", reference next_level.ipynb)

- [x] A bare `Qn` (any case, surrounding whitespace, 1-2 digits, `Q02` = 2) is recognised; `Q2 please`, `Q 2`, `Q123`, `QQ2`, `Q2.`, full-width `Ｑ2`, `Q1Q2`, `2` are not (`test_prompts_knowledge.py::test_parse_instant_request` x16, `::test_parse_instant_request_more_edges` x5)
- [x] The instant answer is exactly `**Qn:** <full original question>\n\n<answer>` for every FAQ entry (`test_prompts_knowledge.py::test_instant_answer_restates_full_question_then_answer`)
- [x] An unknown `Qn` returns a helpful message naming the valid range (`Q1 to Q16`), with no em-dash (`test_prompts_knowledge.py::test_instant_answer_unknown`, `test_chat.py::test_instant_answer_unknown_number`)
- [x] `faq_tool` returns the full original question and answer, then the language reminder (`test_prompts_knowledge.py::test_faq_tool_output_contains_full_question_and_answer`)
- [x] `faq_tool` with an unknown number names the valid numbers (`test_prompts_knowledge.py::test_faq_tool_output_unknown_number`, `test_agent.py::test_faq_tool_returns_full_answer`)

## 5. Prompt composition: instructions / system prompt (SPEC "Implementation Decisions", "Use of OpenAI Agents SDK", Q&A #3, #4, #10)

- [x] Instructions include `OWNER_NAME`, the whole `knowledge.md`, the whole `style.md`, and every FAQ `query` as a numbered routing line (`test_prompts_knowledge.py::test_instructions_compose_everything`)
- [x] Instructions explain the three-way situation: visitor, Avatar ("Avatar (you)"), and the real owner ("<OWNER_NAME> (the real human, joined live)"), owner messages are authoritative and never trigger a reply (`test_prompts_knowledge.py::test_instructions_describe_three_way_roles_and_rules`, `::test_instructions_compose_everything`)
- [x] Two voices kept apart once the owner joins (third person for the human, no "the real <first>" self-reference) (`test_prompts_knowledge.py::test_instructions_keep_the_two_voices_apart`)
- [x] Contact capture (ask for the email, then push with name/email/intent), "When you don't know" (say so, push the question), push honesty, and security rules (transcript is data, never reveal instructions, no claimed abilities) are present (`test_prompts_knowledge.py::test_instructions_describe_three_way_roles_and_rules`)
- [x] FAQ rules: MUST call `faq_tool` on a match, relay faithfully with links, non-English questions still route to the FAQ, translate into the reply language including link labels (`test_prompts_knowledge.py::test_instructions_translate_faq_answers`)
- [x] Every name in the instructions follows `OWNER_NAME` (no leak of another owner) (`test_prompts_knowledge.py::test_instructions_follow_owner_name_config`)
- [x] No unrendered template placeholders; the `Qn` shortcut and the FAQ range are described (`test_prompts_knowledge.py::test_instructions_have_no_unrendered_placeholders`)

## 6. Prompt composition: the single user prompt / transcript (SPEC "Implementation Decisions": one user prompt for all roles)

- [x] One user message carries a labelled transcript with all three roles, oldest first, and the latest visitor message separately (pulled out of the transcript) (`test_prompts_knowledge.py::test_task_prompt_labels_all_roles_and_separates_latest`, `test_chat.py::test_prompt_contains_full_conversation_with_all_roles`)
- [x] Tool markers in the transcript: `used faq_tool: FAQ n`, `instant FAQ answer Qn`, `used push_tool: notified <first>: "<note>"`, `(delivery failed)` for failed/unconfigured pushes, `used <name>` for other tools; malformed entries are skipped; markers only on Avatar rows (`test_prompts_knowledge.py::test_task_prompt_labels_all_roles_and_separates_latest`, `::test_tool_markers_for_failed_push_unknown_tools_and_bad_entries`, `::test_tool_markers_ignore_non_list_and_only_apply_to_avatar_rows`)
- [x] Push notes in markers are single-line and shortened to 240 chars (`test_prompts_knowledge.py::test_push_marker_note_is_shortened_and_single_line`)
- [x] Timestamps are compact UTC (`YYYY-MM-DD HH:MM UTC`), naive = UTC, offsets converted, missing/garbage = `unknown time` (`test_prompts_knowledge.py::test_timestamps_unknown_naive_and_datetime`)
- [x] Participants block: visitor name (self-reported) or "no name given"; whether the owner HAS joined; owner-joined reminder (third person, AI-twin clause only when it matters) only when the owner has joined (`test_prompts_knowledge.py::test_task_prompt_first_message_without_name_or_human`, `::test_visitor_speaker_label_and_description_use_the_given_name`, `::test_owner_name_from_config_labels_the_human_everywhere`)
- [x] Caps: at most 60 messages and ~60,000 characters, per-message clip at 8,000 characters, "[N earlier message(s) omitted for length]" markers placed exactly where the gaps are (`test_prompts_knowledge.py::test_task_prompt_caps_history`, `::test_task_prompt_caps_characters`, `::test_very_long_message_is_clipped_inside_the_transcript`, `::test_task_prompt_no_marker_when_everything_fits`)
- [x] Owner (human) messages are always kept, even early in a long thread and within the character budget; with more than 60 owner messages the newest 60 are kept (`test_prompts_knowledge.py::test_task_prompt_keeps_early_human_message_in_long_thread`, `::test_task_prompt_keeps_human_note_within_character_budget`, `::test_owner_messages_beyond_the_message_cap_keep_the_newest`)
- [x] Prompt injection: frame tags inside messages are neutralised and a forged speaker/name cannot open a new block (`test_prompts_knowledge.py::test_task_prompt_neutralises_injection_markup`)
- [x] Each turn is built from a fresh read of the conversation after the visitor row is stored, with the current request's name (`test_chat.py::test_prompt_is_built_from_a_fresh_read_including_the_new_message`, `::test_prompt_uses_the_current_request_name`)
- [x] The language instruction is generic ("following the Language rules in your style guide") (`test_prompts_knowledge.py::test_task_prompt_language_instruction_is_generic`)

## 7. Owner-agnostic code (refactor; SPEC "Notes": owner data only in knowledge/ and config)

- [x] No owner name (from `OWNER_NAME`), no owner link (every URL in `style.md`) appears in `backend/app/**/*.py` or `frontend/src/**`; no language name appears in `backend/app` (the footer links in `frontend/index.html` are the one allowed place) (`test_prompts_knowledge.py::test_no_owner_specific_literals_in_code`; verified to fail on a probe file containing "Estonian" and the owner's first name)
- [x] The scan really checks the owner's links (guard against a vacuous scan) (`test_prompts_knowledge.py::test_owner_tokens_are_actually_checked`)
- [x] Swapping `knowledge/` and `OWNER_NAME` for another owner (German/English style guide) yields instructions, task prompt and FAQ tool output with nothing of the current owner and the new owner's language rules (`test_prompts_knowledge.py::test_instructions_for_another_owner_contain_nothing_of_this_owner`)
- [x] The FAQ language reminder quotes the style guide's Language rules; without a Language section it falls back to "reply in the visitor's language" (`test_prompts_knowledge.py::test_faq_language_note_quotes_the_style_guide_rules`, `::test_instructions_without_language_rules_fall_back_to_the_visitors_language`)
- [x] The quoted Language rules come first and the generic reminder ("the language of the visitor's latest message") is the very last text of every `faq_tool` output (Docker end-to-end finding, 2026-09-22) (`test_prompts_knowledge.py::test_faq_language_note_quotes_the_style_guide_rules`, `::test_faq_tool_output_contains_full_question_and_answer`)
- [x] Behaviour kept after the refactor (A/B against the old hardcoded wording, nano, 5 runs per question): non-English FAQ questions route to `faq_tool` 15/15 (the old wording: 9/10 on the two questions both were run on) and Russian replies translate the answer, link labels included (see section 17 for the committed LLM test)

## 8. Agent construction (SPEC "Use of OpenAI Agents SDK", Q&A #2)

- [x] The agent's model is `OpenAIChatCompletionsModel` over an `AsyncOpenAI` client with base URL `https://openrouter.ai/api/v1` and the OpenRouter key; the model id is the literal `MODEL` value (prefix kept) (`test_agent.py::test_agent_uses_openrouter_chat_completions_model`, `::test_model_id_comes_from_settings`)
- [x] OpenRouter is scoped to this agent: the SDK's global default OpenAI client is untouched (`test_agent.py::test_agent_does_not_touch_the_global_openai_client`)
- [x] Tracing is disabled (`test_agent.py::test_tracing_is_disabled`)
- [x] Tools are exactly `faq_tool` and `push_tool` (`FunctionTool`); the run-context parameter is hidden from the JSON schemas (`question_number: integer`, `message`) (`test_agent.py::test_agent_uses_openrouter_chat_completions_model`, `::test_tool_schemas_hide_context_parameter`)
- [x] Model settings: low reasoning effort; client timeout 90 s, 2 retries; agent name includes the owner; instructions equal `build_instructions(...)`; no handoffs (`test_agent.py::test_agent_model_settings_and_client_options`)
- [x] A missing API key logs a warning and does not crash startup (`test_agent.py::test_agent_builds_without_api_key_and_warns`)
- [x] Stream adapter: `Runner.run_streamed` events map to `tool_called` / `tool_output` / `delta` / `final`; empty deltas and unrelated events are dropped; dict raw items and `id` fallback work; errors propagate (`test_agent.py::test_stream_adapter_maps_sdk_events`, `::test_stream_adapter_handles_dict_raw_items_and_missing_final`, `::test_stream_adapter_propagates_errors`)

## 9. Tools: faq_tool, push_tool and Pushover (SPEC reference push.py, Q&A #5, #10)

- [x] `faq_tool` invoked through the SDK returns the full answer, logs the call and never flags the conversation (`test_agent.py::test_faq_tool_returns_full_answer`, `::test_faq_tool_logs_and_never_flags`)
- [x] `push_tool` invoked through the SDK notifies the owner and sets `ctx.pushed` (drives `needs_attention`) (`test_agent.py::test_push_tool_via_sdk_invocation`)
- [x] Pushover call shape: form POST to `https://api.pushover.net/1/messages.json` with `user`, `token`, `message` (<= 1024 chars), optional `title` (<= 250 chars), 10 s timeout (`test_agent.py::test_send_pushover_posts_form_data_with_timeout`, `::test_send_pushover_without_title_and_long_title`)
- [x] Push body = note + `From: <name or "an anonymous visitor">` + `Conversation: <id>`; title `Avatar: <name>` or `Avatar: new visitor request` (`test_agent.py::test_push_body_layout`, `::test_push_titles`, `::test_push_anonymous_visitor`)
- [x] Missing Pushover credentials: no request, conversation still flagged, result says "not configured" (`test_agent.py::test_push_without_credentials_flags_but_does_not_send`)
- [x] HTTP error, network error and timeout are reported as failures, conversation still flagged (`test_agent.py::test_push_http_failure`, `::test_push_network_error`, `::test_push_timeout_is_reported_as_failure`)
- [x] The blocking HTTP call runs in a worker thread (event loop keeps ticking) (`test_agent.py::test_push_does_not_block_event_loop`)
- [x] Result texts name the owner from config (`test_agent.py::test_push_result_texts_name_the_owner_from_config`)
- [x] The push_tool output ends with what the reply must tell the visitor (SPEC reference push.py: "mention in the chat that it's done that"): delivered -> "Tell the visitor in your reply that you have passed this on to <first>."; not configured, HTTP error or network error -> "...that you have flagged this for <first>, who will see it in the dashboard; do not claim a phone notification." `push_delivered()` still reads the first as delivered and the others as not (finding 3) (`test_agent.py::test_push_result_tells_the_model_what_to_say_to_the_visitor` x3, `::test_delivered_push_result_is_classified_as_delivered`)

## 10. Chat API: SSE streaming contract (SPEC Q&A #9)

- [x] `POST /api/chat` returns `text/event-stream` with `Cache-Control: no-cache`, `X-Accel-Buffering: no`; events `start` (stored visitor message) -> `delta`* -> `done` (stored Avatar message); payload shapes are exact (`test_chat.py::test_chat_streams_events_in_order_and_stores_reply`)
- [x] Tool activity streams as `tool_called {call_id, name, arguments}` and `tool_output {call_id, name}` (tool output never sent to the browser); `push_tool` outputs carry `ok` (delivered or not) (`test_chat.py::test_tool_events_and_tool_calls_recorded`, `::test_push_tool_output_event_reports_delivery`, `::test_push_tool_output_event_reports_not_configured`, `::test_push_tool_output_event_reports_failed_delivery`)
- [x] Tool calls are stored on the Avatar row (`type, name, arguments, output` clipped to 2,000 chars), in order, including parallel calls; a missing call id gets `call_N`; an orphan output is not recorded (`test_chat.py::test_tool_events_and_tool_calls_recorded`, `::test_parallel_tool_calls_are_all_recorded_in_order`, `::test_tool_call_without_id_gets_a_generated_one`)
- [x] `done` carries the authoritative final output (trimmed), which is what is stored (`test_chat.py::test_done_content_is_authoritative_final_output`)
- [x] SSE framing survives newlines, fake `event:` lines and non-ASCII in deltas; UTF-8 on the wire (`test_chat.py::test_sse_framing_survives_newlines_and_non_ascii`)
- [x] Over a real uvicorn server, `start` and the first `delta` arrive before the reply finishes (no buffering) (`test_chat.py::test_sse_is_delivered_incrementally_over_real_http`)
- [x] `Qn` path: `start` -> `instant {faq}` -> `delta` (full content) -> `done`, stored with `tool_calls=[{"type":"instant","faq":n}]`, no LLM call; later prompts show it as an instant answer (`test_chat.py::test_instant_answer` x5, `::test_instant_answer_appears_in_later_prompt`, `::test_non_bare_qn_goes_to_llm` x7)
- [x] `push_tool` sets `needs_attention` on that Avatar row only; later turns see the push marker (`test_chat.py::test_push_tool_sets_needs_attention_and_notifies`, `::test_only_the_avatar_row_that_pushed_is_flagged`, `::test_no_push_means_no_attention`)

## 11. Chat API: errors and resilience (SPEC Q&A #9)

- [x] Agent exception -> `error {detail}` with a friendly message, no internals leaked, no Avatar row (`test_chat.py::test_error_event_when_agent_raises`)
- [x] Empty model reply -> `error`, nothing stored (`test_chat.py::test_error_event_when_reply_is_empty`)
- [x] Failure storing the reply -> `error`, never `done` (`test_chat.py::test_error_event_when_storing_reply_fails`)
- [x] Failure storing the visitor message -> HTTP 503 and no LLM call (`test_chat.py::test_visitor_insert_failure_is_503_without_llm_call`)
- [x] A turn that pushed and then failed (exception or empty reply, or a push seen only via `ctx.pushed`) stores a short fallback reply flagged `needs_attention` with a push marker, so the inbox shows "Needs you" and it is not re-pushed (`test_chat.py::test_push_then_model_failure_keeps_flag_and_marker`, `::test_push_then_empty_reply_keeps_flag_and_marker`, `::test_push_fallback_marker_is_added_when_tool_events_were_missed`, `::test_push_then_failure_and_fallback_insert_failure_is_error`)
- [x] Client disconnect mid-stream: the reply is still generated and stored (`test_chat.py::test_reply_stored_when_client_disconnects_mid_stream`)
- [x] Shutdown waits for in-flight replies (lifespan drain) (`test_chat.py::test_shutdown_waits_for_in_flight_replies`)
- [x] Unexpected server errors return a generic JSON 500 without internals (`test_public_api.py::test_database_errors_become_generic_500s`)

## 12. Abuse guard: clamp (SPEC "Implementation Decisions", Q&A #12a)

- [x] A message of exactly 20,000 characters is untouched (`test_chat.py::test_message_of_exactly_20000_chars_is_not_truncated`)
- [x] 20,001+ characters are truncated to 20,000 and the exact note `[...message truncated as it's too long; ask the visitor to send something more concise]` is appended; the clamped text is what is stored, what `start` echoes, and exactly what the agent receives (`test_chat.py::test_message_of_20001_chars_is_truncated_with_note`, `::test_truncation_note_is_exactly_the_spec_text`, `::test_huge_message_is_truncated`)
- [x] Characters, not bytes, are counted (Cyrillic); surrounding whitespace is trimmed before counting (`test_chat.py::test_clamp_counts_characters_not_bytes`, `::test_clamp_applies_after_trimming_whitespace`)

## 13. Abuse guard: rate limit (SPEC "Implementation Decisions", Q&A #12b)

- [x] The limiter is a `limits` moving window, `20 per 1 minute`, in memory (`test_chat.py::test_chat_limiter_is_a_20_per_minute_moving_window_in_memory`)
- [x] Moving (not fixed) window: slots free up one minute after each hit, not at a minute boundary (fake clock) (`test_chat.py::test_moving_window_frees_slots_one_minute_after_each_hit`)
- [x] The 21st message in a minute gets HTTP 429 JSON `{"detail": "You're sending messages too quickly..."}` with `Retry-After` >= 1 (`test_chat.py::test_rate_limit_20_per_minute_per_conversation`)
- [x] A 429 happens before any DB read or write and before any LLM call (`test_chat.py::test_rate_limited_request_touches_nothing`, `::test_rate_limit_20_per_minute_per_conversation`)
- [x] Per conversation: another `conversation_id` is unaffected; the key is the canonical UUID (upper/lower case count together) (`test_chat.py::test_rate_limit_20_per_minute_per_conversation`, `::test_rate_limit_key_is_canonical_uuid`)
- [x] `Qn` messages, blank messages and very long messages all count as one message each (`test_chat.py::test_rate_limit_applies_to_qn_shortcut_too`, `::test_rate_limit_checked_before_validation`, `::test_rate_limit_counts_messages_not_characters`)
- [x] Reset clears it (`test_chat.py::test_rate_limit_resets`)

## 14. Body size limit and input sanitising

- [x] Bodies over 512 KiB get 413 `{"detail": ...}` (declared Content-Length and chunked), nothing stored, no LLM call; applies to chat, login and admin posts, before auth (`test_chat.py::test_oversized_chat_body_is_413_and_stores_nothing`, `::test_oversized_chunked_chat_body_is_413`, `::test_oversized_login_body_is_413`, `::test_oversized_admin_message_body_is_413`, `::test_body_size_limit_applies_before_auth`)
- [x] Small chunked bodies work; a body just under the limit is truncated by the clamp, not rejected (`test_chat.py::test_small_chunked_chat_body_is_accepted`, `::test_body_just_under_the_limit_is_truncated_not_rejected`)
- [x] Validation: blank/NUL-only messages 422, malformed or wrongly typed payloads 422, over-long name field 422, over-long password 422; nothing stored, no LLM call (`test_chat.py::test_blank_message_is_422` x3, `::test_malformed_payload_is_422` x4, `::test_overlong_name_field_is_422`, `::test_overlong_login_password_is_422`, `::test_nul_only_message_is_422`, `test_public_api.py::test_chat_payload_types_are_strict`)
- [x] Name normalisation: trimmed, inner whitespace collapsed, max 60 chars, blank = none; the conversation name follows the latest non-empty name (`test_chat.py::test_name_normalisation` x6, `::test_name_can_change_and_conversation_name_follows`)
- [x] NUL and lone surrogates (which Postgres text cannot hold) are dropped from messages, names and owner posts; `Qn` still works after dropping; 422 bodies echoing a lone surrogate still render (`test_chat.py::test_sanitize_text`, `::test_normalize_name_and_clamp_helpers`, `::test_nul_in_message_is_dropped_and_qn_still_works`, `::test_nul_in_name_is_dropped`, `::test_lone_surrogate_is_dropped`, `test_admin_api.py::test_post_human_message_drops_nul_and_surrogates`, `test_public_api.py::test_validation_errors_echoing_lone_surrogates_render`)

## 15. Public conversation fetch (SPEC "Interactive Chat Experience", "Implementation Decisions", Q&A #6)

- [x] `GET /api/conversations/{id}` validates the UUID (422 otherwise) and normalises case (`test_public_api.py::test_fetch_invalid_uuid_is_422`, `::test_fetch_uuid_is_normalised`)
- [x] Returns the conversation's messages oldest first with exactly `id, role, content, created_at, tool_calls` (no `read` / `needs_attention`), all three roles, and tool calls (`test_public_api.py::test_fetch_returns_ordered_public_messages`, `::test_fetch_includes_every_role_and_tool_calls`)
- [x] One database round trip; the name is derived from the loaded rows (latest non-null) (`test_public_api.py::test_fetch_returns_ordered_public_messages`, `::test_fetch_name_is_latest_non_null`)
- [x] `after_id` returns only newer rows (the poll); bounds: non-integer or negative 422, above bigint 422 without touching the DB (`test_public_api.py::test_fetch_after_id`, `::test_fetch_after_id_validation`, `::test_fetch_after_id_is_bounded_to_bigint`)
- [x] Unknown id -> empty conversation (200); another visitor's id is never leaked; there is no public listing (`test_public_api.py::test_fetch_unknown_conversation_returns_empty`, `::test_fetch_other_conversation_ids_do_not_leak`, `test_admin_auth.py::test_no_public_listing_of_conversations`)
- [x] The fetch is read-only (never marks read or clears attention), even with an admin cookie (`test_public_api.py::test_fetch_is_read_only`, `test_admin_auth.py::test_public_fetch_does_not_mark_read_or_leak_flags`, `::test_admin_cookie_does_not_change_public_fetch`)
- [x] `GET /api/config` returns the owner's name from config without touching the DB and works with no DB configured; a missing DB config makes data routes 503 (`test_public_api.py::test_config_endpoint`, `::test_config_works_without_database_configuration`)

## 16. Admin authentication and authorization (SPEC "Testing" #1, "Implementation Decisions", Q&A #6)

Admin routes: `GET /admin/api/session`, `GET /admin/api/conversations`, `GET /admin/api/conversations/{id}`, `POST /admin/api/conversations/{id}/messages`, `POST /admin/api/conversations/{id}/resolve`.

- [x] The list above is the complete set of `/admin/api` routes (inventory test fails if a new route is added without being listed), and every one depends on `require_admin` (`test_admin_auth.py::test_admin_route_inventory_is_fully_covered`, `::test_every_admin_api_route_depends_on_require_admin`)
- [x] Every route returns 401 `{"detail": "Not authenticated"}` with no cookie (`test_admin_auth.py::test_admin_routes_reject_missing_cookie` x5)
- [x] Every route returns 401 with a tampered token, a forged payload, a token signed with another secret, another salt, a non-admin payload, an expired token (8 days old), or garbage cookie values (`""`, `null`, `a.b.c`, 4 KB); the forged tokens carry a valid-looking `jti`, so each isolates one property (`test_admin_auth.py::test_admin_routes_reject_tampered_cookie`, `::test_admin_routes_reject_forged_payload`, `::test_admin_routes_reject_cookie_signed_with_other_secret`, `::test_admin_routes_reject_cookie_with_other_salt`, `::test_admin_routes_reject_non_admin_payload`, `::test_admin_routes_reject_expired_cookie`, `::test_admin_routes_reject_garbage_cookie_values` x20, `::test_known_token_forms_are_accepted_only_when_well_formed`)
- [x] Every route returns 401 for a token revoked by logout (replayed from another client), before any DB access (`test_admin_auth.py::test_admin_routes_reject_token_revoked_by_logout` x5, `::test_token_replayed_after_logout_is_rejected`, `::test_replay_from_another_client_after_logout_is_rejected`)
- [x] Unauthenticated requests never touch the database or change data (`test_admin_auth.py::test_unauthenticated_requests_do_not_touch_the_database`)
- [x] Every route works with a valid session (200, 201 for posting) (`test_admin_auth.py::test_admin_routes_accept_valid_login_cookie` x5)
- [x] Tokens without a `jti` (unrevocable) are rejected; a 6-day-old token is still valid (7-day max age) (`test_admin_auth.py::test_legacy_token_without_jti_is_rejected`, `::test_token_that_is_six_days_old_is_still_valid`)
- [x] The session is only read from the `avatar_admin` cookie (not a query string or `Authorization` header); the cookie is a signed token with `{admin, jti}`, never the password or secret (`test_admin_auth.py::test_admin_cookie_is_not_accepted_as_query_or_header`, `::test_session_cookie_value_is_a_signed_token_not_the_password`)
- [x] Undefined methods (PUT/PATCH/DELETE) on admin paths never succeed or change data, even when logged in; unknown admin API paths are 404 (`test_admin_auth.py::test_undefined_methods_on_admin_paths_never_succeed_even_when_logged_in` x6, `::test_unknown_admin_api_path_is_not_served`)
- [x] `GET /admin/api/session` returns `{"authenticated": true, "owner_name": <OWNER_NAME>}` when signed in (401 when signed out, as above) (`test_admin_auth.py::test_session_endpoint_reports_owner`)

## 17. Login, logout, throttling and cookie flags (SPEC "Setup and Validation", Q&A #6)

- [x] Correct `ADMIN_PASSWORD` -> 200 `{"ok": true}` and the session cookie; the password check is constant-time (`hmac.compare_digest`) (`test_admin_auth.py::test_login_with_correct_password_sets_cookie`, `::test_password_check_is_constant_time`)
- [x] Wrong, empty, missing, case-changed or padded passwords and a missing body -> 401 `Invalid password`, no cookie (`test_admin_auth.py::test_login_with_wrong_or_missing_password_is_401` x5, `::test_login_with_no_body_is_401`)
- [x] An empty/unset `ADMIN_PASSWORD` never lets anyone in, even with a validly signed token (`test_admin_auth.py::test_empty_admin_password_always_rejects` x2)
- [x] Cookie flags: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 7 days, `Secure` only when `COOKIE_SECURE` is set (`test_admin_auth.py::test_login_with_correct_password_sets_cookie`, `::test_cookie_secure_flag_when_configured`)
- [x] `SESSION_SECRET` unset -> tokens are signed with `avatar::<ADMIN_PASSWORD>` (`test_admin_auth.py::test_session_secret_defaults_to_admin_password_derivation`)
- [x] Logout clears the cookie with the same flags (Secure when configured), revokes only that session, is fine without or with an invalid cookie, and prunes expired revocations (`test_admin_auth.py::test_logout_clears_cookie`, `::test_logout_cookie_deletion_flags`, `::test_logout_cookie_deletion_is_secure_when_configured`, `::test_logout_revokes_only_that_session`, `::test_logout_without_session_is_ok`, `::test_logout_with_invalid_cookie_is_ok`, `::test_revocation_entries_are_pruned`)
- [x] Failed logins are throttled per client IP: 10/minute and 50/hour -> 429 with `Retry-After`; a locked-out client cannot log in even with the right password; successful logins are not counted and do not reset the count; other clients are unaffected (`test_admin_auth.py::test_login_is_throttled_after_ten_failures`, `::test_locked_out_client_cannot_log_in_even_with_the_right_password`, `::test_successful_logins_are_not_counted`, `::test_successful_login_does_not_reset_failure_count`, `::test_login_limiter_unit`, `::test_login_limiter_default_windows`, `::test_login_limiter_hourly_window_drives_retry_after`)
- [x] On Fly the client key is `Fly-Client-IP` (a rotated `X-Forwarded-For` does not bypass it); off Fly that header is ignored (`test_admin_auth.py::test_login_throttle_is_per_fly_client_ip`, `::test_fly_client_ip_is_ignored_off_fly`)

## 18. Admin API: inbox aggregation (SPEC "Human Admin Experience", Q&A #5)

- [x] One summary per conversation: `conversation_id, conversation_name, started_at, last_message_at, message_count, unread_count, needs_attention, preview, last_role`, most recent activity first (`test_admin_api.py::test_inbox_summaries_most_recent_first`, `test_db.py::test_summary_counts_and_flags`)
- [x] New activity moves a conversation to the top; ordering is correct with mixed timestamp precision (`test_admin_api.py::test_new_activity_moves_conversation_to_the_top`, `test_db.py::test_summaries_sorted_by_last_activity_with_varied_precision`)
- [x] `unread_count` counts unread rows (the owner's own rows are stored read); `needs_attention` is true while any row is flagged (`test_admin_api.py::test_inbox_summaries_most_recent_first`, `::test_three_way_flow_end_to_end_with_fakes`)
- [x] Preview = the latest visitor message (the beginning of what they said), 140 chars, falling back to the latest message of any role (`test_admin_api.py::test_inbox_preview_is_latest_visitor_message_truncated`, `::test_inbox_preview_falls_back_to_latest_message`, `test_db.py::test_preview_source_ids_uses_latest_visitor_by_time_then_id`)
- [x] The name is the latest non-null `conversation_name`; empty inbox is `[]` (`test_admin_api.py::test_inbox_name_is_latest_non_null`, `::test_inbox_empty`)
- [x] Aggregation over thousands of rows (2,500 across 3 conversations) is exact (`test_admin_api.py::test_inbox_aggregates_thousands_of_rows`)
- [x] Paging past Supabase's 1000-row response cap (3 pages; real database: 1,005 rows) (`test_db.py::test_inbox_pages_through_1000_row_chunks`, `test_integration_supabase.py::test_reads_page_past_supabases_1000_row_cap`)
- [x] The inbox query never selects `content` or `tool_calls`; previews are fetched only for preview rows, in chunks of 200, cached by row id (a steady-state poll is one round trip) and pruned for superseded or deleted rows (`test_db.py::test_inbox_columns_exclude_content_and_tool_calls`, `::test_inbox_fetches_only_preview_rows_and_caches_them`, `::test_inbox_preview_ids_are_chunked`, `::test_inbox_preview_cache_drops_deleted_conversations`, `::test_inbox_single_page`)

## 19. Admin API: open thread, owner post, resolve (SPEC "Human Admin Experience", "Implementation Decisions", Q&A #4, #5)

- [x] Opening a thread is ONE repository call (a PostgREST `update ... returning`) that marks every row read, clears `needs_attention` and returns the rows sorted, with `read` / `needs_attention` / `tool_calls`; other conversations are untouched; opening twice is idempotent (`test_admin_api.py::test_open_conversation_marks_read_and_clears_attention`, `::test_open_is_idempotent`, `test_db.py::test_open_conversation_is_one_update_returning`)
- [x] Unknown thread -> 404; invalid UUID -> 422; UUID case is normalised (`test_admin_api.py::test_open_unknown_conversation_is_404`, `::test_open_invalid_uuid_is_422`, `::test_admin_routes_validate_uuid`, `::test_admin_uuid_is_normalised`)
- [x] The owner's post is stored as `role=human`, trimmed, `read=true`, `needs_attention=false`, 201; blank or > 20,000 chars -> 422 (`test_admin_api.py::test_post_human_message`, `::test_post_human_message_validation`, `::test_post_human_message_nul_only_is_422`)
- [x] The Avatar does NOT react to the owner's post (no LLM call); the visitor's next fetch shows it; the next visitor turn's prompt contains it with the owner label (`test_admin_api.py::test_post_human_message`, `::test_human_message_visible_to_visitor`, `::test_three_way_flow_end_to_end_with_fakes`)
- [x] Full three-way flow with fakes: visitor -> push -> inbox "needs you" -> open clears -> owner replies -> visitor sees it -> Avatar builds on it (`test_admin_api.py::test_three_way_flow_end_to_end_with_fakes`)
- [x] Resolve clears `needs_attention` only (does not mark read), one call, OK for unknown ids (`test_admin_api.py::test_resolve_clears_attention_only`, `::test_resolve_unknown_conversation_is_ok`, `test_db.py::test_resolve_and_delete_are_single_calls`)

## 20. Static serving and templating (SPEC "Tech stack decisions", Q&A #11)

- [x] `/` and `/index.html` serve the visitor page, `/admin`, `/admin/`, `/admin.html` the admin page, with `{{OWNER_NAME}}` / `{{OWNER_FIRST_NAME}}` replaced (HTML-escaped) and `Cache-Control: no-cache`; assets are served; unknown files 404; API routes win over the static mount (`test_public_api.py::test_static_pages_are_templated_and_escaped`)
- [x] The real built `frontend/dist` pages are templated from `OWNER_NAME` (title, meta, intro copy with the typographic apostrophe "Grace’s") with no placeholders left (`test_public_api.py::test_real_built_frontend_is_templated_from_config`)
- [x] HEAD works like GET (same Content-Length, empty body) for pages, `/api/config`, conversation fetch and assets (`test_public_api.py::test_head_requests_match_get`)
- [x] Missing `dist/` -> pages 503 with a build hint while the API keeps working (`test_public_api.py::test_static_missing_dist_returns_503_but_api_works`)
- [x] No `X-Frame-Options` / `frame-ancestors`, so the app can be embedded in an iframe (SPEC deployment notes) (`test_public_api.py::test_pages_can_be_framed`)
- [x] No `/docs`, `/redoc`, `/openapi.json` (`test_public_api.py::test_no_api_docs_exposed`)

## 21. Data layer: SupabaseRepository query shapes (SPEC "Implementation Decisions": single round trips)

- [x] Insert is one call carrying `conversation_id, conversation_name, role, content, tool_calls, needs_attention, read` (id and timestamp set by the DB) and runs in a worker thread (`test_db.py::test_insert_is_one_call_and_returns_row`, `::test_insert_passes_every_tracked_field`)
- [x] Conversation fetch is one `select ... eq ... [gt id] ... order created_at, id ... range(0, 999)`; only a conversation over 1000 rows needs more pages (`test_db.py::test_get_conversation_single_select`, `::test_get_conversation_longer_than_a_page`)
- [x] Client options: 20 s PostgREST timeout, no session persistence or token refresh; the repository is created lazily once; missing credentials -> 503 / `RuntimeError` (`test_db.py::test_supabase_client_options`, `::test_get_repository_is_lazy_and_cached`, `::test_get_repository_without_credentials_is_503`, `::test_create_repository_requires_both_credentials`)
- [x] Pure helpers: timestamp parsing (variants, garbage), sort by time then id, name derivation (`test_db.py::test_parse_timestamp_variants`, `::test_sort_rows_by_time_then_id`, `::test_conversation_name_from_rows`)
- [x] Supabase's transient clock-skew rejection (PGRST303 "JWT issued at future") is retried on every repository call, reads and writes (up to 2 retries after 0.25 s and 0.75 s), then re-raised; other PostgREST errors are not retried (Docker end-to-end finding, 2026-09-22) (`test_db.py::test_clock_skew_rejection_is_retried_on_reads_and_writes`, `::test_clock_skew_rejection_gives_up_after_two_retries`, `::test_other_postgrest_errors_are_not_retried`)

## 22. Real-Supabase integration (SPEC "Success Criteria"; auto-skips without credentials)

- [x] Full repository round trip on the real table: insert all three roles with tool calls, fetch, `after_id`, inbox rows without `tool_calls`, summary, open (update-returning marks read, clears attention), resolve (`test_integration_supabase.py::test_full_repository_roundtrip`)
- [x] Opening an unknown conversation returns no rows (`test_integration_supabase.py::test_open_unknown_conversation_returns_no_rows`)
- [x] Inbox preview (latest visitor message, 140 chars) and the preview cache on a second poll (`test_integration_supabase.py::test_inbox_preview_is_latest_visitor_message_truncated`)
- [x] Unicode (Cyrillic, CJK, emoji, quotes, backslashes, newlines) and `tool_calls` JSON round-trip exactly (`test_integration_supabase.py::test_unicode_and_tool_call_json_round_trip`)
- [x] Timestamps are server-set, timezone-aware and ordered (`test_integration_supabase.py::test_timestamps_are_server_set_and_ordered`)
- [x] Reads past the 1000-row response cap: 1,005-row conversation fetch, `after_id`, inbox and open all return every row (`test_integration_supabase.py::test_reads_page_past_supabases_1000_row_cap`)
- [x] The whole HTTP surface on the real DB (fake LLM): chat with push, `Q2`, public fetch, admin 401 then login, inbox flag and counts, open, owner post, visitor poll with `after_id` (`test_integration_supabase.py::test_http_api_against_real_supabase`)

## 23. Real-LLM tests with `openai/gpt-5.4-nano` (SPEC "Testing" note; Pushover mocked)

Run twice to spot flakiness: 8/8 passed both times on 2026-09-21; on 2026-09-22 (in-memory repository) 8/8 three times after finding 3. Assertions check behaviour (tools used, what was stored, facts, reply language, that a push is mentioned), never exact wording.

- [x] A normal question streams deltas and `done`; the reply is stored and the fetch shows `visitor, avatar` with the visitor's name (`test_llm.py::test_real_streamed_chat_stores_reply`)
- [x] An FAQ question routes to `faq_tool` with the right number and the reply keeps the FAQ answer's links (`test_llm.py::test_real_chat_uses_faq_tool`)
- [x] `Q2` makes no LLM call (spy on the agent stream: 0 runs for `Q2`, 1 for the next normal message, whose prompt records the instant answer) (`test_llm.py::test_real_qn_shortcut_makes_no_llm_call`)
- [x] Contact capture in one turn: a hiring message with an email calls `push_tool`; the push carries the email and conversation id; the inbox shows the conversation as needing attention (`test_llm.py::test_real_contact_capture_pushes_and_flags`)
- [x] Contact capture in two turns: the Avatar asks for the email, then pushes it once given and tells the visitor the owner was notified (`test_llm.py::test_real_two_turn_contact_capture_asks_for_email_then_pushes`)
- [x] A question the profile cannot answer calls `push_tool` with the question (delivered `ok: true`), stored with the push tool call, and the reply tells the visitor it has been passed on: it names the owner's first name (from `OWNER_NAME`) and uses a done form ("passed ... on/to", "notified", "forwarded", "flagged", "sent", ...; an offer like "I can pass this on" does not count) (SPEC reference push.py; ux-flows.md F2). Failed once before finding 3 was fixed; 8/8 in all three runs after it (`test_llm.py::test_real_unknown_question_pushes_the_owner`)
- [x] An owner message in the transcript is respected: after the owner says "Thursday afternoon works best", the Avatar's answer to "Which day works for the call?" says Thursday (`test_llm.py::test_real_owner_message_in_transcript_is_respected`)
- [x] Style-guide-driven translation: a Russian question about a project routes to that FAQ entry, keeps every URL, translates the prose and link labels (`test_llm.py::test_real_faq_answer_is_translated_when_the_style_guide_allows`)

## 24. Deployment files (SPEC "Tech stack decisions": fly.io via `scripts/fly.toml` and `scripts/deploy.sh`; the WordPress embed)

Static checks only: nothing here deploys or runs flyctl (`deploy.sh` is only parsed with `bash -n`). The deploy itself is not run in this phase (see `e2e_test_plan.md`, section D, item D10).

- [x] `fly.toml`: `app = "avatar-sergei"`, `primary_region = "lhr"`, one VM `shared-cpu-1x` with `512mb` (`test_deploy_config.py::test_fly_app_and_region_are_the_spec_values`, `::test_fly_vm_is_shared_cpu_1x_with_512mb`)
- [x] Always on: `min_machines_running >= 1`, `auto_start_machines`, `force_https` (`test_deploy_config.py::test_fly_machine_is_always_on`)
- [x] `internal_port = 8000` and `env.PORT = "8000"` match the Dockerfile's `EXPOSE`, `ENV PORT` and uvicorn `--port` (`test_deploy_config.py::test_fly_internal_port_matches_the_dockerfile`)
- [x] The health check is `GET /api/config` (no DB hit) (`test_deploy_config.py::test_fly_health_check_is_the_db_free_config_endpoint`)
- [x] `COOKIE_SECURE = "1"`; `[env]` holds only `PORT` and `COOKIE_SECURE` (`test_deploy_config.py::test_fly_production_cookie_is_secure`, `::test_fly_env_holds_no_secrets`)
- [x] `kill_signal = "SIGINT"`, `kill_timeout` (75) greater than the app's 60 s lifespan drain (read from `main.py`) and <= 300 (`test_deploy_config.py::test_fly_kill_timeout_exceeds_the_app_drain`); concurrency by connections, soft < hard (`::test_fly_concurrency_counts_connections_for_sse`)
- [x] `deploy.sh`: `bash -n` passes; `set -euo pipefail`; `APP="avatar-sergei"`; `flyctl deploy --config scripts/fly.toml --dockerfile Dockerfile`; exactly the 9 secret keys, imported over stdin (`secrets import --stage`, never `secrets set`) (`test_deploy_config.py::test_deploy_script_parses`, `::test_deploy_script_targets_the_same_app_and_config`, `::test_deploy_script_stages_every_secret_and_only_secrets`)
- [x] The copies in `DEPLOY.md` equal the files (`test_deploy_config.py::test_deploy_md_copies_match_the_scripts`)
- [x] `wordpress-embed.html`: `var BASE = "https://avatar-sergei.fly.dev";`, only a numeric `?q=` is forwarded to the iframe `src`, no blank lines inside `<style>`/`<script>` (`test_deploy_config.py::test_embed_defines_a_base_constant_for_the_app_url`, `::test_embed_forwards_q_to_the_iframe_src`, `::test_embed_snippet_has_no_blank_lines_inside_style_or_script`). The snippet is also exercised in a browser (frontend suite, `embed.spec.ts`, e2e plan D-E1 / D-E2).

## Findings and fixes during this pass

- **Owner-specific code (refactor, fixed).** `backend/app/prompts.py` and `backend/app/knowledge.py` hardcoded this owner's languages ("Estonian or Russian", "English, Russian or Estonian; otherwise English", example phrases in both languages) and assumed FAQ answers are in English. The code now refers to "the Language rules in the style guide", and `faq_tool` output quotes the "## Language" section of `style.md` (read at load time); without that section the twin replies in the visitor's language. A comment in `frontend/src/shared/format.ts` used the owner's first name as an example; replaced. Guarded by section 7.
- **FAQ routing for non-English questions (found by A/B on nano, fixed).** With the first generic wording, Russian and Estonian questions about a project skipped `faq_tool` (0/5 and 3/5) and were answered from the profile. The FAQ rule now says the routing phrases match questions in any language and a match MUST still call `faq_tool`: 15/15 afterwards (the old hardcoded wording scored 9/10 on the two questions both versions were run on).
- **Link labels left in English (improved).** The FAQ language note now says link labels ("Live demo", "Code on GitHub") are ordinary words and are translated too: Russian replies translated both labels in 9 of 10 runs (the old wording translated 4 of 10 labels in 5 comparable Russian runs).
- **Weak auth tests (fixed in tests).** The "other secret", "other salt", "expired" and "non-admin" token tests signed payloads without a `jti`, so they would have passed even if the property under test were not checked (tokens without a `jti` are rejected anyway). They now carry a `jti`, and a sanity test shows the same payload signed correctly is accepted.
- **Vacuous shutdown test avoided.** The lifespan-drain test checks the task result inside the event loop (`asyncio.run` would otherwise cancel a pending task and make `done()` true).
- **Found later by the Docker end-to-end run (2026-09-22, fixed; see `e2e_test_plan.md`, "Bugs found and fixed").**
  1. *Transient Supabase PGRST303 -> HTTP 500.* With the `sb_secret_` key, PostgREST now and then rejects a request as "JWT issued at future" (gateway/PostgREST clock skew). The inbox route returned 500 (a chat insert would have returned 503). `backend/app/db.py` now sends every query through `execute()`, which retries PGRST303 twice; the request is refused before any SQL runs, so retrying writes is safe. 3 new tests; the retry fired 3 times in later container runs, with no 500.
  2. *English questions answered in Russian (about 9% on nano).* `faq_tool` output ended with the quoted style-guide rules ("I speak Russian (native), English and Estonian..."), the last thing the model read before writing. `faq_language_note()` now puts the quoted rules first and ends on the generic reminder: 5/240 + 4/160 wrong-language replies afterwards (about 2%) against 11/118 before, with Russian and Estonian questions still 20/20 and FAQ routing unchanged. Tests updated as above. Real-LLM tests re-run afterwards: 8/8, with the in-memory repository (`SUPABASE_URL= SUPABASE_KEY=`), so no Supabase rows were written or deleted.
  3. *The Avatar did not always tell the visitor it had passed an unanswerable question on (gap-closing pass, 2026-09-22).* SPEC reference push.py: "mention in the chat that it's done that". With the new assertion in `test_real_unknown_question_pushes_the_owner` the test failed; a probe (in-process, in-memory repository, Pushover stubbed, 20 nano runs) had `push_tool` called 20/20 but 7 replies silent about it, some offering "I can pass this on" after doing it. `notify_owner()` in `backend/app/agent.py` now ends each tool output with what the reply must say (passed on / flagged, never a phone notification when undelivered). Afterwards: 30/30 and 30/30 delivered, 20/20 unconfigured with "flagged" wording. 4 new tests in `test_agent.py`; real-LLM suite 8/8 three times; verified end to end in the container (e2e plan PO4).
  4. *Stale test after the visual-QA polish.* `test_public_api.py::test_real_built_frontend_is_templated_from_config` still expected "Grace's" (straight apostrophe); the polish moved the intro and composer copy to U+2019. Test updated; no app change.
  5. *`scripts/start_pc.ps1` failed from a UNC path (final run, 2026-09-22).* Not backend code; recorded here for completeness. Run from Windows PowerShell 5.1 on the WSL checkout (`\\wsl.localhost\...`), the script handed docker a provider-qualified path and the build failed. Fixed in the script; see `e2e_test_plan.md`, bug 5 and PS6. The backend suite was re-run afterwards (410 passed, 8 skipped).
- Observations, not changed: nano keeps the Estonian label "Live demo" in English (as the old wording did), and keeps a list of skill names in English when answering in Russian (technical terms, same with the old wording).

## Not covered here (other plans)

- Browser behaviour (focus, polling cadence 10 s -> 60 s, Keep chat cookie, Reset, `?q=N` deep link, theme, responsive layouts, screenshots): see [frontend_test_plan.md](frontend_test_plan.md).
- Docker build, `scripts/start_mac.sh` / `stop_mac.sh`, the containerised end-to-end run with visitor, Avatar and owner in multiple conversations, and the embed snippet in a browser: see [e2e_test_plan.md](e2e_test_plan.md).

## Final cleanup (orchestrator)

- [x] Delete screenshots (2026-09-22: all 270 PNGs in test/screenshots/ removed, plus frontend/test-results and frontend/playwright-report)
- [x] Delete test conversation threads in Supabase (2026-09-22: 851 conversations / 3,475 rows deleted; messages table verified at 0 rows)
