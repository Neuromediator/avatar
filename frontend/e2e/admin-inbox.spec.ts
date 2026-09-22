/**
 * Admin inbox: rows (initials, name, time, preview), most recent first,
 * unread / read / needs-you / active states, opening marks read (UI and API),
 * search, filter chips, the unread count in the tab title, and the live
 * refresh when a visitor writes; the dashboard's desktop layouts (1440 / 1024)
 * and its responsive widths (360 / 768 master/detail, 900 side by side).
 * Tests find their own conversations by a unique TEST name, so other threads
 * in the shared database do not matter. (Plan sections A-M, A-P5, A-P7..P9.)
 */
import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { adminApi, chatViaApi, seedConversation } from './support/api';
import { testName } from './support/env';
import { A, horizontalOverflow, loginAdmin, offenders, openThread, setTheme, shot } from './support/ui';

/** The tab title "(n) Avatar Admin" matches the number of unread rows shown (read in one go). */
async function titleMatchesUnread(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const unread = document.querySelectorAll('#convoList > .convo-item.is-unread').length;
    const m = /^\((\d+)\) Avatar Admin$/.exec(document.title);
    return m ? Number(m[1]) === unread : unread === 0 && document.title === 'Avatar Admin';
  });
}

/** Row ids currently listed, top to bottom. */
async function listedIds(page: Page): Promise<string[]> {
  return A.rows(page).evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.id!));
}

