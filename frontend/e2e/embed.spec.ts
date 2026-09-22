/**
 * The optional WordPress embed (scripts/wordpress-embed.html, SPEC "Tech stack
 * decisions"): pasted into a host page with its BASE constant pointed at the
 * server under test, the snippet forwards the host page's ?q=N into the
 * iframe, where the visitor page answers that FAQ on arrival. Only a number is
 * forwarded. The host page is served by the test itself (page.route), so no
 * WordPress is needed. (Plan: e2e_test_plan.md, section D.)
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test as base } from '@playwright/test';
import { watchPage } from './support/fixtures';
import { REPO_DIR } from './support/env';
import { horizontalOverflow, shot } from './support/ui';

const SNIPPET = path.join(REPO_DIR, 'scripts', 'wordpress-embed.html');
const BASE_LINE = /var BASE = "[^"]+";/;

/**
 * A stand-in host site on 127.0.0.1 (a different site from the app on
 * localhost, so the frame is cross-site as on a real WordPress domain). It is a
 * real loopback server rather than a routed fake: Chromium's local-network
 * checks refuse a localhost frame inside a page it cannot place on the network.
 */
function hostPage(base: string): string {
  const snippet = fs.readFileSync(SNIPPET, 'utf8');
  expect(snippet).toMatch(BASE_LINE);
  const html = snippet.replace(BASE_LINE, `var BASE = ${JSON.stringify(`${base}/`)};`);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Host site</title><style>body{margin:0;font-family:sans-serif}header{height:80px;display:flex;align-items:center;padding:0 24px;background:#fff;color:#111;border-bottom:1px solid #ddd}'
    + '.entry-content > *{max-width:640px;margin:0 auto}</style></head><body>'
    + `<header>Host site navigation</header><main class="entry-content">${html}</main><footer>Host footer</footer></body></html>`;
}

/**
 * The suite's console/page-error guard, minus one message Chromium logs for any
 * cross-origin frame whose page has an `autofocus` field: it refuses to autofocus
 * there (a browser policy for embedded pages). The chat itself works (D-E1).
 */
const CROSS_ORIGIN_AUTOFOCUS = /^console\.error: Blocked autofocusing on a <textarea> element in a cross-origin subframe\.$/;
const test = base.extend<{ embedGuard: void }>({
  embedGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      watchPage(page, problems);
      await use();
      expect(problems.filter((p) => !CROSS_ORIGIN_AUTOFOCUS.test(p)), 'no uncaught page errors or console errors').toEqual([]);
    },
    { auto: true },
  ],
});

let server: http.Server;
let HOST = '';

test.beforeAll(async ({ baseURL }) => {
  const body = hostPage(baseURL!);
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  HOST = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.describe('WordPress embed snippet', () => {
  test('host page ?q=2 is forwarded into the iframe, which answers Q2 on arrival (D-E1)', async ({ page, baseURL }, testInfo) => {
    await page.goto(`${HOST}/avatar?q=2`);
    const frameEl = page.locator('#avatar-frame');
    // BASE's trailing slash is normalised; only q is forwarded.
    await expect(frameEl).toHaveAttribute('src', `${baseURL}/?q=2`);
    const frame = page.frameLocator('#avatar-frame');
    const reply = frame.locator('#thread > .msg--avatar[data-id]');
    await expect(reply).toHaveCount(1, { timeout: 20_000 });
    await expect(reply.locator('.instant-tag')).toHaveText('instant · Q2');
    await expect(reply.locator('.bubble')).toContainText('Q2:');
    await expect(frame.locator('#thread > .msg--visitor .bubble')).toHaveText('Q2');
    // The visitor page clears ?q from its own URL (a reload inside the frame does not re-ask).
    await expect.poll(() => page.frames().find((f) => f.url().startsWith(baseURL!))?.url()).toBe(`${baseURL}/`);
    // Full-bleed below the nav, no sideways scrolling on the host page.
    const vp = page.viewportSize()!;
    const box = (await frameEl.boundingBox())!;
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(vp.width);
    expect(Math.round(box.y)).toBe(80);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'embed-wordpress-q2');
  });

  test('anything but a number in ?q is not forwarded (D-E2)', async ({ page, baseURL }) => {
    await page.goto(`${HOST}/avatar?q=${encodeURIComponent('2"><script>alert(1)</script>')}`);
    await expect(page.locator('#avatar-frame')).toHaveAttribute('src', `${baseURL}/`);
    const frame = page.frameLocator('#avatar-frame');
    await expect(frame.locator('#intro')).toBeVisible();
    await expect(frame.locator('#thread > .msg')).toHaveCount(0);
  });
});
