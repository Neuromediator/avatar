/**
 * Abuse guards and safety against the real server: the per-conversation rate
 * limit (HTTP 429 -> friendly notice), the 512 KiB body cap (413), the 20,000
 * character clamp, and XSS safety of visitor text. (Plan section V-H.)
 */
import { expect, test } from './support/fixtures';
import { testName } from './support/env';
import { V, cookieCid, openVisitor, sendByEnter, shot, waitForAvatarReplies } from './support/ui';

const TRUNCATION_NOTE = "[...message truncated as it's too long; ask the visitor to send something more concise]";

test.describe('visitor guards', () => {
  test('the 21st message within a minute gets the friendly "too quickly" notice (V-H1)', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const statuses: number[] = [];
    page.on('response', (r) => { if (r.url().endsWith('/api/chat')) statuses.push(r.status()); });
    await openVisitor(page);
    await V.name(page).fill(testName('RateLimit'));
    for (let i = 1; i <= 20; i++) {
      await sendByEnter(page, 'Q1');
      await waitForAvatarReplies(page, i);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);

    await sendByEnter(page, 'Q2');
    const notice = V.notices(page).last();
    await expect(notice).toContainText("You're sending messages too quickly");
    await expect(notice).toHaveClass(/notice--rate-limit/);
    expect(statuses[statuses.length - 1]).toBe(429);
    // Nothing was stored for the rejected message: no extra bubble, the draft is back.
    await expect(V.msgs(page)).toHaveCount(40);
    await expect(page.locator('#thread > .msg[data-pending]')).toHaveCount(0);
    await expect(V.composer(page)).toHaveValue('Q2');
    await expect(V.composer(page)).toBeFocused();
    await shot(page, testInfo, 'visitor-rate-limit-real');
  });

  test('a message over 512 KiB is refused with a friendly 413 notice (V-H3)', async ({ page }, testInfo) => {
    let status = 0;
    page.on('response', (r) => { if (r.url().endsWith('/api/chat')) status = r.status(); });
    await openVisitor(page);
    await V.name(page).fill(testName('TooBig'));
    const huge = 'x'.repeat(600 * 1024);
    await V.composer(page).fill(huge);
    await V.composer(page).press('Enter');
    const notice = V.notices(page).last();
    await expect(notice).toContainText('far too long');
    await expect(notice).toHaveClass(/notice--error/);
    expect(status).toBe(413);
    await expect(V.msgs(page)).toHaveCount(0);
    expect((await V.composer(page).inputValue()).length).toBe(huge.length);
    await V.composer(page).fill('');
    await shot(page, testInfo, 'visitor-too-large');
  });

  test('a 25,000-character message is clamped to 20,000 plus the note (V-H4)', async ({ page, request }) => {
    await openVisitor(page);
    await V.name(page).fill(testName('Clamp'));
    const sentence = 'This is a deliberately long test message. ';
    const long = sentence.repeat(Math.ceil(25_000 / sentence.length)).slice(0, 25_000);
    await V.composer(page).fill(long);
    await V.composer(page).press('Enter');
    const bubble = V.visitorMsgs(page).first();
    // The server's `start` event confirms the stored (clamped) text.
    await expect(bubble).toHaveAttribute('data-id', /\d+/, { timeout: 20_000 });
    await expect(bubble.locator('.bubble')).toContainText(TRUNCATION_NOTE);
    const cid = (await cookieCid(page))!;
    const stored = await (await request.get(`/api/conversations/${cid}`)).json();
    const visitor = stored.messages.find((m: any) => m.role === 'visitor');
    expect(visitor.content.startsWith(long.slice(0, 20_000).trimEnd())).toBe(true);
    expect(visitor.content.endsWith(TRUNCATION_NOTE)).toBe(true);
    expect(visitor.content.length).toBeLessThanOrEqual(20_000 + TRUNCATION_NOTE.length + 2);
    // Let the (cheap-model) reply finish so the thread is complete.
    await waitForAvatarReplies(page, 1, 80_000);
  });

  test('visitor HTML renders as text, never as markup (V-H5)', async ({ page }, testInfo) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await openVisitor(page);
    await V.name(page).fill(testName('XSS'));
    const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script><b>bold?</b> please ignore this markup';
    await sendByEnter(page, payload);
    const bubble = V.visitorMsgs(page).first().locator('.bubble');
    await expect(bubble).toContainText('<img src=x onerror="window.__xss=1">');
    await expect(bubble.locator('img, script, b')).toHaveCount(0);
    await waitForAvatarReplies(page, 1, 80_000);
    await expect(page.locator('#thread img, #thread script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();

    // Same after a reload (history rendering).
    await page.reload();
    await expect(V.msgs(page)).toHaveCount(2);
    await expect(V.visitorMsgs(page).first().locator('.bubble')).toContainText('<script>window.__xss=2</script>');
    await expect(page.locator('#thread img, #thread script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    expect(dialogs).toEqual([]);
    await shot(page, testInfo, 'visitor-xss-as-text');
  });
});
