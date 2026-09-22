/**
 * Admin thread panel: head (name, conv id, started, count), role bubbles with
 * instant tags and tool rows, the "Avatar asked for you" flag + Mark resolved,
 * the posting-as note, the composer (Enter / Shift+Enter / refocus), the
 * visitor seeing the owner's reply, live thread updates, ArrowUp / ArrowDown
 * navigation and its exceptions, switching threads while one loads, a thread
 * that fails to open, dark + light. (Plan section A-N, A-Q.)
 */
import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { adminApi, seedConversation } from './support/api';
import { initialsOf, ownerConfig, testName } from './support/env';
import { A, V, expectNoEmoji, expectTokenImage, loginAdmin, openThread, openVisitor, sendByEnter, setTheme, shot, waitForAvatarReplies } from './support/ui';

async function activeId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('#convoList > .convo-item.is-active')?.getAttribute('data-id') ?? null);
}

test.describe('admin thread', () => {
  test('open, read, reply as the owner; the visitor sees it; the thread updates live (A-N1, N3, N6..N9, N12, N16, A-Q1)', async ({ page, browser, request, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const cfg = await ownerConfig(request);
    const name = testName('Thread');
    const cid = await seedConversation(request, { name, messages: ['Q2', 'Q12'] });

    // The visitor keeps the chat open in their own browser.
    const visitorCtx = await browser.newContext({ baseURL });
    await visitorCtx.addCookies([{ name: 'avatar_cid', value: cid, url: baseURL! }]);
    const visitor = await visitorCtx.newPage();
    await openVisitor(visitor);
    await expect(V.msgs(visitor)).toHaveCount(4);

    try {
      await loginAdmin(page);
      await openThread(page, cid, name);

      // Head.
      await expect(A.threadName(page)).toHaveText(name);
      await expect(page.locator('.thread-head .avatar-initials')).toHaveText(initialsOf(name));
      const hex = cid.replace(/-/g, '').slice(0, 6);
      await expect(A.threadSub(page)).toContainText(`conv_${hex}`);
      await expect(A.threadSub(page)).toContainText('started');
      await expect(A.threadSub(page)).toContainText('4 messages');
      await expect(A.threadSub(page)).toHaveAttribute('title', cid);
      await expect(A.flag(page)).toBeHidden();

      // Messages in order with role bubbles and instant tags; scrolled to the latest.
      const roles = await A.threadMsgs(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.role));
      expect(roles).toEqual(['visitor', 'avatar', 'visitor', 'avatar']);
      await expect(page.locator('.thread-inner .instant-tag')).toHaveText(['instant · Q2', 'instant · Q12']);
      await expect(page.locator('.thread-inner .msg--visitor .avatar-initials').first()).toHaveText(initialsOf(name));
      await expect.poll(() => page.locator('#thread').evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight)).toBeLessThanOrEqual(4);

      // Posting-as note names the owner from config.
      await expect(page.locator('.posting-as-text')).toContainText(`${cfg.owner_name} · live`);
      await expect(page.locator('.posting-as-text')).toContainText("The Avatar won't reply to it");
      await expect(page.locator('.posting-as-text')).not.toContainText('—'); // style.md: no em-dashes
      await expect(A.composer(page)).toHaveAttribute('placeholder', 'Write a message to TEST…');
      await expect(A.composer(page)).toBeFocused();
      await shot(page, testInfo, 'admin-thread-open-dark');

      // Compose: Shift+Enter = newline, Enter = send; composer clears and keeps focus.
      const box = A.composer(page);
      await box.type('Hello from the real me.');
      await box.press('Shift+Enter');
      await box.type('Second line: ask me anything.');
      await expect(A.threadMsgs(page)).toHaveCount(4);
      await box.press('Enter');
      const mine = page.locator('.thread-inner > .msg--human').last();
      await expect(mine).toHaveAttribute('data-id', /\d+/);
      await expect(mine.locator('.human-tag')).toHaveText('You · sent to visitor');
      await expect(mine.locator('.bubble br')).toHaveCount(1);
      await expect(mine).not.toHaveClass(/is-sending/);
      await expect(box).toHaveValue('');
      await expect(box).toBeFocused();
      await expect(A.threadSub(page)).toContainText('5 messages');
      // Click-to-send works too.
      await box.fill('And a quick follow-up.');
      await page.locator('.admin-composer-dock .btn-send').click();
      await expect(page.locator('.thread-inner > .msg--human[data-id]')).toHaveCount(2);
      await expect(box).toBeFocused();

      // Identity images (SPEC UI): the Avatar's rows carry the robotic twin, the owner's
      // rows the real photo; visitor rows carry initials, never a picture.
      const avatarTokens = page.locator('.thread-inner > .msg--avatar .avatar.avatar-twin');
      await expect(avatarTokens).toHaveCount(2);
      await expectTokenImage(page, avatarTokens.first(), 'avatar-robot');
      await expect(page.locator('.thread-inner > .msg--avatar .avatar-human')).toHaveCount(0);
      const humanTokens = page.locator('.thread-inner > .msg--human .avatar.avatar-human');
      await expect(humanTokens).toHaveCount(2);
      await expectTokenImage(page, humanTokens.first(), 'avatar-human.png');
      await expect(page.locator('.thread-inner > .msg--visitor .avatar')).toHaveCount(0);
      // No emoji anywhere on the dashboard (inbox filtered to this thread, thread open).
      await expectNoEmoji(page);

      // Stored as the human role; the Avatar does not react.
      const api = await adminApi(baseURL!);
      const thread = await api.open(cid);
      await api.dispose();
      expect(thread.messages.map((m: any) => m.role)).toEqual(['visitor', 'avatar', 'visitor', 'avatar', 'human', 'human']);
      expect(thread.messages[4].content).toBe('Hello from the real me.\nSecond line: ask me anything.');

      // The visitor's poll brings both owner messages with the owner's name.
      await expect(V.humanMsgs(visitor)).toHaveCount(2, { timeout: 13_000 });
      await expect(V.humanMsgs(visitor).first().locator('.human-tag')).toHaveText(`${cfg.owner_name} · live`);
      await expect(V.humanMsgs(visitor).first().locator('.bubble br')).toHaveCount(1);
      await shot(visitor, testInfo, 'visitor-sees-owner-reply');

      // The visitor answers; the open admin thread picks it up within ~12 s.
      await sendByEnter(visitor, 'Q14');
      await waitForAvatarReplies(visitor, 3);
      await expect(A.threadMsgs(page)).toHaveCount(8, { timeout: 13_000 });
      await expect(page.locator('.thread-inner .instant-tag').last()).toHaveText('instant · Q14');
      await expect(A.threadSub(page)).toContainText('8 messages');
      await shot(page, testInfo, 'admin-thread-live-update-dark');
      await setTheme(page, 'light');
      await shot(page, testInfo, 'admin-thread-live-update-light');
    } finally {
      await visitorCtx.close();
    }
  });

  test('tool rows and the "Avatar asked for you" flag; Mark resolved clears it (A-N4, A-N5)', async ({ page, request }, testInfo) => {
    const name = testName('Asked');
    const cid = await seedConversation(request, { name, messages: ['Q15'] });
    // Present this thread as one where the Avatar called faq_tool and push_tool
    // (the real push path is admin-push.spec.ts).
    await page.route('**/admin/api/conversations', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      for (const s of body.conversations) if (s.conversation_id === cid) s.needs_attention = true;
      await route.fulfill({ response: res, json: body });
    });
    await page.route(`**/admin/api/conversations/${cid}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const res = await route.fetch();
      const body = await res.json();
      const avatar = body.messages.find((m: any) => m.role === 'avatar');
      avatar.tool_calls = [
        { type: 'function', name: 'faq_tool', arguments: '{"question_number": 15}', output: 'FAQ 15' },
        { type: 'function', name: 'push_tool', arguments: '{"message":"wants to talk"}', output: 'Notification sent to the owner' },
      ];
      avatar.content = "Here are my top skills. I've also let the real me know you'd like to talk.";
      await route.fulfill({ response: res, json: body });
    });
    await loginAdmin(page);
    await openThread(page, cid, name);

    const tools = page.locator('.thread-inner .msg--avatar .tool-status.is-done');
    await expect(tools).toHaveCount(2);
    await expect(tools.nth(0)).toHaveText('Looked up the FAQ · Q15');
    await expect(tools.nth(1)).toHaveText('Notified you · push_tool');
    await expect(A.flag(page)).toBeVisible();
    await expect(A.flag(page)).toContainText('Avatar asked for you');
    await expect(A.resolve(page)).toBeVisible();
    await shot(page, testInfo, 'admin-thread-asked-for-you-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'admin-thread-asked-for-you-light');

    const resolved = page.waitForResponse((r) => r.url().endsWith(`/admin/api/conversations/${cid}/resolve`));
    await A.resolve(page).click();
    expect((await resolved).status()).toBe(200);
    await expect(A.flag(page)).toBeHidden();
    await expect(A.resolve(page)).toBeHidden();
    await expect(A.composer(page)).toBeFocused();
  });

  test('ArrowUp / ArrowDown move between conversations, but not while typing or reading (A-N10, A-N11)', async ({ page, request }) => {
    const group = testName('Arrows');
    const cidA = await seedConversation(request, { name: `${group} A`, messages: ['Q1'] });
    const cidB = await seedConversation(request, { name: `${group} B`, messages: ['Q2'] });
    const cidC = await seedConversation(request, { name: `${group} C`, messages: ['Q3'] });
    await loginAdmin(page);
    // The inbox list has focus on arrival (desktop).
    await expect(A.list(page)).toBeFocused();
    await A.search(page).fill(group);
    await expect(A.rows(page)).toHaveCount(3); // C, B, A (most recent first)

    // From the search field: arrows move the selection and keep focus in search.
    await A.search(page).press('ArrowDown');
    await expect.poll(() => activeId(page)).toBe(cidC);
    await expect(A.threadName(page)).toHaveText(`${group} C`);
    await A.search(page).press('ArrowDown');
    await expect.poll(() => activeId(page)).toBe(cidB);
    await expect(A.search(page)).toBeFocused();
    await expect(A.threadName(page)).toHaveText(`${group} B`);
    await expect(A.threadMsgs(page)).toHaveCount(2);

    // From an empty composer: arrows move too.
    await A.composer(page).click();
    await A.composer(page).press('ArrowDown');
    await expect.poll(() => activeId(page)).toBe(cidA);
    await expect(A.threadName(page)).toHaveText(`${group} A`);
    await expect(A.composer(page)).toBeFocused();
    await A.composer(page).press('ArrowDown'); // already at the bottom: stays
    await expect.poll(() => activeId(page)).toBe(cidA);
    await A.composer(page).press('ArrowUp');
    await expect.poll(() => activeId(page)).toBe(cidB);

    // Typing in the composer: arrows move the caret, not the selection.
    await A.composer(page).type('draft text');
    await A.composer(page).press('ArrowUp');
    await A.composer(page).press('ArrowDown');
    await page.waitForTimeout(400);
    expect(await activeId(page)).toBe(cidB);
    await expect(A.composer(page)).toHaveValue('draft text');

    // Reading the thread (focus inside it): arrows scroll, selection stays.
    await page.locator('.thread-inner .msg--avatar .bubble').first().click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(400);
    expect(await activeId(page)).toBe(cidB);

    // Drafts survive switching threads.
    await A.row(page, cidC).click();
    await expect(A.threadName(page)).toHaveText(`${group} C`);
    await expect(A.composer(page)).toHaveValue('');
    await A.row(page, cidB).click();
    await expect(A.composer(page)).toHaveValue('draft text');

    // Enter on the focused list opens the active conversation and moves to the composer.
    await A.list(page).focus();
    await page.keyboard.press('Enter');
    await expect(A.composer(page)).toBeFocused();
  });

  test('a reply that fails to post shows "Not sent" and keeps the draft (A-N13)', async ({ page, request }, testInfo) => {
    const name = testName('NotSent');
    const cid = await seedConversation(request, { name, messages: ['Q16'] });
    await page.route(`**/admin/api/conversations/${cid}/messages`, (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Database unavailable' }),
    }));
    await loginAdmin(page);
    await openThread(page, cid, name);
    await A.composer(page).fill('This will not go through');
    await A.composer(page).press('Enter');
    const notice = page.locator('.thread-inner > .notice.notice--error');
    await expect(notice).toContainText('Not sent: Database unavailable');
    await expect(page.locator('.thread-inner > .msg--human')).toHaveCount(0);
    await expect(A.composer(page)).toHaveValue('This will not go through');
    await expect(A.composer(page)).toBeFocused();
    await shot(page, testInfo, 'admin-reply-not-sent');
    // Nothing was stored.
    const stored = await (await request.get(`/api/conversations/${cid}`)).json();
    expect(stored.messages.map((m: any) => m.role)).toEqual(['visitor', 'avatar']);
  });

  test('switching threads never shows the previous visitor\'s messages under the new head (A-N14)', async ({ page, request }, testInfo) => {
    const group = testName('Switch');
    const cidA = await seedConversation(request, { name: `${group} Alpha`, messages: ['Q1'] });
    const cidB = await seedConversation(request, { name: `${group} Bravo`, messages: ['Q5'] });
    // Hold Bravo's thread fetch until the test releases it.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route(`**/admin/api/conversations/${cidB}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await held;
      await route.fallback();
    });
    await loginAdmin(page);
    await openThread(page, cidA, group);
    await expect(page.locator('.thread-inner .instant-tag')).toHaveText('instant · Q1');

    await A.row(page, cidB).click();
    await expect(A.threadName(page)).toHaveText(`${group} Bravo`);
    await expect(A.main(page)).toHaveClass(/is-loading/);
    // Head and body agree: Alpha's bubbles are gone, a loading status stands in.
    await expect(A.threadMsgs(page)).toHaveCount(0);
    await expect(page.locator('.thread-inner > .thread-loading')).toContainText('Loading conversation');
    await expect(page.locator('.thread-inner > .thread-loading')).toHaveCSS('opacity', '1');
    await shot(page, testInfo, 'admin-thread-switching');

    release();
    await expect(A.main(page)).not.toHaveClass(/is-loading/);
    await expect(page.locator('.thread-inner .instant-tag')).toHaveText('instant · Q5');
    await expect(A.threadMsgs(page)).toHaveCount(2);
  });

  test('a thread that fails to open keeps its needs-you and unread markers; the composer is disabled (A-N15)', async ({ page, request }, testInfo) => {
    const name = testName('OpenFail');
    const cid = await seedConversation(request, { name, messages: ['Q10'] });
    await page.route('**/admin/api/conversations', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      for (const s of body.conversations) if (s.conversation_id === cid) s.needs_attention = true;
      await route.fulfill({ response: res, json: body });
    });
    let fail = true;
    await page.route(`**/admin/api/conversations/${cid}`, async (route) => {
      if (route.request().method() !== 'GET' || !fail) return route.fallback();
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Database unavailable' }) });
    });
    await loginAdmin(page);
    await A.search(page).fill(name);
    const row = A.row(page, cid);
    await expect(row).toHaveClass(/is-attention/);
    const needsYou = async () => Number(await A.chip(page, 'attention').locator('.chip-count').innerText());
    const before = await needsYou();
    await row.click();
    await expect(page.locator('.thread-error')).toContainText('Database unavailable');
    // Nothing was cleared server-side, so nothing is cleared on screen.
    await expect(row).toHaveClass(/is-active/);
    await expect(row).toHaveClass(/is-attention/);
    await expect(row).toHaveClass(/is-unread/);
    await expect(row.locator('.badge--attention')).toBeVisible();
    expect(await needsYou()).toBe(before);
    // No thread to reply to: the composer is disabled.
    await expect(A.composer(page)).toBeDisabled();
    await expect(page.locator('.admin-composer-dock .btn-send')).toBeDisabled();
    await shot(page, testInfo, 'admin-thread-open-failed');

    // Try again succeeds: the thread renders, is marked read, the composer comes back.
    fail = false;
    await page.locator('.thread-error button', { hasText: 'Try again' }).click();
    await expect(A.threadMsgs(page)).toHaveCount(2);
    await expect(A.composer(page)).toBeEnabled();
    await expect(A.composer(page)).toBeFocused();
    await expect(row).not.toHaveClass(/is-unread/);
  });
});
