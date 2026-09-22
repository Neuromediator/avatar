/**
 * Persistence across a container restart (test/e2e_test_plan.md, section RS).
 * Uses what three-way.e2e.spec.ts saved: the same browsers (cookies +
 * localStorage) come back after `scripts/stop_mac.sh` + `scripts/start_mac.sh`
 * and find their kept chats restored from Supabase; the owner's signed session
 * cookie still works (SESSION_SECRET is unchanged) and the inbox state is intact;
 * a restored conversation carries on under the same conversation id.
 *
 * Skipped unless AVATAR_AFTER_RESTART=1 (it only makes sense right after a restart):
 *   ./scripts/stop_mac.sh && MODEL_OVERRIDE=openai/gpt-5.4-nano ./scripts/start_mac.sh
 *   cd frontend && AVATAR_AFTER_RESTART=1 BASE_URL=http://localhost:8000 SCREENSHOT_DIR=../test/screenshots/e2e \
 *     npx playwright test --project=three-way restart
 */
import fs from 'node:fs';
import { devices } from '@playwright/test';
import { expect, test, watchPage } from './support/fixtures';
import { ownerConfig } from './support/env';
import { dbRows } from './support/supabase';
import { A, V, cookieCid, openVisitor, sendByEnter, shot, waitForAvatarReplies } from './support/ui';
import { THREE_WAY_STATE_FILE, type ThreeWayState } from './support/three-way-state';

test.describe.configure({ timeout: 180_000 });

test.skip(!process.env.AVATAR_AFTER_RESTART, 'runs only right after a container restart (AVATAR_AFTER_RESTART=1)');

const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
// Desktop Chrome UA: Google Fonts' Android font files render with broken spacing in headless Linux Chromium.
const phone = { ...devices['Pixel 7'], userAgent: devices['Desktop Chrome'].userAgent, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

test('after a container restart: kept chats come back from Supabase, the admin session and inbox are intact (RS-1..RS-3)', async ({ browser, request, baseURL }, testInfo) => {
  expect(fs.existsSync(THREE_WAY_STATE_FILE), 'run three-way.e2e.spec.ts first').toBe(true);
  const state = JSON.parse(fs.readFileSync(THREE_WAY_STATE_FILE, 'utf8')) as ThreeWayState;
  const cfg = await ownerConfig(request);
  const cid = state.conversation_ids;
  const problems: string[] = [];
  const evidence: Record<string, any> = { conversation_ids: cid, three_way_saved_at: state.saved_at };

  const open = async (storage: ThreeWayState['storage']['alice'], opts: object, label: string) => {
    const ctx = await browser.newContext({ baseURL, storageState: storage, ...opts });
    const page = await ctx.newPage();
    watchPage(page, problems, label);
    return { ctx, page };
  };
  const alice = await open(state.storage.alice, desktop, '[alice]');
  const bob = await open(state.storage.bob, phone, '[bob]');
  const chen = await open(state.storage.chen, desktop, '[chen]');
  const admin = await open(state.storage.admin, desktop, '[admin]');

  try {
    await test.step('RS-1 each visitor\'s kept chat is restored under the same conversation id', async () => {
      for (const [who, v] of [['alice', alice], ['bob', bob], ['chen', chen]] as const) {
        await openVisitor(v.page);
        expect(await cookieCid(v.page), `${who} kept the same conversation id`).toBe(cid[who]);
        const rows = await dbRows(cid[who]);
        expect(rows.length, `${who}: nothing lost or added by the restart`).toBe(state.row_counts[who]);
        await expect(V.msgs(v.page)).toHaveCount(rows.length);
        const roles = await V.msgs(v.page).evaluateAll((els) => els.map((e) => e.className.match(/msg--(visitor|avatar|human)/)?.[1]));
        expect(roles).toEqual(rows.map((r) => r.role));
        await expect(V.name(v.page)).toHaveValue(state.names[who]);
        await expect(V.intro(v.page)).toBeHidden();
      }
      await expect(V.humanMsgs(alice.page).locator('.human-tag')).toHaveText(`${cfg.owner_name} · live`);
      await expect(V.humanMsgs(alice.page).locator('.bubble')).toContainText(state.human_to_alice);
      await expect(V.humanMsgs(chen.page).locator('.bubble')).toContainText(state.human_to_chen);
      await expect(V.humanMsgs(bob.page)).toHaveCount(0);
      await expect(alice.page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(bob.page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect(chen.page.locator('html')).toHaveAttribute('data-theme', 'light');
      await shot(alice.page, testInfo, 'r1-alice-restored-dark');
      await shot(bob.page, testInfo, 'r2-bob-restored-phone-light');
      await shot(chen.page, testInfo, 'r3-chen-restored-light');
    });

    await test.step('RS-2 the owner\'s session cookie survives the restart; inbox state is intact', async () => {
      await admin.page.goto('/admin');
      await expect(A.shell(admin.page)).toBeVisible();
      await expect(A.gate(admin.page)).toHaveCount(0);
      for (const who of ['alice', 'bob', 'chen'] as const) await expect(A.row(admin.page, cid[who])).toBeVisible();
      await expect(A.row(admin.page, cid.chen)).not.toHaveClass(/is-attention|is-unread/);
      await expect(A.row(admin.page, cid.alice)).not.toHaveClass(/is-attention/);
      await expect(A.row(admin.page, cid.bob)).toHaveClass(/is-unread/);
      const [a, b, c] = await Promise.all([dbRows(cid.alice), dbRows(cid.bob), dbRows(cid.chen)]);
      expect(c.every((r) => r.read && !r.needs_attention)).toBe(true);
      expect(b.every((r) => !r.read && !r.needs_attention)).toBe(true);
      expect(a.some((r) => r.needs_attention)).toBe(false);
      evidence.alice_unread_after_restart = a.filter((r) => !r.read).length;
      await shot(admin.page, testInfo, 'r4-admin-inbox-after-restart-dark');
    });

    await test.step('RS-3 a restored conversation carries on (Q3 instant answer, same id)', async () => {
      await sendByEnter(alice.page, 'Q3');
      await waitForAvatarReplies(alice.page, 2);
      await expect(V.avatarMsgs(alice.page).last().locator('.instant-tag')).toHaveText('instant · Q3');
      const rows = await dbRows(cid.alice);
      expect(rows.length).toBe(state.row_counts.alice + 2);
      expect(rows.slice(-2).map((r) => r.role)).toEqual(['visitor', 'avatar']);
      await expect(A.row(admin.page, cid.alice)).toHaveClass(/is-unread/, { timeout: 15_000 });
      await shot(alice.page, testInfo, 'r5-alice-continues-after-restart-dark');
    });

    testInfo.annotations.push({ type: 'restart-evidence', description: JSON.stringify(evidence) });
    console.log(`[restart evidence] ${JSON.stringify(evidence)}`);
    expect(problems, 'no page errors or console errors').toEqual([]);
  } finally {
    for (const c of [alice, bob, chen, admin]) await c.ctx.close();
  }
});
