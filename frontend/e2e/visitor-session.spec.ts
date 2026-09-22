/**
 * Session behaviour: Keep chat (cookie avatar_cid) on / off, restore after
 * reload (thread + name), Reset, and separate visitors in separate browsers.
 * (Plan section V-F, V-I3.)
 */
import { expect, test } from './support/fixtures';
import { testName } from './support/env';
import { V, cookieCid, openVisitor, renderedIds, sendByEnter, shot, waitForAvatarReplies } from './support/ui';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test.describe('visitor session', () => {
  test('Keep chat defaults on and writes a UUID cookie (V-F1)', async ({ page }) => {
    await openVisitor(page);
    await expect(V.keep(page)).toBeChecked();
    const cid = await cookieCid(page);
    expect(cid).toMatch(UUID);
    const cookie = (await page.context().cookies()).find((c) => c.name === 'avatar_cid')!;
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');
    expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 300 * 24 * 3600);
  });

  test('Keep chat on: reload restores the same conversation, messages in order and the name (V-F2)', async ({ page }, testInfo) => {
    const name = testName('Keep');
    await openVisitor(page);
    await V.name(page).fill(name);
    await sendByEnter(page, 'Q1');
    await waitForAvatarReplies(page, 1);
    await sendByEnter(page, 'Q5');
    await waitForAvatarReplies(page, 2);
    const cid = await cookieCid(page);
    const before = await renderedIds(page);
    expect(before).toHaveLength(4);

    // A new tab in the same browser (fresh page, same cookie + storage) restores everything.
    await page.reload();
    await expect(V.thread(page)).toHaveAttribute('data-state', 'ready');
    expect(await cookieCid(page)).toBe(cid);
    await expect(V.msgs(page)).toHaveCount(4);
    expect(await renderedIds(page)).toEqual(before);
    await expect(V.intro(page)).toBeHidden();
    await expect(V.name(page)).toHaveValue(name);
    await expect(V.composer(page)).toBeFocused();
    // Scrolled to the latest message.
    const atBottom = await page.locator('#convo').evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight < 4);
    expect(atBottom).toBe(true);

    // The name comes back from the server even when local storage was cleared.
    await page.evaluate(() => localStorage.removeItem('avatar-name'));
    await page.reload();
    await expect(V.msgs(page)).toHaveCount(4);
    await expect(V.name(page)).toHaveValue(name);
    await shot(page, testInfo, 'visitor-restored-thread');
  });

  test('Keep chat off: cookie removed, every load is a fresh chat; the switch stays off (V-F3, V-F4)', async ({ page }) => {
    const name = testName('NoKeep');
    await openVisitor(page);
    await V.name(page).fill(name);
    await page.locator('label.keep-switch').click();
    await expect(V.keep(page)).not.toBeChecked();
    expect(await cookieCid(page)).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('avatar-keep'))).toBe('0');
    await expect(page.locator('#liveRegion')).toContainText('Keep chat is off');
    await expect(V.composer(page)).toBeFocused();

    // The chat on screen still works (and uses a stable id for this page).
    const ids: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/api/chat')) ids.push(JSON.parse(r.postData() ?? '{}').conversation_id);
    });
    await sendByEnter(page, 'Q2');
    await waitForAvatarReplies(page, 1);
    await sendByEnter(page, 'Q3');
    await waitForAvatarReplies(page, 2);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);

    await page.reload();
    await expect(V.thread(page)).toHaveAttribute('data-state', 'ready');
    await expect(V.keep(page)).not.toBeChecked();
    await expect(V.msgs(page)).toHaveCount(0);
    await expect(V.intro(page)).toBeVisible();
    expect(await cookieCid(page)).toBeNull();
    await sendByEnter(page, 'Q4');
    await waitForAvatarReplies(page, 1);
    expect(ids[2]).toMatch(UUID);
    expect(ids[2]).not.toBe(ids[0]);

    // Turning Keep chat back on writes the current id to the cookie.
    await page.locator('label.keep-switch').click();
    await expect(V.keep(page)).toBeChecked();
    expect(await cookieCid(page)).toBe(ids[2]);
    await page.reload();
    await expect(V.msgs(page)).toHaveCount(2);
  });

  test('Reset starts a new conversation, clears the view and focuses the composer (V-F5, V-F6)', async ({ page, request }, testInfo) => {
    const name = testName('Reset');
    await openVisitor(page);
    await V.name(page).fill(name);
    await sendByEnter(page, 'Q6');
    await waitForAvatarReplies(page, 1);
    const oldCid = await cookieCid(page);

    await V.reset(page).click();
    await expect(V.msgs(page)).toHaveCount(0);
    await expect(page.locator('#thread > .day-sep')).toHaveCount(0);
    await expect(V.intro(page)).toBeVisible();
    await expect(V.composer(page)).toBeFocused();
    await expect(page.locator('#liveRegion')).toContainText('Started a new conversation');
    const newCid = await cookieCid(page);
    expect(newCid).toMatch(UUID);
    expect(newCid).not.toBe(oldCid);
    await shot(page, testInfo, 'visitor-after-reset');

    // The old conversation is still on the server (just detached from this browser).
    const old = await (await request.get(`/api/conversations/${oldCid}`)).json();
    expect(old.messages).toHaveLength(2);

    // The next message goes to the new id; a reload restores only the new thread.
    await sendByEnter(page, 'Q7');
    await waitForAvatarReplies(page, 1);
    const fresh = await (await request.get(`/api/conversations/${newCid}`)).json();
    expect(fresh.messages.map((m: any) => m.content)[0]).toBe('Q7');
    await page.reload();
    await expect(V.msgs(page)).toHaveCount(2);
    await expect(V.visitorMsgs(page).first().locator('.bubble')).toHaveText('Q7');
  });

  test('two visitors in separate browsers get separate threads (V-I3)', async ({ browser, baseURL }) => {
    const ctxA = await browser.newContext({ baseURL });
    const ctxB = await browser.newContext({ baseURL });
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openVisitor(a);
    await openVisitor(b);
    await V.name(a).fill(testName('UserA'));
    await V.name(b).fill(testName('UserB'));
    await sendByEnter(a, 'Q8');
    await sendByEnter(b, 'Q9');
    await waitForAvatarReplies(a, 1);
    await waitForAvatarReplies(b, 1);
    const cidA = await cookieCid(a);
    const cidB = await cookieCid(b);
    expect(cidA).not.toBe(cidB);
    await a.reload();
    await b.reload();
    await expect(V.visitorMsgs(a).first().locator('.bubble')).toHaveText('Q8');
    await expect(V.visitorMsgs(b).first().locator('.bubble')).toHaveText('Q9');
    await expect(V.msgs(a)).toHaveCount(2);
    await expect(V.msgs(b)).toHaveCount(2);
    await ctxA.close();
    await ctxB.close();
  });
});
