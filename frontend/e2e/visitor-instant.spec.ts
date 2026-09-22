/**
 * Qn instant answers and the ?q=N deep link, against the real server (no LLM
 * call is made for a bare Qn). (Plan sections V-D, V-E.)
 */
import { expect, test } from './support/fixtures';
import { faqs, testName } from './support/env';
import { seedConversation } from './support/api';
import { V, cookieCid, openVisitor, sendByEnter, setTheme, shot, waitForAvatarReplies } from './support/ui';

test.describe('Qn instant answers', () => {
  test('Q2 returns the FAQ instantly with the instant tag and the restated question (V-D1, V-D4)', async ({ page }, testInfo) => {
    const faq = faqs().get(2)!;
    await openVisitor(page);
    await V.name(page).fill(testName('Instant'));
    const t0 = Date.now();
    await sendByEnter(page, 'Q2');
    await waitForAvatarReplies(page, 1);
    expect(Date.now() - t0).toBeLessThan(5_000);

    const reply = V.avatarMsgs(page).last();
    await expect(reply.locator('.instant-tag')).toHaveText('instant · Q2');
    await expect(reply.locator('.instant-tag')).toHaveAttribute('title', /no model call/);
    await expect(reply.locator('.tool-status')).toHaveCount(0);
    const bubble = reply.locator('.bubble');
    await expect(bubble.locator('p').first()).toContainText(`Q2: ${faq.question}`);
    await expect(bubble.locator('p strong').first()).toHaveText('Q2:');
    const text = await bubble.innerText();
    expect(text.indexOf(faq.question)).toBeLessThan(text.indexOf(faq.answer.split('\n')[0]!.slice(0, 30)));
    await expect(V.composer(page)).toBeFocused();
    await shot(page, testInfo, 'visitor-instant-q2-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'visitor-instant-q2-light');
  });

  test('lowercase q11 renders Markdown with bold and new-tab links (V-D2)', async ({ page }, testInfo) => {
    await openVisitor(page);
    await V.name(page).fill(testName('Links'));
    await sendByEnter(page, 'q11');
    await waitForAvatarReplies(page, 1);
    const reply = V.avatarMsgs(page).last();
    await expect(reply.locator('.instant-tag')).toHaveText('instant · Q11');
    const links = reply.locator('.bubble a');
    expect(await links.count()).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < await links.count(); i++) {
      await expect(links.nth(i)).toHaveAttribute('href', /^https:\/\//);
      await expect(links.nth(i)).toHaveAttribute('target', '_blank');
      await expect(links.nth(i)).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(await reply.locator('.bubble strong').count()).toBeGreaterThanOrEqual(2);
    // Clicking a link opens a new tab (popup), the chat stays put.
    const [popup] = await Promise.all([
      page.context().waitForEvent('page'),
      links.first().click(),
    ]);
    expect(popup.url()).toMatch(/^(https:|about:blank)/);
    await popup.close();
    await expect(page).toHaveURL(/localhost|127\.0\.0\.1/);
    await shot(page, testInfo, 'visitor-instant-q11-links');
  });

  test('an unknown Q99 explains the valid range (V-D3)', async ({ page }, testInfo) => {
    const numbers = [...faqs().keys()].sort((a, b) => a - b);
    await openVisitor(page);
    await V.name(page).fill(testName('Unknown'));
    await sendByEnter(page, 'Q99');
    await waitForAvatarReplies(page, 1);
    const reply = V.avatarMsgs(page).last();
    // No such FAQ: the tag does not claim a Q99 entry.
    await expect(reply.locator('.instant-tag')).toHaveText('instant');
    await expect(reply.locator('.bubble')).toContainText('There is no Q99');
    await expect(reply.locator('.bubble')).toContainText(`Q${numbers[0]} to Q${numbers[numbers.length - 1]}`);
    await shot(page, testInfo, 'visitor-instant-q99');
  });

  test('headings in an answer are larger than its text and group with their own section (V-D6)', async ({ page }, testInfo) => {
    // The FAQ answer that uses Markdown headings (### ...).
    const faq = [...faqs().values()].find((f) => /^#{2,4} /m.test(f.answer));
    expect(faq, 'an FAQ answer with headings').toBeTruthy();
    await openVisitor(page);
    await V.name(page).fill(testName('Headings'));
    await sendByEnter(page, `Q${faq!.faq}`);
    await waitForAvatarReplies(page, 1);
    const bubble = V.avatarMsgs(page).last().locator('.bubble');
    const heading = bubble.locator('h2, h3, h4').nth(1);
    await expect(heading).toBeVisible();
    const m = await heading.evaluate((h) => {
      const cs = getComputedStyle(h);
      const body = getComputedStyle(h.closest('.bubble')!);
      return { size: parseFloat(cs.fontSize), body: parseFloat(body.fontSize), top: parseFloat(cs.marginTop), bottom: parseFloat(cs.marginBottom), font: cs.fontFamily };
    });
    expect(m.font).toMatch(/Newsreader/);
    // Newsreader's small x-height: clearly larger than the Hanken body text.
    expect(m.size).toBeGreaterThanOrEqual(m.body * 1.15);
    // More space above (after the previous section) than below (its own content).
    expect(m.top).toBeGreaterThan(m.bottom * 2);
    await heading.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'visitor-instant-headings');
  });

  test('instant rows persist: a reload shows them with the instant tag (V-D5)', async ({ page }) => {
    await openVisitor(page);
    await V.name(page).fill(testName('Persist'));
    await sendByEnter(page, 'Q3');
    await waitForAvatarReplies(page, 1);
    await page.reload();
    await expect(V.thread(page)).toHaveAttribute('data-state', 'ready');
    await expect(V.msgs(page)).toHaveCount(2);
    await expect(V.avatarMsgs(page).first().locator('.instant-tag')).toHaveText('instant · Q3');
  });
});

test.describe('?q=N deep link', () => {
  test('a fresh /?q=2 auto-submits Q2 and removes the parameter (V-E1)', async ({ page }, testInfo) => {
    const faq = faqs().get(2)!;
    const name = testName('DeepFresh');
    await page.addInitScript((n) => { if (!localStorage.getItem('avatar-name')) localStorage.setItem('avatar-name', n); }, name);
    await page.goto('/?q=2&ref=test#top');
    await waitForAvatarReplies(page, 1);
    await expect(V.visitorMsgs(page)).toHaveCount(1);
    await expect(V.visitorMsgs(page).first().locator('.bubble')).toHaveText('Q2');
    await expect(V.avatarMsgs(page).first().locator('.bubble')).toContainText(faq.question);
    const url = new URL(page.url());
    expect(url.searchParams.has('q')).toBe(false);
    expect(url.searchParams.get('ref')).toBe('test');
    expect(url.hash).toBe('#top');
    await expect(V.name(page)).toHaveValue(name);
    await expect(V.composer(page)).toBeFocused();
    await shot(page, testInfo, 'visitor-deeplink-q2');
    // Reloading the cleaned URL does not submit again.
    await page.reload();
    await expect(V.thread(page)).toHaveAttribute('data-state', 'ready');
    await page.waitForTimeout(1500);
    await expect(V.msgs(page)).toHaveCount(2);
  });

  test('/?q=3 with a kept chat restores history first, then answers Q3 (V-E2)', async ({ page, request, context, baseURL }) => {
    const name = testName('DeepKept');
    const cid = await seedConversation(request, { name, messages: ['Q1'] });
    await context.addCookies([{ name: 'avatar_cid', value: cid, url: baseURL! }]);
    await page.goto('/?q=3');
    await waitForAvatarReplies(page, 2);
    const bubbles = await V.msgs(page).evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.role}:${e.querySelector('.bubble')!.textContent!.trim().slice(0, 3)}`));
    expect(bubbles).toEqual(['visitor:Q1', 'avatar:Q1:', 'visitor:Q3', 'avatar:Q3:']);
    expect(await cookieCid(page)).toBe(cid);
    expect(new URL(page.url()).search).toBe('');
    await expect(V.name(page)).toHaveValue(name);
  });

  test('an invalid ?q=abc sends nothing and is still removed (V-E3)', async ({ page }) => {
    const chats: string[] = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/chat')) chats.push(r.url()); });
    await page.goto('/?q=abc');
    await expect(V.thread(page)).toHaveAttribute('data-state', 'ready');
    await expect.poll(() => new URL(page.url()).search).toBe('');
    await page.waitForTimeout(1000);
    expect(chats).toEqual([]);
    await expect(V.intro(page)).toBeVisible();
  });
});
