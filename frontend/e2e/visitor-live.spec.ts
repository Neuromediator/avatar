/**
 * Human in the loop and polling: the owner's message (posted through the real
 * admin API) reaches the visitor within ~10-12 s as the designed human bubble;
 * no duplicates after stream + poll; the poll cadence (10 s, easing to 60 s
 * after 5 quiet minutes, back to 10 s on activity: a visitor send or an owner
 * message picked up by a poll) measured on a fake clock.
 * (Plan section V-G.)
 */
import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { adminApi, seedConversation } from './support/api';
import { ownerConfig, testName } from './support/env';
import { V, cookieCid, expectTokenImage, openVisitor, renderedIds, sendByEnter, setTheme, shot, waitForAvatarReplies } from './support/ui';

test.describe('owner joins the conversation', () => {
  test('the owner message appears as the human bubble within ~12 s; no Avatar reaction; no duplicates (V-G1..G5)', async ({ page, request, baseURL }, testInfo) => {
    const cfg = await ownerConfig(request);
    const admin = await adminApi(baseURL!);
    try {
      await openVisitor(page);
      await V.name(page).fill(testName('Human'));
      await sendByEnter(page, 'Q10');
      await waitForAvatarReplies(page, 1);
      const cid = (await cookieCid(page))!;

      const posted = await admin.postHuman(cid, 'Hi, this is the real me. See [my GitHub](https://github.com/Neuromediator) for the code.');
      const t0 = Date.now();
      const human = V.humanMsgs(page);
      await expect(human).toHaveCount(1, { timeout: 13_000 });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(12_500);
      testInfo.annotations.push({ type: 'human-latency-ms', description: String(elapsed) });

      const msg = human.first();
      await expect(msg).toHaveAttribute('data-id', String(posted.id));
      await expect(msg.locator('.human-tag')).toHaveText(`${cfg.owner_name} · live`);
      await expect(msg.locator('.human-tag svg use')).toHaveAttribute('href', '#i-live');
      // Photo + yellow ring + spark badge.
      const avatar = msg.locator('.avatar.avatar-human');
      expect(await avatar.evaluate((e) => getComputedStyle(e).backgroundImage)).toContain('avatar-human.png');
      await expect(avatar.locator('.spark-badge')).toBeVisible();
      const style = await msg.evaluate((m) => {
        const root = getComputedStyle(document.documentElement);
        const probe = document.createElement('span');
        probe.style.color = root.getPropertyValue('--yellow-strong').trim();
        document.body.appendChild(probe);
        const yellow = getComputedStyle(probe).color;
        probe.remove();
        const av = getComputedStyle(m.querySelector('.avatar-human')!);
        const bubble = getComputedStyle(m.querySelector('.bubble')!);
        return {
          yellow,
          ring: av.borderTopColor,
          ringWidth: av.borderTopWidth,
          halo: av.boxShadow,
          tint: bubble.backgroundImage,
          glow: bubble.boxShadow,
          border: bubble.borderTopColor,
        };
      });
      expect(style.ring).toBe(style.yellow);
      expect(style.ringWidth).toBe('2px');
      expect(style.halo).not.toBe('none');
      expect(style.tint).toContain('gradient');
      expect(style.glow).not.toBe('none');
      // Markdown link opens in a new tab.
      const link = msg.locator('.bubble a');
      await expect(link).toHaveAttribute('href', 'https://github.com/Neuromediator');
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(page.locator('#liveRegion')).toContainText(`${cfg.owner_name} joined the conversation`);
      await shot(page, testInfo, 'visitor-human-bubble-dark');
      await shot(page, testInfo, 'visitor-human-bubble-closeup', { locator: msg });
      await setTheme(page, 'light');
      await shot(page, testInfo, 'visitor-human-bubble-light');

      // The next poll brings nothing new: no duplicate bubbles, no Avatar reaction.
      await page.waitForResponse((r) => r.url().includes(`/api/conversations/${cid}?after_id=`), { timeout: 13_000 });
      const ids = await renderedIds(page);
      expect(new Set(ids).size).toBe(ids.length);
      await expect(V.msgs(page)).toHaveCount(3);
      const stored = await (await request.get(`/api/conversations/${cid}`)).json();
      expect(stored.messages.map((m: any) => m.role)).toEqual(['visitor', 'avatar', 'human']);
    } finally {
      await admin.dispose();
    }
  });

  test('reading older messages: a new owner message shows the "Latest" pill instead of yanking the view (V-G9)', async ({ page, request, context, baseURL }, testInfo) => {
    const cid = await seedConversation(request, { name: testName('Latest'), messages: ['Q11', 'Q12', 'Q13', 'Q14', 'Q6'] });
    await context.addCookies([{ name: 'avatar_cid', value: cid, url: baseURL! }]);
    await openVisitor(page);
    await expect(V.msgs(page)).toHaveCount(10);
    // Replies restored from history carry the robotic twin token (SPEC UI).
    await expectTokenImage(page, V.avatarMsgs(page).first().locator('.avatar.avatar-twin'), 'avatar-robot');
    const convo = page.locator('#convo');
    await convo.evaluate((s) => { s.scrollTop = 0; });
    await expect(page.locator('#jumpLatest')).toBeHidden();

    const admin = await adminApi(baseURL!);
    await admin.postHuman(cid, 'Just checking in - the real me.');
    await admin.dispose();
    const pill = page.locator('#jumpLatest');
    await expect(pill).toBeVisible({ timeout: 13_000 });
    await expect(V.humanMsgs(page)).toHaveCount(1);
    await expect(V.humanMsgs(page)).not.toBeInViewport();
    expect(await convo.evaluate((s) => s.scrollTop)).toBeLessThan(50);
    await shot(page, testInfo, 'visitor-latest-pill');
    await pill.click();
    await expect(pill).toBeHidden();
    await expect(V.humanMsgs(page)).toBeInViewport();
    await expect(V.composer(page)).toBeFocused();
  });

  test('a failed history load shows a notice and recovers on the next poll (V-G10)', async ({ page, request, context, baseURL }, testInfo) => {
    const cid = await seedConversation(request, { name: testName('HistoryFail'), messages: ['Q1'] });
    await context.addCookies([{ name: 'avatar_cid', value: cid, url: baseURL! }]);
    let failed = 0;
    await page.route(`**/api/conversations/${cid}`, async (route) => {
      if (failed === 0) {
        failed += 1;
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"unavailable"}' });
      } else {
        await route.fallback();
      }
    });
    await openVisitor(page);
    const notice = page.locator('#thread > .notice[data-notice="history"]');
    await expect(notice).toContainText("Couldn't load your earlier messages");
    // A neutral system icon: i-live is reserved for the human bubble.
    await expect(notice.locator('use').first()).toHaveAttribute('href', '#i-alert');
    await shot(page, testInfo, 'visitor-history-failed');
    await expect(V.msgs(page)).toHaveCount(2, { timeout: 13_000 });
    await expect(notice).toHaveCount(0);
    await expect(V.intro(page)).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Poll cadence on a fake clock
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __polls: { times: number[]; pending: number };
  }
}

/** Count the visitor's poll fetches (GET /api/conversations/<id>?after_id=...) at their (fake) time. */
async function instrumentPolls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.__polls = { times: [], pending: 0 };
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!/\/api\/conversations\/[^?]+\?after_id=/.test(url)) return real(input, init);
      window.__polls.times.push(Date.now());
      window.__polls.pending += 1;
      try {
        const res = await real(input, init);
        const text = await res.text();
        return new Response(text, { status: res.status, headers: res.headers });
      } finally {
        window.__polls.pending -= 1;
      }
    };
  });
}

