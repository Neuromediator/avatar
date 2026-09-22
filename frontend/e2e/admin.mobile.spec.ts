/**
 * The admin dashboard on a phone (390x844, touch): the login gate, the inbox
 * filling the screen, tapping a conversation opens its full thread scrolled to
 * the latest message, the back control and the browser Back return to the
 * inbox, no horizontal overflow, dark + light. A flagged thread: the compact
 * attention dot in the inbox, the flag and Mark resolved as one group. (Plan section A-P.)
 */
import { expect, test } from './support/fixtures';
import { seedConversation } from './support/api';
import { testName } from './support/env';
import { A, horizontalOverflow, loginAdmin, offenders, setTheme, shot } from './support/ui';

test.describe('admin on mobile', () => {
  test('gate on a phone (A-P4)', async ({ page }, testInfo) => {
    await page.goto('/admin');
    await expect(A.gate(page)).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'admin-gate-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'admin-gate-light');
  });

  test('master/detail: inbox full screen -> thread scrolled to latest -> back control / browser Back (A-P1..P4)', async ({ page, request }, testInfo) => {
    const name = testName('MobileAdmin');
    const cid = await seedConversation(request, { name, messages: ['Q11', 'Q12', 'Q13', 'Q14'] });
    await loginAdmin(page);
    const vp = page.viewportSize()!;

    // Inbox fills the screen; the thread pane is hidden.
    await expect(A.shell(page)).toHaveAttribute('data-view', 'inbox');
    const side = (await page.locator('.sidebar').boundingBox())!;
    expect(side.width).toBeGreaterThanOrEqual(vp.width - 1);
    await expect(A.main(page)).toBeHidden();
    expect(await horizontalOverflow(page), (await offenders(page)).join('; ')).toBeLessThanOrEqual(0);
    await A.search(page).fill(name);
    await expect(A.row(page, cid)).toBeVisible();
    await A.search(page).blur();
    await shot(page, testInfo, 'admin-inbox-dark');

    // Tap: the thread takes over, scrolled to the latest message, with a back control.
    const historyLength = await page.evaluate(() => history.length);
    await A.row(page, cid).tap();
    await expect(A.shell(page)).toHaveAttribute('data-view', 'thread');
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(A.main(page)).toBeVisible();
    await expect(A.back(page)).toBeVisible();
    await expect(A.threadName(page)).toHaveText(name);
    await expect(A.threadMsgs(page)).toHaveCount(8);
    await expect.poll(() => page.locator('#thread').evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight)).toBeLessThanOrEqual(4);
    await expect(page.locator('.thread-inner > .msg').last()).toBeInViewport();
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
    // Touch: opening a thread does not pop the keyboard.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
    expect(await horizontalOverflow(page), (await offenders(page)).join('; ')).toBeLessThanOrEqual(0);
    const dock = (await page.locator('.admin-composer-dock').boundingBox())!;
    expect(dock.y + dock.height).toBeLessThanOrEqual(vp.height + 1);
    await shot(page, testInfo, 'admin-thread-dark');

    // Back control -> inbox (with the row still there).
    await A.back(page).tap();
    await expect(A.shell(page)).toHaveAttribute('data-view', 'inbox');
    await expect(A.row(page, cid)).toBeVisible();
    await expect(A.row(page, cid)).toHaveClass(/is-active/);

    // Browser Back also returns to the inbox; Forward re-opens the thread.
    await A.row(page, cid).tap();
    await expect(A.shell(page)).toHaveAttribute('data-view', 'thread');
    await page.goBack();
    await expect(A.shell(page)).toHaveAttribute('data-view', 'inbox');
    await expect(page).toHaveURL(/\/admin$/);
    await page.goForward();
    await expect(A.shell(page)).toHaveAttribute('data-view', 'thread');
    await expect(A.threadName(page)).toHaveText(name);

    // Reply from the phone.
    await A.composer(page).tap();
    await A.composer(page).fill('Replying from my phone.');
    await page.locator('.admin-composer-dock .btn-send').tap();
    await expect(page.locator('.thread-inner > .msg--human[data-id]')).toHaveCount(1);
    await expect(page.locator('.thread-inner > .msg--human .human-tag')).toHaveText('You · sent to visitor');

    await setTheme(page, 'light');
    await shot(page, testInfo, 'admin-thread-light');
    await A.back(page).tap();
    await expect(A.shell(page)).toHaveAttribute('data-view', 'inbox');
    await shot(page, testInfo, 'admin-inbox-light');
  });

  test('a flagged thread on a phone: compact dot in the inbox; the flag and Mark resolved sit together, same height (A-P6)', async ({ page, request }, testInfo) => {
    const name = testName('MobileFlag');
    const cid = await seedConversation(request, { name, messages: ['Q9'] });
    await page.route('**/admin/api/conversations', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      for (const s of body.conversations) if (s.conversation_id === cid) s.needs_attention = true;
      await route.fulfill({ response: res, json: body });
    });
    await loginAdmin(page);
    await A.search(page).fill(name);
    const row = A.row(page, cid);
    await expect(row).toHaveClass(/is-attention/);
    // The yellow dot, not the wide pill: the preview keeps its room.
    await expect(row.locator('.attn-dot')).toBeVisible();
    await expect(row.locator('.badge--attention')).toBeHidden();
    await A.search(page).blur();
    await shot(page, testInfo, 'admin-inbox-attention-dot');

    await row.tap();
    await expect(A.shell(page)).toHaveAttribute('data-view', 'thread');
    await expect(A.flag(page)).toBeVisible();
    await expect(A.resolve(page)).toBeVisible();
    const flag = (await A.flag(page).boundingBox())!;
    const btn = (await A.resolve(page).boundingBox())!;
    expect(Math.round(flag.height)).toBe(Math.round(btn.height));
    expect(btn.height).toBeGreaterThanOrEqual(40);
    // Side by side on one row, next to each other (not pushed to opposite edges).
    expect(Math.abs(flag.y - btn.y)).toBeLessThanOrEqual(1);
    expect(btn.x - (flag.x + flag.width)).toBeLessThanOrEqual(16);
    expect(await horizontalOverflow(page), (await offenders(page)).join('; ')).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'admin-thread-attention-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'admin-thread-attention-light');
  });
});
