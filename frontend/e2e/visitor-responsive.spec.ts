/**
 * Responsive visitor layout on desktop Chromium at 360 / 390 / 768 / 1024 /
 * 1440 px: no horizontal overflow (with a thread holding a long unbroken
 * string, links, an instant answer and a human bubble), the composer docked at
 * the bottom of the viewport, screenshots in both themes. (Plan section V-K1..K3.)
 * Short viewports: the intro reads from the top (portrait and headline first). (V-K7.)
 */
import { expect, test } from './support/fixtures';
import { adminApi, chatViaApi, seedConversation } from './support/api';
import { testName } from './support/env';
import { V, horizontalOverflow, offenders, openVisitor, setTheme, shot } from './support/ui';

const WIDTHS = [360, 390, 768, 1024, 1440];

test.describe('visitor responsive layout', () => {
  test.describe.configure({ mode: 'default' });
  let cid = '';

  test.beforeAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    cid = await seedConversation(request, { name: testName('Responsive'), messages: ['Q11'] });
    // A long unbroken token must wrap inside its bubble (one cheap-model reply).
    const long = `TEST layout check https://example.com/${'a'.repeat(160)} ${'Supercalifragilistic'.repeat(6)}`;
    const r = await chatViaApi(request, cid, long, null);
    expect(r.status).toBe(200);
    const admin = await adminApi(baseURL!);
    await admin.postHuman(cid, 'The real me here: happy to chat about **any** of these projects.');
    await admin.dispose();
    await request.dispose();
  });

  for (const width of WIDTHS) {
    test(`${width}px: no horizontal overflow, composer docked (V-K1..K3)`, async ({ page, context, baseURL }, testInfo) => {
      const height = width < 700 ? 800 : 900;
      await page.setViewportSize({ width, height });
      await context.addCookies([{ name: 'avatar_cid', value: cid, url: baseURL! }]);
      await openVisitor(page);
      await expect(V.msgs(page)).toHaveCount(5);
      await expect(V.humanMsgs(page)).toHaveCount(1);

      const overflow = await horizontalOverflow(page);
      expect(overflow, `offenders: ${(await offenders(page)).join('; ')}`).toBeLessThanOrEqual(0);

      // Composer docked: the dock's bottom edge is the viewport's bottom edge; the textarea is on screen.
      const dock = await page.locator('.composer-dock').boundingBox();
      expect(dock).not.toBeNull();
      expect(Math.abs(dock!.y + dock!.height - height)).toBeLessThanOrEqual(1);
      const box = await V.composer(page).boundingBox();
      expect(box!.y).toBeGreaterThan(height / 2);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      // Header fits, owner name visible.
      await expect(page.locator('.brand-sub-name')).toBeVisible();
      // No bubble wider than the thread column.
      const widest = await page.locator('#thread .bubble').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
      expect(widest).toBeLessThanOrEqual(width);

      await shot(page, testInfo, `visitor-width-${width}-dark`);
      if (width === 390 || width === 1440 || width === 768) {
        await setTheme(page, 'light');
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
        await shot(page, testInfo, `visitor-width-${width}-light`);
      }
      // The intro screen at this width.
      await page.locator('#resetChat').click();
      await expect(V.intro(page)).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await shot(page, testInfo, `visitor-width-${width}-intro`);
    });
  }
});

test.describe('visitor intro on short viewports', () => {
  const SIZES: { w: number; h: number; fits: boolean }[] = [
    { w: 390, h: 640, fits: true },   // a phone with Safari's toolbars
    { w: 1280, h: 600, fits: true },  // a common laptop window
    { w: 844, h: 390, fits: false },  // phone landscape: scrolls, from the top
  ];
  for (const { w, h, fits } of SIZES) {
    test(`${w}x${h}: the intro opens at the top, headline and portrait in view (V-K7)`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: w, height: h });
      const atTop = async () => {
        await openVisitor(page);
        await page.evaluate(() => document.fonts?.ready.then(() => undefined));
        await page.waitForTimeout(400); // the ResizeObserver's first callback has run
        expect(await page.locator('#convo').evaluate((c) => c.scrollTop)).toBe(0);
        const convo = (await page.locator('#convo').boundingBox())!;
        const portrait = (await page.locator('#intro .intro-avatar').boundingBox())!;
        const title = (await page.locator('#introTitle').boundingBox())!;
        expect(portrait.y).toBeGreaterThanOrEqual(convo.y);
        expect(title.y).toBeGreaterThanOrEqual(convo.y);
        if (fits) {
          // The example prompts fit above the composer too.
          const dockTop = (await page.locator('.composer-dock').boundingBox())!.y;
          const lastChip = (await page.locator('#intro .chip').last().boundingBox())!;
          expect(lastChip.y + lastChip.height).toBeLessThanOrEqual(dockTop + 1);
        }
      };
      await atTop();
      await shot(page, testInfo, `visitor-intro-short-${w}x${h}`);
      // A kept (still empty) chat after a reload: the same.
      await page.reload();
      await atTop();
    });
  }
});