/** Advance the fake clock second by second, letting each poll finish before moving on. */
async function advance(page: Page, seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    await page.clock.runFor(1000);
    await expect.poll(() => page.evaluate(() => window.__polls.pending), { timeout: 10_000, intervals: [20, 50, 100] }).toBe(0);
    // Let the poll's response handling run and re-arm its timer.
    for (let k = 0; k < 3; k++) await page.evaluate(() => Promise.resolve());
  }
}

async function pollTimes(page: Page): Promise<number[]> {
  return page.evaluate(() => window.__polls.times);
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((t, i) => Math.round((t - times[i]!) / 1000));
}

test.describe('poll cadence (fake clock)', () => {
  test('a fresh, unsent chat does not poll (V-G8)', async ({ page }) => {
    await instrumentPolls(page);
    await page.clock.install();
    await openVisitor(page);
    await advance(page, 35);
    expect(await pollTimes(page)).toEqual([]);
  });

  test('polls every 10 s, eases to 60 s after 5 quiet minutes, back to 10 s after a send or an owner message (V-G6, V-G7, V-G11)', async ({ page, request, context, baseURL }, testInfo) => {
    test.setTimeout(300_000);
    const cid = await seedConversation(request, { name: testName('Cadence'), messages: ['Q1'] });
    await context.addCookies([{ name: 'avatar_cid', value: cid, url: baseURL! }]);
    await instrumentPolls(page);
    await page.clock.install();
    await openVisitor(page);
    await expect(V.msgs(page)).toHaveCount(2);

    // First minute: every 10 s.
    await advance(page, 61);
    let times = await pollTimes(page);
    expect(times.length).toBeGreaterThanOrEqual(5);
    expect(times.length).toBeLessThanOrEqual(7);
    for (const g of gaps(times)) {
      expect(g).toBeGreaterThanOrEqual(10);
      expect(g).toBeLessThanOrEqual(11);
    }

    // Past five quiet minutes: every 60 s.
    await advance(page, 5 * 60 + 130 - 61);
    times = await pollTimes(page);
    const all = gaps(times);
    testInfo.annotations.push({ type: 'poll-gaps-s', description: all.join(',') });
    const slow = all.filter((g) => g >= 55);
    expect(slow.length).toBeGreaterThanOrEqual(2);
    for (const g of slow) {
      expect(g).toBeGreaterThanOrEqual(60);
      expect(g).toBeLessThanOrEqual(61);
    }
    // Every fast gap came before the first slow one, and the switch happened at ~5 min.
    const firstSlow = all.findIndex((g) => g >= 55);
    expect(all.slice(firstSlow).every((g) => g >= 55)).toBe(true);
    const switchAt = (times[firstSlow]! - times[0]!) / 1000;
    expect(switchAt).toBeGreaterThanOrEqual(270);
    expect(switchAt).toBeLessThanOrEqual(310);

    // A send is activity: the next poll comes 10 s later, not 60.
    await sendByEnter(page, 'Q2');
    await waitForAvatarReplies(page, 2);
    const before = (await pollTimes(page)).length;
    const sentAt = await page.evaluate(() => Date.now());
    await advance(page, 12);
    const after = await pollTimes(page);
    expect(after.length).toBe(before + 1);
    const delay = Math.round((after[after.length - 1]! - sentAt) / 1000);
    expect(delay).toBeGreaterThanOrEqual(9);
    expect(delay).toBeLessThanOrEqual(11);

    // V-G11: a message arriving by poll (the owner joining) is activity too.
    // Quiet again until the cadence is back at 60 s...
    await advance(page, 5 * 60 + 130);
    times = await pollTimes(page);
    const quietAgain = gaps(times).slice(-2);
    testInfo.annotations.push({ type: 'poll-gaps-before-owner-s', description: quietAgain.join(',') });
    for (const g of quietAgain) {
      expect(g).toBeGreaterThanOrEqual(60);
      expect(g).toBeLessThanOrEqual(61);
    }
    // ...then the owner replies from admin; the next (slow) poll picks it up.
    const admin = await adminApi(baseURL!);
    try {
      await admin.postHuman(cid, 'TEST owner reply while the visitor page polls slowly.');
    } finally {
      await admin.dispose();
    }
    const beforeOwner = times.length;
    for (let i = 0; i < 62 && (await pollTimes(page)).length === beforeOwner; i++) await advance(page, 1);
    const pickup = await pollTimes(page);
    expect(pickup.length).toBe(beforeOwner + 1);
    const pickupGap = Math.round((pickup[beforeOwner]! - pickup[beforeOwner - 1]!) / 1000);
    // Picked up by the scheduled slow tick (nothing polls early for the owner).
    expect(pickupGap).toBeGreaterThanOrEqual(60);
    expect(pickupGap).toBeLessThanOrEqual(61);
    await expect(V.humanMsgs(page)).toHaveCount(1);
    await expect(V.humanMsgs(page).first().locator('.bubble')).toContainText('TEST owner reply');
    // The follow-up polls are 10 s apart again, not 60.
    await advance(page, 32);
    const followUp = gaps((await pollTimes(page)).slice(beforeOwner));
    testInfo.annotations.push({ type: 'poll-gaps-after-owner-s', description: followUp.join(',') });
    expect(followUp.length).toBeGreaterThanOrEqual(3);
    for (const g of followUp) {
      expect(g).toBeGreaterThanOrEqual(10);
      expect(g).toBeLessThanOrEqual(11);
    }
  });
});