test.describe('admin inbox', () => {
  test('rows, ordering, unread -> read, active row, title count, live reordering (A-M1..M3, M5, M8, M9)', async ({ page, request, baseURL }, testInfo) => {
    const group = testName('Inbox');
    const cidA = await seedConversation(request, { name: `${group} Alpha`, messages: ['Q1'] });
    const cidB = await seedConversation(request, { name: `${group} Bravo`, messages: ['Q2'] });

    await loginAdmin(page);
    // Tab title "(n) Avatar Admin" = number of unread rows (checked atomically, no filter applied).
    await expect(page).toHaveTitle(/^\(\d+\) Avatar Admin$/);
    await expect.poll(() => titleMatchesUnread(page)).toBe(true);
    const total = await A.rows(page).count();
    await expect(page.locator('.sidebar-title .count-badge')).toHaveText(String(total));

    await A.search(page).fill(group);
    await expect(A.rows(page)).toHaveCount(2);
    expect(await listedIds(page)).toEqual([cidB, cidA]); // most recent first

    const rowA = A.row(page, cidA);
    await expect(rowA.locator('.avatar-initials')).toHaveText('TA');
    await expect(rowA.locator('.convo-name')).toHaveText(`${group} Alpha`);
    await expect(rowA.locator('.convo-preview')).toHaveText('Q1');
    await expect(rowA.locator('.msg-time')).toHaveText(/\d{1,2}:\d{2}/);
    await expect(rowA).toHaveClass(/is-unread/);
    await expect(rowA.locator('.badge--dot')).toBeVisible();
    await shot(page, testInfo, 'admin-inbox-unread');

    // Open A: it becomes active and is marked read on the server.
    await openThread(page, cidA);
    await expect(rowA).toHaveClass(/is-active/);
    await expect(rowA).toHaveAttribute('aria-selected', 'true');
    const admin = await adminApi(baseURL!);
    try {
      const sA = await admin.summary(cidA);
      expect(sA.unread_count).toBe(0);
      expect(sA.needs_attention).toBe(false);
      // The row being viewed counts as read in the title too (search does not change the count).
      await A.search(page).fill('');
      await expect.poll(async () => (await titleMatchesUnread(page)) && !(await rowA.evaluate((e) => e.classList.contains('is-unread')))).toBe(true);
      await A.search(page).fill(group);

      // Move to B: A now shows the read check.
      await A.row(page, cidB).click();
      await expect(A.row(page, cidB)).toHaveClass(/is-active/);
      await expect(rowA).not.toHaveClass(/is-unread|is-active/);
      await expect(rowA.locator('.convo-read')).toBeVisible();
      await shot(page, testInfo, 'admin-inbox-read-and-active');

      // A visitor writes in A: within ~12 s it jumps back to the top, unread again.
      await chatViaApi(request, cidA, 'Q3', `${group} Alpha`);
      await expect.poll(() => listedIds(page), { timeout: 13_000 }).toEqual([cidA, cidB]);
      await expect(rowA).toHaveClass(/is-unread/);
      await expect(rowA.locator('.convo-preview')).toHaveText('Q3');

      // A brand-new conversation appears without a reload.
      const cidC = await seedConversation(request, { name: `${group} Charlie`, messages: ['Q4'] });
      await expect(A.row(page, cidC)).toBeVisible({ timeout: 13_000 });
      expect((await listedIds(page))[0]).toBe(cidC);
    } finally {
      await admin.dispose();
    }
  });

  test('search by name and id; no-match state; Esc clears; Enter opens (A-M6)', async ({ page, request }, testInfo) => {
    const group = testName('Search');
    const cid1 = await seedConversation(request, { name: `${group} One`, messages: ['Q5'] });
    const cid2 = await seedConversation(request, { name: `${group} Two`, messages: ['Q6'] });
    await loginAdmin(page);
    const all = await A.rows(page).count();

    await A.search(page).fill(`${group} One`);
    await expect(A.rows(page)).toHaveCount(1);
    await expect(A.row(page, cid1)).toBeVisible();

    await A.search(page).fill(cid2);
    await expect(A.rows(page)).toHaveCount(1);
    await expect(A.row(page, cid2)).toBeVisible();

    await A.search(page).fill(group.toLowerCase());
    await expect(A.rows(page)).toHaveCount(2);

    // Hover state: the row background changes under the pointer.
    const row1 = A.row(page, cid1);
    const restBg = await row1.evaluate((e) => getComputedStyle(e).backgroundColor);
    await row1.hover();
    await expect.poll(() => row1.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(restBg);
    await shot(page, testInfo, 'admin-inbox-row-hover');
    await A.search(page).hover();

    await A.search(page).fill('zzz-no-such-conversation-zzz');
    await expect(A.rows(page)).toHaveCount(0);
    await expect(page.locator('.inbox-empty')).toContainText('No matches');
    await shot(page, testInfo, 'admin-inbox-no-matches');

    await A.search(page).press('Escape');
    await expect(A.search(page)).toHaveValue('');
    await expect.poll(() => A.rows(page).count()).toBeGreaterThanOrEqual(all);

    // Enter in search opens the first match.
    await A.search(page).fill(`${group} Two`);
    await A.search(page).press('Enter');
    await expect(A.row(page, cid2)).toHaveClass(/is-active/);
    await expect(page.locator('#threadName')).toHaveText(`${group} Two`);
  });

  test('filter chips: Unread and Needs you with counts; needs-you row styling (A-M4, A-M7)', async ({ page, request }, testInfo) => {
    const group = testName('Filter');
    const cidFlag = await seedConversation(request, { name: `${group} Flagged`, messages: ['Q7'] });
    const cidPlain = await seedConversation(request, { name: `${group} Plain`, messages: ['Q8'] });
    // Present one of them as flagged (needs_attention is set by a real push_tool
    // call - that path is covered in admin-push.spec.ts; here the list is decorated).
    await page.route('**/admin/api/conversations', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      for (const s of body.conversations) if (s.conversation_id === cidFlag) s.needs_attention = true;
      await route.fulfill({ response: res, json: body });
    });
    await loginAdmin(page);
    await A.search(page).fill(group);
    await expect(A.rows(page)).toHaveCount(2);

    const flagged = A.row(page, cidFlag);
    await expect(flagged).toHaveClass(/is-attention/);
    await expect(flagged.locator('.badge--attention')).toHaveText('Needs you');
    expect(await flagged.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await expect(A.chip(page, 'attention')).toHaveClass(/has-items/);
    expect(Number(await A.chip(page, 'attention').locator('.chip-count').innerText())).toBeGreaterThanOrEqual(1);
    await expect(flagged.locator('.attn-dot')).toBeHidden();
    await shot(page, testInfo, 'admin-inbox-needs-you-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'admin-inbox-needs-you-light');
    await setTheme(page, 'dark');

    // Narrower sidebar (1024): the compact yellow dot replaces the pill, so the preview keeps its room.
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(flagged.locator('.badge--attention')).toBeHidden();
    await expect(flagged.locator('.attn-dot')).toBeVisible();
    await expect(flagged.locator('.attn-dot')).toHaveAttribute('title', 'Needs you');
    await shot(page, testInfo, 'admin-inbox-needs-you-1024');
    await page.setViewportSize({ width: 1440, height: 900 });

    await A.chip(page, 'attention').click();
    await expect(A.chip(page, 'attention')).toHaveAttribute('aria-pressed', 'true');
    await expect(A.rows(page)).toHaveCount(1);
    await expect(flagged).toBeVisible();

    await A.chip(page, 'unread').click();
    await expect(A.chip(page, 'unread')).toHaveAttribute('aria-pressed', 'true');
    await expect(A.rows(page)).toHaveCount(2);
    for (const cls of await A.rows(page).evaluateAll((r) => r.map((e) => e.className))) expect(cls).toContain('is-unread');

    // Clicking the active chip again goes back to All.
    await A.chip(page, 'unread').click();
    await expect(A.chip(page, 'all')).toHaveAttribute('aria-pressed', 'true');
    await expect(A.row(page, cidPlain)).toBeVisible();
  });

  test('desktop layout: sidebar and thread side by side, no overflow at 1440 / 1024 (A-P5)', async ({ page, request }, testInfo) => {
    const cid = await seedConversation(request, { name: testName('Layout'), messages: ['Q9', 'Q13'] });
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 1440) await loginAdmin(page);
      if (width === 1440) await openThread(page, cid, cid);
      const side = (await page.locator('.sidebar').boundingBox())!;
      const main = (await A.main(page).boundingBox())!;
      expect(side.x + side.width).toBeLessThanOrEqual(main.x + 1);
      expect(Math.abs(side.y - main.y)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await expect(A.back(page)).toBeHidden();
      // The filter chips stay on one row (All / Needs you · n / Unread · n).
      const chipTops = await page.locator('.filter-chip').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(chipTops).size, `chip tops ${chipTops.join(',')}`).toBe(1);
      // The posting-as note never leaves a single word on its last line.
      await expect(page.locator('.posting-as-text')).toHaveCSS('text-wrap', /pretty/);
      await shot(page, testInfo, `admin-layout-${width}`);
    }
  });

  test('responsive widths 360 / 768 / 900: master/detail up to 820 px, side by side above; no overflow (A-P7..P9)', async ({ page, request, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const name = testName('AdminWidth');
    const cid = await seedConversation(request, { name, messages: ['Q11', 'Q6'] });
    const admin = await adminApi(baseURL!);
    try {
      // The owner's reply carries a long unbroken URL and word that must wrap inside the bubble.
      await admin.postHuman(cid, `The real me: this link must wrap https://example.com/${'a'.repeat(160)} and so must ${'Supercalifragilistic'.repeat(6)}.`);
    } finally {
      await admin.dispose();
    }
    // Flag the thread (the real push_tool path is A-O; here the list is decorated, as in A-M4 / A-P6).
    await page.route('**/admin/api/conversations', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      for (const s of body.conversations) if (s.conversation_id === cid) s.needs_attention = true;
      await route.fulfill({ response: res, json: body });
    });
    const noOverflow = async (label: string) => {
      expect(await horizontalOverflow(page), `${label}: ${(await offenders(page)).join('; ')}`).toBeLessThanOrEqual(0);
    };

    const sizes: [number, number][] = [[360, 780], [768, 1024], [900, 800]];
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      if (width === 360) await loginAdmin(page);
      else await page.goto('/admin');
      await expect(A.shell(page)).toBeVisible();
      await A.search(page).fill(name);
      const row = A.row(page, cid);
      await expect(row).toBeVisible();
      await expect(row).toHaveClass(/is-attention/);
      // <= 1180 px: the compact yellow dot, not the wide pill.
      await expect(row.locator('.attn-dot')).toBeVisible();
      await expect(row.locator('.badge--attention')).toBeHidden();
      await A.search(page).blur();

      if (width <= 820) {
        // Master: the inbox fills the screen and the thread pane is hidden.
        await expect(A.shell(page)).toHaveAttribute('data-view', 'inbox');
        const side = (await page.locator('.sidebar').boundingBox())!;
        expect(side.width).toBeGreaterThanOrEqual(width - 1);
        await expect(A.main(page)).toBeHidden();
        await noOverflow(`${width} inbox`);
        await shot(page, testInfo, `admin-width-${width}-inbox-dark`);
        // Detail: the thread takes over, with the back control.
        await row.click();
        await expect(A.shell(page)).toHaveAttribute('data-view', 'thread');
        await expect(page.locator('.sidebar')).toBeHidden();
        await expect(A.back(page)).toBeVisible();
      } else {
        // 821-1040 px: side by side, the 320 px sidebar, no back control, the secure note hidden.
        await openThread(page, cid);
        const side = (await page.locator('.sidebar').boundingBox())!;
        const main = (await A.main(page).boundingBox())!;
        expect(side.x + side.width).toBeLessThanOrEqual(main.x + 1);
        expect(Math.abs(side.y - main.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(side.width - 320)).toBeLessThanOrEqual(1);
        await expect(page.locator('.sidebar')).toBeVisible();
        await expect(A.back(page)).toBeHidden();
        await expect(page.locator('.secure-note')).toBeHidden();
      }
      if (width <= 460) {
        // Phone: the owner chip shrinks to the photo.
        await expect(page.locator('.owner-chip > span').first()).toBeHidden();
        await expect(page.locator('.owner-chip .owner-avatar')).toBeVisible();
      }

      await expect(A.main(page)).not.toHaveClass(/is-loading/);
      await expect(A.threadName(page)).toHaveText(name);
      await expect(A.threadMsgs(page)).toHaveCount(5);
      await expect(page.locator('.thread-inner > .msg--human .human-tag')).toHaveText('You · sent to visitor');
      await expect(A.flag(page)).toBeVisible();
      await expect(A.resolve(page)).toBeVisible();
      // Opened scrolled to the latest message.
      await expect.poll(() => page.locator('#thread').evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight)).toBeLessThanOrEqual(4);
      await expect(A.threadMsgs(page).last()).toBeInViewport();
      await noOverflow(`${width} thread`);
      const widest = await page.locator('.thread-inner .bubble').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
      expect(widest).toBeLessThanOrEqual(width);
      const dock = (await page.locator('.admin-composer-dock').boundingBox())!;
      expect(dock.y + dock.height).toBeLessThanOrEqual(height + 1);
      expect(dock.x + dock.width).toBeLessThanOrEqual(width + 1);
      await shot(page, testInfo, `admin-width-${width}-dark`);
      if (width === 768) {
        await setTheme(page, 'light');
        await noOverflow('768 thread light');
        await shot(page, testInfo, 'admin-width-768-light');
        await setTheme(page, 'dark');
      }
    }
  });

  test('visitor-supplied HTML (name and message) renders as text in the dashboard (A-M10)', async ({ page, request }, testInfo) => {
    const tag = testName('AdminXSS').split(' ').pop()!;
    const name = `TEST ${tag} <img src=x onerror="window.__adminXss=1">`;
    const cid = await seedConversation(request, { name, messages: ['Q1'] });
    // A visitor line with markup too (one cheap-model reply).
    const markup = '<img src=x onerror="window.__adminXss=2"><script>window.__adminXss=3</script> TEST markup line';
    const r = await chatViaApi(request, cid, markup, name);
    expect(r.status).toBe(200);
    await loginAdmin(page);
    await A.search(page).fill(tag);
    const row = A.row(page, cid);
    await expect(row).toBeVisible();
    await expect(row.locator('.convo-name')).toHaveText(name);
    await expect(row.locator('img')).toHaveCount(0);
    await openThread(page, cid);
    await expect(A.threadName(page)).toHaveText(name);
    await expect(page.locator('.thread-inner > .msg--visitor .bubble').last()).toContainText('<script>window.__adminXss=3</script>');
    await expect(row.locator('.convo-preview')).toContainText('<img src=x');
    await expect(page.locator('.thread-head img, .sidebar img, .thread-inner img, .thread-inner script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__adminXss)).toBeUndefined();
    await shot(page, testInfo, 'admin-xss-name-as-text');
  });

  test('Tab into the inbox before anything is selected: the list shows a focus ring (A-M11)', async ({ page, request }, testInfo) => {
    await seedConversation(request, { name: testName('FocusRing'), messages: ['Q4'] });
    await loginAdmin(page);
    await expect(A.rows(page).first()).toBeVisible();
    await A.search(page).click();
    // Search -> the three filter chips -> the list.
    for (let i = 0; i < 6 && !(await A.list(page).evaluate((e) => e === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(A.list(page)).toBeFocused();
    await expect(page.locator('#convoList > .convo-item.is-active')).toHaveCount(0);
    expect(await A.list(page).evaluate((e) => getComputedStyle(e).boxShadow)).toMatch(/inset/);
    await shot(page, testInfo, 'admin-inbox-list-focus');
    // Once a row is active, the ring moves to that row.
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#convoList > .convo-item.is-active')).toHaveCount(1);
    await A.list(page).focus();
    expect(await A.list(page).evaluate((e) => getComputedStyle(e).boxShadow)).toBe('none');
  });
});
