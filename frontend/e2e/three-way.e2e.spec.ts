/**
 * Multi-party end to end (SPEC "Success Criteria"): three visitors in separate
 * browser contexts, each with its own conversation_id, the Avatar (real model,
 * openai/gpt-5.4-nano) and the human in the admin dashboard, all at once,
 * against the Docker container started by scripts/start_mac.sh.
 *
 *   TEST Alice  desktop, dark    asks about projects -> streamed reply using faq_tool
 *   TEST Bob    phone, light     Q2, then the ?q=5 deep link in a new tab
 *   TEST Chen   desktop, light   job enquiry + email -> push_tool (one real Pushover
 *                                notification) -> "Needs you" in admin
 *   the human   desktop admin    inbox states, opens Chen (flag cleared in the DB),
 *                                replies to Chen and to Alice; phone admin master/detail
 *
 * Chen then asks a follow-up and the Avatar builds on the human's message.
 * Database state is checked straight from Supabase (read-only). The run's
 * conversation ids and browser storage are saved for restart.e2e.spec.ts,
 * which checks persistence after the container is restarted.
 *
 * Run (container on :8000):
 *   cd frontend && BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e npm run test:e2e:three-way
 * Screenshots: test/screenshots/e2e/three-way-*.png. Plan: test/e2e_test_plan.md, section MP.
 */
import fs from 'node:fs';
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expect, test, watchPage } from './support/fixtures';
import { faqs, newCid, ownerConfig } from './support/env';
import { dbRows, rowSummary, toolNames } from './support/supabase';
import { A, V, cookieCid, isComposerFocused, loginAdmin, openThread, openVisitor, sendByEnter, setTheme, shot, waitForAvatarReplies } from './support/ui';
import { THREE_WAY_STATE_FILE, type ThreeWayState } from './support/three-way-state';

test.describe.configure({ timeout: 420_000 });

const NAMES = { alice: 'TEST Alice', bob: 'TEST Bob', chen: 'TEST Chen' } as const;
const CHEN_EMAIL = 'test.chen@example.com';
const WEEKDAYS_BUT_THURSDAY = /\b(monday|tuesday|wednesday|friday|saturday|sunday)\b/i;

const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
// Desktop Chrome UA: Google Fonts' Android font files render with broken spacing in headless Linux Chromium.
const phone = { ...devices['Pixel 7'], userAgent: devices['Desktop Chrome'].userAgent, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function newPage(browser: Browser, baseURL: string, opts: object, problems: string[], label: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL, colorScheme: 'dark', ...opts });
  const page = await ctx.newPage();
  watchPage(page, problems, label);
  return { ctx, page };
}

/** Record the streaming avatar bubble's states and the lengths its text grows through. */
async function recordStream(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__states = [] as string[];
    w.__lengths = [] as number[];
    const thread = document.getElementById('thread')!;
    new MutationObserver((records) => {
      for (const r of records) {
        const t = r.target as HTMLElement;
        if (r.type === 'attributes' && t.classList?.contains('msg--avatar')) {
          const s = t.dataset.state!;
          if (w.__states[w.__states.length - 1] !== s) w.__states.push(s);
        }
      }
      const avatars = thread.querySelectorAll<HTMLElement>('.msg--avatar');
      const live = avatars[avatars.length - 1];
      if (live?.dataset.state === 'typing') {
        const n = live.querySelector('.bubble')?.textContent?.length ?? 0;
        if (w.__lengths[w.__lengths.length - 1] !== n) w.__lengths.push(n);
      }
    }).observe(thread, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-state'] });
  });
}

async function threadText(page: Page): Promise<string> {
  return page.locator('#thread').innerText();
}

