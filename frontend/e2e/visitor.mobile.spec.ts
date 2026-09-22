/**
 * Visitor chat on a phone (390x844, isMobile + hasTouch): the two-row top bar,
 * docked composer, touch taps on Theme / Keep chat / Reset not popping the
 * keyboard, tap-to-send, chips, stream states and the human bubble on mobile,
 * the rate-limit and error notices and the intro after Reset, both themes.
 * (Plan section V-K4..K6, V-K8.)
 */
import { expect, test } from './support/fixtures';
import { adminApi, seedConversation } from './support/api';
import { ownerConfig, testName } from './support/env';
import { ackStart, installChatMock, push, row, waitForChatRequests } from './support/chat-mock';
import { V, expectTokenImage, horizontalOverflow, offenders, openVisitor, setTheme, shot, waitForAvatarReplies } from './support/ui';

test.describe('visitor on mobile', () => {
  test('phone layout: two-row top bar, icon-only Reset, short placeholder, docked composer (V-K5)', async ({ page, request }, testInfo) => {
    const cfg = await ownerConfig(request);
    await openVisitor(page);
    const vp = page.viewportSize()!;
    expect(await horizontalOverflow(page), (await offenders(page)).join('; ')).toBeLessThanOrEqual(0);
    const brand = (await page.locator('.topbar .brand').boundingBox())!;
    const prefs = (await page.locator('.topbar-prefs').boundingBox())!;
    expect(prefs.y).toBeGreaterThanOrEqual(brand.y + brand.height - 1);
    const reset = (await V.reset(page).boundingBox())!;
    expect(reset.width).toBeLessThanOrEqual(44);
    await expect(page.locator('.reset-label')).toHaveCSS('position', 'absolute');
    await expect(V.composer(page)).toHaveAttribute('placeholder', `Message ${cfg.owner_first_name}’s twin…`);
    await expect(page.locator('.hint-keys').first()).toBeHidden();
    await expect(page.locator('.brand-sub-name')).toHaveText(cfg.owner_name);
    const dock = (await page.locator('.composer-dock').boundingBox())!;
    expect(Math.abs(dock.y + dock.height - vp.height)).toBeLessThanOrEqual(1);
    // 16px inputs (no iOS zoom) and >= 40px touch targets.
    await expect(V.composer(page)).toHaveCSS('font-size', '16px');
    await expect(V.name(page)).toHaveCSS('font-size', '16px');
    for (const sel of ['#themeToggle', '#resetChat', '#sendBtn']) {
      const b = (await page.locator(sel).boundingBox())!;
      expect(b.height, sel).toBeGreaterThanOrEqual(40);
    }
    await expect(page.locator('#intro .chip').first()).toHaveCSS('min-height', '40px');
    await shot(page, testInfo, 'visitor-intro-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'visitor-intro-light');
  });

  test('taps on Theme / Keep chat / Reset do not focus the composer (keyboard stays down) (V-K4)', async ({ page }) => {
    await openVisitor(page);
    const notComposer = () => page.evaluate(() => document.activeElement?.id !== 'composerInput');
    await page.locator('#themeToggle').tap();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await notComposer()).toBe(true);
    await page.locator('label.keep-switch').tap();
    await expect(V.keep(page)).not.toBeChecked();
    expect(await notComposer()).toBe(true);
    await page.locator('label.keep-switch').tap();
    await expect(V.keep(page)).toBeChecked();
    await V.reset(page).tap();
    await expect(page.locator('#liveRegion')).toContainText('Started a new conversation');
    expect(await notComposer()).toBe(true);
  });

  test('tap to send a Qn; instant answer on a phone (V-K6)', async ({ page }, testInfo) => {
    await openVisitor(page);
    await V.name(page).tap();
    await V.name(page).fill(testName('Mobile'));
    await V.composer(page).tap();
    await V.composer(page).fill('Q4');
    const sendBg = () => V.send(page).evaluate((e) => getComputedStyle(e).backgroundColor);
    const idle = await sendBg();
    await V.send(page).tap();
    await waitForAvatarReplies(page, 1);
    await expect(V.avatarMsgs(page).last().locator('.instant-tag')).toHaveText('instant · Q4');
    await expect(V.composer(page)).toHaveValue('');
    await expect(V.composer(page)).toBeFocused();
    // No sticky hover on touch: with the pointer left on the send button (where a
    // tap leaves it), it keeps its resting purple, not the hover shade.
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);
    const sendBox = (await V.send(page).boundingBox())!;
    await page.mouse.move(sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2);
    await page.waitForTimeout(500); // past the 200 ms background transition (busy -> ready)
    expect(await sendBg()).toBe(idle);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'visitor-instant-dark');
    await setTheme(page, 'light');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'visitor-instant-light');
  });

  test('chip tap submits; stream states render on a phone (V-K6)', async ({ page, request }, testInfo) => {
    const cfg = await ownerConfig(request);
    await installChatMock(page);
    await openVisitor(page);
    await page.locator('#intro .chip[data-prompt]').nth(1).tap();
    await waitForChatRequests(page, 1);
    await ackStart(page);
    await push(page, 'tool_called', { call_id: 'm1', name: 'faq_tool', arguments: '{"question_number": 9}' });
    const reply = V.avatarMsgs(page).last();
    await expect(reply).toHaveAttribute('data-state', 'tool-calling');
    await shot(page, testInfo, 'visitor-stream-tool-calling');
    await push(page, 'tool_output', { call_id: 'm1', name: 'faq_tool' });
    await push(page, 'delta', { text: `${cfg.owner_first_name} moved from sports trading into AI engineering because ` });
    await expect(reply).toHaveAttribute('data-state', 'typing');
    await shot(page, testInfo, 'visitor-stream-typing');
    await push(page, 'done', { message: row('avatar', `${cfg.owner_first_name} moved from sports trading into AI engineering because he loves building things. [LinkedIn](https://www.linkedin.com/in/sergei-maslennikov-ai)`, [{ type: 'function', name: 'faq_tool', arguments: '{"question_number": 9}', output: '' }]) });
    await expect(reply).toHaveAttribute('data-state', 'complete');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await expectTokenImage(page, reply.locator('.avatar.avatar-twin'), 'avatar-robot');
    await shot(page, testInfo, 'visitor-stream-complete');
    await setTheme(page, 'light');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'visitor-stream-complete-light');
  });

  test('the rate-limit notice (429) on a phone, both themes (V-K8)', async ({ page }, testInfo) => {
    await page.route('**/api/chat', (route) => route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'Retry-After': '30' },
      body: JSON.stringify({ detail: "You're sending messages too quickly. Please wait a moment and try again." }),
    }));
    await openVisitor(page);
    await V.composer(page).tap();
    await V.composer(page).fill('TEST too fast from a phone');
    await V.send(page).tap();
    const notice = V.notices(page).last();
    await expect(notice).toHaveClass(/notice--rate-limit/);
    await expect(notice).toContainText('sending messages too quickly');
    await expect(notice).toBeInViewport();
    await expect(V.composer(page)).toHaveValue('TEST too fast from a phone');
    // The 22px close icon has a 40px touch target (coarse pointer): a tap 8px outside it still hits it.
    const hits = await notice.locator('.notice-close').evaluate((btn) => {
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const probe = (x: number, y: number) => btn.contains(document.elementFromPoint(x, y));
      return [probe(r.left - 8, cy), probe(r.right + 8, cy), probe(cx, r.top - 8), probe(cx, r.bottom + 8)];
    });
    expect(hits).toEqual([true, true, true, true]);
    expect(await horizontalOverflow(page), (await offenders(page)).join('; ')).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'visitor-rate-limit-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'visitor-rate-limit-light');
    await notice.locator('.notice-close').tap();
    await expect(V.notices(page)).toHaveCount(0);
  });

  test('a reply error on a phone: inline notice, composer usable (V-K8)', async ({ page }, testInfo) => {
    await installChatMock(page);
    await openVisitor(page);
    await V.composer(page).tap();
    await V.composer(page).fill('TEST this reply fails');
    await V.send(page).tap();
    await waitForChatRequests(page, 1);
    await ackStart(page);
    await push(page, 'error', { detail: 'Sorry, something went wrong while I was writing my reply. Please try again in a moment.' });
    const reply = V.avatarMsgs(page).last();
    await expect(reply).toHaveAttribute('data-state', 'error');
    await expect(reply.locator('.notice.notice--error')).toContainText('something went wrong');
    await expect(reply.locator('.notice.notice--error')).toBeInViewport();
    await expect(V.send(page)).toBeEnabled();
    expect(await horizontalOverflow(page), (await offenders(page)).join('; ')).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'visitor-stream-error-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'visitor-stream-error-light');
  });

  test('after Reset on a phone: the intro is back, nothing overflows, both themes (V-K8)', async ({ page, request, context, baseURL }, testInfo) => {
    const cid = await seedConversation(request, { name: testName('MobileReset'), messages: ['Q5'] });
    await context.addCookies([{ name: 'avatar_cid', value: cid, url: baseURL! }]);
    await openVisitor(page);
    await expect(V.msgs(page)).toHaveCount(2);
    await V.reset(page).tap();
    await expect(V.msgs(page)).toHaveCount(0);
    await expect(V.intro(page)).toBeVisible();
    await expect(page.locator('#liveRegion')).toContainText('Started a new conversation');
    const fresh = (await context.cookies()).find((c) => c.name === 'avatar_cid')?.value;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(cid);
    // The portrait and headline are in view from the top; the composer stays docked.
    await expect(page.locator('.intro-avatar')).toBeInViewport();
    await expect(page.locator('#introTitle')).toBeInViewport();
    const vp = page.viewportSize()!;
    const dock = (await page.locator('.composer-dock').boundingBox())!;
    expect(Math.abs(dock.y + dock.height - vp.height)).toBeLessThanOrEqual(1);
    expect(await horizontalOverflow(page), (await offenders(page)).join('; ')).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'visitor-after-reset-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'visitor-after-reset-light');
  });

  test('the human bubble on a phone, both themes (V-K6)', async ({ page, request, context, baseURL }, testInfo) => {
    const cfg = await ownerConfig(request);
    const cid = await seedConversation(request, { name: testName('MobileHuman'), messages: ['Q2', 'Q3'] });
    const admin = await adminApi(baseURL!);
    await admin.postHuman(cid, 'Hey, the real me here. Happy to answer anything else - just ask.');
    await admin.dispose();
    await context.addCookies([{ name: 'avatar_cid', value: cid, url: baseURL! }]);
    await openVisitor(page);
    await expect(V.msgs(page)).toHaveCount(5);
    const human = V.humanMsgs(page).first();
    await expect(human.locator('.human-tag')).toHaveText(`${cfg.owner_name} · live`);
    await expect(human).toBeInViewport();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'visitor-human-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'visitor-human-light');
  });
});