test('three visitors, the Avatar and the human in one run (MP-1..MP-13)', async ({ page: alice, browser, request, baseURL }, testInfo) => {
  const cfg = await ownerConfig(request);
  const first = cfg.owner_first_name;
  const problems: string[] = [];
  const evidence: Record<string, any> = { base_url: baseURL, owner_name: cfg.owner_name, started_at: new Date().toISOString() };
  const snap = (p: Page, name: string) => shot(p, testInfo, name);

  const ALICE_Q = `Hi! What projects has ${first} built? I'm especially curious about the Autonomous Trading Floor.`;
  const CHEN_Q = `Hello, I'm Chen, a hiring manager. I'd like to get in touch with ${first} about an AI engineering job on my team. `
    + `My email is ${CHEN_EMAIL} - please pass it on so ${first} can contact me.`;
  const HUMAN_TO_CHEN = `Hi Chen, the real ${first} here - thanks for getting in touch! I'm free for a call on Thursday at 14:00 Tallinn time. Does that work for you?`;
  const HUMAN_TO_ALICE = `Hi Alice - the real ${first} here. Happy to walk you through the Autonomous Trading Floor code any time.`;
  // Asks only about what the owner already said: a question the knowledge cannot answer (e.g. "what
  // should I prepare?") makes the Avatar push again, which would send a second Pushover notification.
  const CHEN_FOLLOWUP = `Thanks! Just to confirm: which day and time did ${first} suggest for our call?`;

  // Alice uses the test's default page (desktop 1440x900, dark; guarded by the fixture).
  const bob = await newPage(browser, baseURL!, { ...phone, colorScheme: 'light' }, problems, '[bob]');
  const chen = await newPage(browser, baseURL!, { ...desktop, colorScheme: 'light' }, problems, '[chen]');
  const admin = await newPage(browser, baseURL!, desktop, problems, '[admin]');
  const contexts = [bob.ctx, chen.ctx, admin.ctx];

  try {
    // ---- MP-1: three visitors, three conversation ids ------------------------------------
    await test.step('MP-1 three visitor contexts get their own conversation ids', async () => {
      await Promise.all([openVisitor(alice), openVisitor(bob.page), openVisitor(chen.page)]);
      await V.name(alice).fill(NAMES.alice);
      await V.name(bob.page).fill(NAMES.bob);
      await V.name(chen.page).fill(NAMES.chen);
      await setTheme(bob.page, 'light');
      await setTheme(chen.page, 'light');
      await expect(alice.locator('html')).toHaveAttribute('data-theme', 'dark');
      for (const p of [alice, bob.page, chen.page]) await expect(V.composer(p)).toBeVisible();
      const cids = { alice: (await cookieCid(alice))!, bob: (await cookieCid(bob.page))!, chen: (await cookieCid(chen.page))! };
      for (const cid of Object.values(cids)) expect(cid).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Set(Object.values(cids)).size).toBe(3);
      evidence.conversation_ids = cids;
    });
    const cid = evidence.conversation_ids as { alice: string; bob: string; chen: string };

    // ---- MP-2: Bob (phone, light) uses the Q2 instant answer ------------------------------
    await test.step('MP-2 Bob: Q2 instant answer on a phone', async () => {
      const faq2 = faqs().get(2)!;
      await V.composer(bob.page).fill('Q2');
      const t0 = Date.now();
      await V.send(bob.page).tap();
      await waitForAvatarReplies(bob.page, 1);
      evidence.bob_q2_ms = Date.now() - t0;
      const reply = V.avatarMsgs(bob.page).last();
      await expect(reply.locator('.instant-tag')).toHaveText('instant · Q2');
      await expect(reply.locator('.bubble p strong').first()).toHaveText('Q2:');
      await expect(reply.locator('.bubble')).toContainText(faq2.question);
      await expect(V.visitorMsgs(bob.page).last().locator('.avatar-initials')).toHaveText('TB');
      await snap(bob.page, '01-bob-q2-phone-light');
    });

    // ---- MP-3: Alice and Chen talk to the Avatar at the same time -------------------------
    await test.step('MP-3 Alice (streamed faq_tool reply) and Chen (push_tool) chat concurrently', async () => {
      await recordStream(alice);
      const tAlice = Date.now();
      await sendByEnter(alice, ALICE_Q);
      const tChen = Date.now();
      await sendByEnter(chen.page, CHEN_Q);

      // Alice's reply is on screen while it streams.
      const aliceReply = V.avatarMsgs(alice).last();
      await expect(aliceReply).toBeVisible();
      await expect(aliceReply).not.toHaveAttribute('data-state', 'complete');
      await snap(alice, '02-alice-streaming-dark');

      await Promise.all([
        waitForAvatarReplies(alice, 1, 150_000).then(() => { evidence.alice_reply_ms = Date.now() - tAlice; }),
        waitForAvatarReplies(chen.page, 1, 150_000).then(() => { evidence.chen_reply_ms = Date.now() - tChen; }),
      ]);

      // Alice: streamed (thinking/tool -> typing -> complete, text grew in steps), faq_tool row done.
      const states: string[] = await alice.evaluate(() => (window as any).__states);
      const lengths: number[] = await alice.evaluate(() => (window as any).__lengths);
      evidence.alice_stream_states = states.join(' -> ');
      evidence.alice_stream_text_steps = lengths.length;
      expect(states.indexOf('typing')).toBeGreaterThanOrEqual(0);
      expect(states.indexOf('typing')).toBeLessThan(states.lastIndexOf('complete'));
      expect(states.some((s) => s === 'tool-calling' || s === 'tool-returned')).toBe(true);
      expect(lengths.length, 'the reply text grew in several steps (streamed, not one block)').toBeGreaterThan(2);
      await expect(aliceReply).toHaveAttribute('data-state', 'complete');
      await expect(aliceReply.locator('.tool-status[data-tool="faq_tool"]').first()).toBeVisible();
      await expect(aliceReply.locator('.tool-status:not(.is-done)')).toHaveCount(0);
      await expect(aliceReply.locator('.bubble')).toContainText(/Trading Floor/i);
      await expect(V.visitorMsgs(alice).first().locator('.avatar-initials')).toHaveText('TA');
      await expect.poll(() => isComposerFocused(alice)).toBe(true);
      evidence.alice_reply = (await aliceReply.locator('.bubble').innerText()).trim();
      await snap(alice, '03-alice-reply-before-owner-dark');

      // Chen: the Avatar pushes the enquiry to the owner (asks once more if the model confirmed first).
      let pushRow = chen.page.locator('#thread .tool-status[data-tool="push_tool"]');
      if ((await pushRow.count()) === 0) {
        evidence.chen_needed_second_turn = true;
        await sendByEnter(chen.page, `Yes, please notify ${first} now. My email is ${CHEN_EMAIL}.`);
        await waitForAvatarReplies(chen.page, 2, 150_000);
        pushRow = chen.page.locator('#thread .tool-status[data-tool="push_tool"]');
      }
      await expect(pushRow).toHaveCount(1);
      const pushText = (await pushRow.innerText()).trim();
      evidence.chen_push_row = pushText;
      expect(pushText).toMatch(new RegExp(`^(Notified|Flagged for) ${first} · push_tool$`));
      evidence.pushover_delivered = pushText.startsWith('Notified');
      evidence.chen_first_reply = (await V.avatarMsgs(chen.page).last().locator('.bubble').innerText()).trim();
      await snap(chen.page, '04-chen-push-before-owner-light');
    });

    // ---- MP-4: database rows as written, before the owner looks -------------------------
    await test.step('MP-4 Supabase rows: roles, names, tool_calls, needs_attention, read', async () => {
      const [a, b, c] = await Promise.all([dbRows(cid.alice), dbRows(cid.bob), dbRows(cid.chen)]);
      evidence.db_before_admin = { alice: rowSummary(a), bob: rowSummary(b), chen: rowSummary(c) };
      expect(a.map((r) => r.role)).toEqual(['visitor', 'avatar']);
      expect(a[0]!.conversation_name).toBe(NAMES.alice);
      expect(a[0]!.content).toBe(ALICE_Q);
      const faqCalls = (a[1]!.tool_calls ?? []).filter((t: any) => t.name === 'faq_tool');
      expect(faqCalls.length).toBeGreaterThan(0);
      for (const call of faqCalls) {
        expect(JSON.parse(call.arguments)).toHaveProperty('question_number');
        expect(String(call.output).length).toBeGreaterThan(20);
      }
      evidence.alice_faq_numbers = faqCalls.map((t: any) => JSON.parse(t.arguments).question_number);
      expect(b.map((r) => r.role)).toEqual(['visitor', 'avatar']);
      expect(b[0]!.conversation_name).toBe(NAMES.bob);
      expect(b[1]!.tool_calls).toEqual([{ type: 'instant', faq: 2 }]);
      expect(c.every((r, i) => r.role === (i % 2 === 0 ? 'visitor' : 'avatar'))).toBe(true);
      expect(c[0]!.conversation_name).toBe(NAMES.chen);
      const pushed = c.filter((r) => toolNames(r).includes('push_tool'));
      expect(pushed).toHaveLength(1);
      expect(pushed[0]!.needs_attention).toBe(true);
      const pushArgs = String(pushed[0]!.tool_calls!.find((t: any) => t.name === 'push_tool').arguments);
      expect.soft(pushArgs, 'the push message carries the visitor email').toContain(CHEN_EMAIL);
      for (const r of [...a, ...b, ...c]) expect(r.read, `row ${r.id} unread until the owner opens it`).toBe(false);
      for (const r of [...a, ...b]) expect(r.needs_attention).toBe(false);
    });

    // ---- MP-5: Bob opens the ?q=5 deep link in a new tab ------------------------------------
    await test.step('MP-5 Bob: ?q=5 deep link in a new tab of the same browser', async () => {
      const bob2 = await bob.ctx.newPage();
      watchPage(bob2, problems, '[bob tab 2]');
      await bob2.goto('/?q=5');
      await expect(V.thread(bob2)).toHaveAttribute('data-state', 'ready');
      await waitForAvatarReplies(bob2, 2);
      await expect(bob2).toHaveURL(`${baseURL}/`);
      expect(await cookieCid(bob2)).toBe(cid.bob);
      await expect(V.msgs(bob2)).toHaveCount(4);
      await expect(V.avatarMsgs(bob2).last().locator('.instant-tag')).toHaveText('instant · Q5');
      await expect(V.avatarMsgs(bob2).last().locator('.bubble')).toContainText(faqs().get(5)!.question);
      await expect(bob2.locator('html')).toHaveAttribute('data-theme', 'light');
      await snap(bob2, '05-bob-deeplink-q5-phone-light');
      // The first tab picks the new rows up by polling (same conversation).
      await expect(V.msgs(bob.page)).toHaveCount(4, { timeout: 13_000 });
      await snap(bob.page, '06-bob-first-tab-synced-phone-light');
      await bob2.close();
    });

    // ---- MP-6: the owner's inbox ----------------------------------------------------------
    await test.step('MP-6 admin inbox: three new conversations, Chen flagged "Needs you"', async () => {
      await loginAdmin(admin.page);
      for (const who of ['alice', 'bob', 'chen'] as const) await expect(A.row(admin.page, cid[who])).toBeVisible();
      // Most recent activity first. Bob's Q5 (MP-5) is the newest of the three; other specs running in
      // parallel may add their own rows in between, so only the relative order is checked.
      const order = await A.rows(admin.page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
      expect(order.indexOf(cid.bob)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(cid.bob)).toBeLessThan(order.indexOf(cid.chen));
      expect(order.indexOf(cid.bob)).toBeLessThan(order.indexOf(cid.alice));
      const chenRow = A.row(admin.page, cid.chen);
      await expect(chenRow).toHaveClass(/is-attention/);
      await expect(chenRow.locator('.badge--attention')).toHaveText('Needs you');
      await expect(chenRow.locator('.convo-name')).toHaveText(NAMES.chen);
      for (const who of ['alice', 'bob'] as const) {
        const row = A.row(admin.page, cid[who]);
        await expect(row).toHaveClass(/is-unread/);
        await expect(row).not.toHaveClass(/is-attention/);
        await expect(row.locator('.badge--dot')).toBeVisible();
        await expect(row.locator('.convo-name')).toHaveText(NAMES[who]);
      }
      await expect(A.row(admin.page, cid.alice).locator('.convo-preview')).toContainText('Autonomous Trading Floor');
      await expect(A.row(admin.page, cid.bob).locator('.convo-preview')).toHaveText('Q5');
      await expect(A.chip(admin.page, 'attention')).toHaveClass(/has-items/);
      await snap(admin.page, '07-admin-inbox-three-visitors-dark');
    });

    // ---- MP-7: the owner opens Chen: the flag clears in the database ------------------------
    await test.step('MP-7 admin opens Chen: "Avatar asked for you", then read + flag cleared in Supabase', async () => {
      await openThread(admin.page, cid.chen);
      await expect(A.flag(admin.page)).toContainText('Avatar asked for you');
      await expect(admin.page.locator('.thread-inner .tool-status[data-tool="push_tool"]')).toBeVisible();
      await expect(A.threadName(admin.page)).toHaveText(NAMES.chen);
      await snap(admin.page, '08-admin-thread-chen-asked-for-you-dark');
      const rows = await dbRows(cid.chen);
      evidence.db_chen_after_open = rowSummary(rows);
      for (const r of rows) {
        expect(r.read, `row ${r.id} read after opening`).toBe(true);
        expect(r.needs_attention, `row ${r.id} flag cleared after opening`).toBe(false);
      }
      await expect(A.row(admin.page, cid.chen)).not.toHaveClass(/is-attention/);
      await expect(A.row(admin.page, cid.chen)).toHaveClass(/is-active/);
      // Opening Chen touched nobody else.
      const [a, b] = await Promise.all([dbRows(cid.alice), dbRows(cid.bob)]);
      for (const r of [...a, ...b]) expect(r.read).toBe(false);
    });

    // ---- MP-8: the owner replies to Chen; Chen sees it live ----------------------------------
    await test.step('MP-8 owner replies to Chen; Chen sees "<OWNER_NAME> · live" within ~12 s', async () => {
      const posted = admin.page.waitForResponse((r) => r.url().endsWith(`/admin/api/conversations/${cid.chen}/messages`) && r.request().method() === 'POST');
      await A.composer(admin.page).fill(HUMAN_TO_CHEN);
      await A.composer(admin.page).press('Enter');
      expect((await posted).status()).toBe(201);
      const t0 = Date.now();
      const mine = admin.page.locator('.thread-inner > .msg--human[data-id]');
      await expect(mine).toHaveCount(1);
      await expect(mine.locator('.human-tag')).toHaveText('You · sent to visitor');
      await expect(A.flag(admin.page)).toBeHidden();
      await expect(A.composer(admin.page)).toBeFocused();

      const human = V.humanMsgs(chen.page);
      await expect(human).toHaveCount(1, { timeout: 13_000 });
      evidence.human_to_chen_latency_ms = Date.now() - t0;
      expect(evidence.human_to_chen_latency_ms).toBeLessThan(12_500);
      await expect(human.locator('.human-tag')).toHaveText(`${cfg.owner_name} · live`);
      await expect(human.locator('.bubble')).toContainText('Thursday at 14:00');
      expect(await human.locator('.avatar.avatar-human').evaluate((e) => getComputedStyle(e).backgroundImage)).toContain('avatar-human.png');
      // The Avatar did not react to the owner's message.
      await expect(V.avatarMsgs(chen.page)).toHaveCount(evidence.chen_needed_second_turn ? 2 : 1);
      await snap(admin.page, '09-admin-thread-chen-replied-dark');
      await snap(chen.page, '10-chen-sees-owner-light');
      const rows = await dbRows(cid.chen);
      const h = rows[rows.length - 1]!;
      expect(h.role).toBe('human');
      expect(h.content).toBe(HUMAN_TO_CHEN);
      expect(h.read).toBe(true);
      expect(h.needs_attention).toBe(false);
    });

    // ---- MP-9: the owner replies to Alice ------------------------------------------------------
    await test.step('MP-9 owner opens Alice (inbox shows read / active / unread) and replies', async () => {
      await openThread(admin.page, cid.alice);
      await expect(A.row(admin.page, cid.chen)).not.toHaveClass(/is-unread|is-attention|is-active/);
      await expect(A.row(admin.page, cid.chen).locator('.convo-read')).toBeVisible();
      await expect(A.row(admin.page, cid.alice)).toHaveClass(/is-active/);
      await expect(A.row(admin.page, cid.bob)).toHaveClass(/is-unread/);
      await snap(admin.page, '11-admin-inbox-read-active-unread-dark');

      const posted = admin.page.waitForResponse((r) => r.url().endsWith(`/admin/api/conversations/${cid.alice}/messages`) && r.request().method() === 'POST');
      await A.composer(admin.page).fill(HUMAN_TO_ALICE);
      await A.composer(admin.page).press('Enter');
      expect((await posted).status()).toBe(201);
      const t0 = Date.now();
      await expect(admin.page.locator('.thread-inner > .msg--human[data-id]')).toHaveCount(1);
      await snap(admin.page, '12-admin-thread-alice-replied-dark');
      const human = V.humanMsgs(alice);
      await expect(human).toHaveCount(1, { timeout: 13_000 });
      evidence.human_to_alice_latency_ms = Date.now() - t0;
      expect(evidence.human_to_alice_latency_ms).toBeLessThan(12_500);
      await expect(human.locator('.human-tag')).toHaveText(`${cfg.owner_name} · live`);
      await expect(V.avatarMsgs(alice)).toHaveCount(1);
      await snap(alice, '13-alice-sees-owner-dark');
    });

    // ---- MP-10: Chen follows up; the Avatar builds on the owner's message --------------------
    await test.step('MP-10 Chen asks a follow-up; the Avatar uses the owner\'s message without contradicting it', async () => {
      const before = V.avatarMsgs(chen.page);
      const n = await before.count();
      const t0 = Date.now();
      await sendByEnter(chen.page, CHEN_FOLLOWUP);
      await waitForAvatarReplies(chen.page, n + 1, 150_000);
      evidence.chen_followup_ms = Date.now() - t0;
      const reply = (await V.avatarMsgs(chen.page).last().locator('.bubble').innerText()).trim();
      evidence.chen_followup_reply = reply;
      expect(reply, 'the reply picks up the day the owner proposed').toMatch(/thursday/i);
      expect.soft(reply, 'and the time').toMatch(/14[:.]00|2\s?(pm|p\.m\.)/i);
      expect(reply, 'no other weekday is offered').not.toMatch(WEEKDAYS_BUT_THURSDAY);
      await snap(chen.page, '14-chen-followup-reply-light');
      const rows = await dbRows(cid.chen);
      const roles = rows.map((r) => r.role);
      const hi = roles.indexOf('human');
      expect(roles.slice(hi)).toEqual(['human', 'visitor', 'avatar']);
      expect(rows[hi + 1]!.content).toBe(CHEN_FOLLOWUP);
    });

    // ---- MP-11: the owner sees Chen's follow-up and the whole three-way thread ----------------
    await test.step('MP-11 admin: Chen\'s follow-up turns the row unread; the full three-way thread', async () => {
      await expect(A.row(admin.page, cid.chen)).toHaveClass(/is-unread/, { timeout: 15_000 });
      await openThread(admin.page, cid.chen);
      const msgs = A.threadMsgs(admin.page);
      await expect(msgs).toHaveCount((await dbRows(cid.chen)).length);
      await expect(admin.page.locator('.thread-inner > .msg--human .human-tag')).toHaveText('You · sent to visitor');
      await expect(admin.page.locator('.thread-inner > .msg').last()).toBeInViewport();
      await snap(admin.page, '15-admin-thread-chen-three-way-dark');
      await setTheme(admin.page, 'light');
      await snap(admin.page, '16-admin-thread-chen-three-way-light');
      await setTheme(admin.page, 'dark');
      const rows = await dbRows(cid.chen);
      expect(rows.every((r) => r.read && !r.needs_attention)).toBe(true);
      evidence.db_final = {
        alice: rowSummary(await dbRows(cid.alice)),
        bob: rowSummary(await dbRows(cid.bob)),
        chen: rowSummary(rows),
      };
    });

    // ---- MP-12: isolation --------------------------------------------------------------------
    await test.step('MP-12 isolation: nobody sees another thread; reading one needs its uuid', async () => {
      const bobText = await threadText(bob.page);
      for (const secret of [ALICE_Q, CHEN_Q, CHEN_EMAIL, HUMAN_TO_ALICE, HUMAN_TO_CHEN, 'Autonomous Trading Floor']) {
        expect(bobText).not.toContain(secret);
      }
      await expect(V.humanMsgs(bob.page)).toHaveCount(0);
      await expect(V.msgs(bob.page)).toHaveCount(4);
      const aliceText = await threadText(alice);
      for (const s of [CHEN_EMAIL, HUMAN_TO_CHEN, 'Q5']) expect(aliceText).not.toContain(s);
      const chenText = await threadText(chen.page);
      for (const s of [ALICE_Q, HUMAN_TO_ALICE]) expect(chenText).not.toContain(s);
      await snap(bob.page, '17-bob-isolated-phone-light');

      const api = bob.ctx.request;
      const own = await (await api.get(`/api/conversations/${cid.bob}`)).json();
      expect(own.messages.map((m: any) => m.role)).toEqual(['visitor', 'avatar', 'visitor', 'avatar']);
      expect(own.conversation_name).toBe(NAMES.bob);
      expect(JSON.stringify(own)).not.toContain('needs_attention');
      expect([404, 405]).toContain((await api.get('/api/conversations')).status());
      expect((await api.get('/api/conversations/not-a-uuid')).status()).toBe(422);
      const unknown = await (await api.get(`/api/conversations/${newCid()}`)).json();
      expect(unknown.messages).toEqual([]);
      expect(unknown.conversation_name).toBeNull();
      for (const path of ['/admin/api/conversations', `/admin/api/conversations/${cid.chen}`, '/admin/api/session']) {
        expect((await api.get(path)).status(), path).toBe(401);
      }
      expect((await api.post(`/admin/api/conversations/${cid.alice}/messages`, { data: { content: 'spoof' } })).status()).toBe(401);
      expect((await dbRows(cid.alice)).some((r) => r.content === 'spoof')).toBe(false);
    });

    // ---- MP-13: the owner on a phone: master/detail -------------------------------------------
    await test.step('MP-13 admin on a phone: inbox -> Chen thread (scrolled to latest) -> back', async () => {
      const m = await newPage(browser, baseURL!, phone, problems, '[admin phone]');
      contexts.push(m.ctx);
      await loginAdmin(m.page);
      await expect(A.shell(m.page)).toHaveAttribute('data-view', 'inbox');
      await expect(A.row(m.page, cid.bob)).toHaveClass(/is-unread/);
      await snap(m.page, '18-admin-phone-inbox-dark');
      await A.row(m.page, cid.chen).tap();
      await expect(A.shell(m.page)).toHaveAttribute('data-view', 'thread');
      await expect(A.threadName(m.page)).toHaveText(NAMES.chen);
      await expect(A.back(m.page)).toBeVisible();
      await expect(m.page.locator('.thread-inner > .msg').last()).toBeInViewport();
      await snap(m.page, '19-admin-phone-thread-chen-dark');
      await A.back(m.page).tap();
      await expect(A.shell(m.page)).toHaveAttribute('data-view', 'inbox');
      await setTheme(m.page, 'light');
      await snap(m.page, '20-admin-phone-inbox-light');
    });

    // ---- Save the run for the restart check -----------------------------------------------------
    const state: ThreeWayState = {
      saved_at: new Date().toISOString(),
      base_url: baseURL!,
      conversation_ids: cid,
      names: NAMES,
      human_to_alice: HUMAN_TO_ALICE,
      human_to_chen: HUMAN_TO_CHEN,
      row_counts: {
        alice: (await dbRows(cid.alice)).length,
        bob: (await dbRows(cid.bob)).length,
        chen: (await dbRows(cid.chen)).length,
      },
      storage: {
        alice: await alice.context().storageState(),
        bob: await bob.ctx.storageState(),
        chen: await chen.ctx.storageState(),
        admin: await admin.ctx.storageState(),
      },
    };
    fs.writeFileSync(THREE_WAY_STATE_FILE, JSON.stringify(state), { mode: 0o600 }); // holds an admin session cookie
    evidence.finished_at = new Date().toISOString();
    await testInfo.attach('three-way-evidence.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    fs.writeFileSync(testInfo.outputPath('three-way-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(`[three-way evidence] ${JSON.stringify(evidence)}`);
    expect(problems, 'no page errors or console errors in any participant\'s page').toEqual([]);
  } finally {
    for (const ctx of contexts) await ctx.close();
  }
});
