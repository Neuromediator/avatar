/**
 * Page helpers shared by the specs: named screenshots, theme switching,
 * visitor-chat and admin-dashboard shortcuts, layout checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { SCREENSHOT_DIR, adminPassword } from './env';

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

/**
 * Save a named screenshot to test/screenshots/frontend/<project>-<name>.png.
 * Waits for web fonts first; CSS animations are frozen at their end state.
 */
export async function shot(page: Page, testInfo: TestInfo, name: string, opts: { fullPage?: boolean; locator?: Locator } = {}): Promise<string> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${testInfo.project.name}-${name}.png`);
  await page.evaluate(() => document.fonts?.ready.then(() => undefined));
  if (opts.locator) await opts.locator.screenshot({ path: file, animations: 'disabled' });
  else await page.screenshot({ path: file, fullPage: opts.fullPage ?? false, animations: 'disabled' });
  return file;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export async function currentTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

/** Switch theme with the real toggle (no-op when already there). */
export async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  if ((await currentTheme(page)) !== theme) await page.locator('#themeToggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

// ---------------------------------------------------------------------------
// Visitor
// ---------------------------------------------------------------------------

export const V = {
  composer: (page: Page) => page.locator('#composerInput'),
  send: (page: Page) => page.locator('#sendBtn'),
  name: (page: Page) => page.locator('#visitorName'),
  keep: (page: Page) => page.locator('#keepChat'),
  reset: (page: Page) => page.locator('#resetChat'),
  intro: (page: Page) => page.locator('#intro'),
  thread: (page: Page) => page.locator('#thread'),
  msgs: (page: Page) => page.locator('#thread > .msg'),
  visitorMsgs: (page: Page) => page.locator('#thread > .msg--visitor'),
  avatarMsgs: (page: Page) => page.locator('#thread > .msg--avatar'),
  humanMsgs: (page: Page) => page.locator('#thread > .msg--human'),
  notices: (page: Page) => page.locator('#thread > .notice'),
};

/** Open the visitor page and wait until the chat controller is ready. */
export async function openVisitor(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await expect(V.thread(page)).toHaveAttribute('data-state', 'ready');
}

/** The conversation id held in the `avatar_cid` cookie (Keep chat on). */
export async function cookieCid(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === 'avatar_cid')?.value ?? null;
}

/** Type into the composer and press Enter. */
export async function sendByEnter(page: Page, text: string): Promise<void> {
  const box = V.composer(page);
  await box.fill(text);
  await box.press('Enter');
}

/** Wait until `n` stored (data-id) avatar replies are shown. */
export async function waitForAvatarReplies(page: Page, n: number, timeout = 20_000): Promise<void> {
  await expect(page.locator('#thread > .msg--avatar[data-id]')).toHaveCount(n, { timeout });
}

export async function isComposerFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.id === 'composerInput');
}

/** Ids of rendered message rows, in DOM order. */
export async function renderedIds(page: Page, scope = '#thread'): Promise<string[]> {
  return page.locator(`${scope} > .msg[data-id]`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id!));
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const A = {
  shell: (page: Page) => page.locator('.admin-shell'),
  gate: (page: Page) => page.locator('main.gate'),
  password: (page: Page) => page.locator('#adminPassword'),
  list: (page: Page) => page.locator('#convoList'),
  rows: (page: Page) => page.locator('#convoList > .convo-item'),
  row: (page: Page, cid: string) => page.locator(`#convoList > .convo-item[data-id="${cid}"]`),
  search: (page: Page) => page.locator('.search-input'),
  chip: (page: Page, filter: 'all' | 'attention' | 'unread') => page.locator(`.filter-chip[data-filter="${filter}"]`),
  main: (page: Page) => page.locator('section.main'),
  threadName: (page: Page) => page.locator('#threadName'),
  threadSub: (page: Page) => page.locator('.thread-head .sub'),
  threadMsgs: (page: Page) => page.locator('.thread-inner > .msg'),
  composer: (page: Page) => page.locator('.admin-composer-dock textarea'),
  flag: (page: Page) => page.locator('.attn-flag'),
  resolve: (page: Page) => page.locator('.resolve-btn'),
  back: (page: Page) => page.locator('.back-btn'),
};

/** Sign in through the API (the session cookie lands in the page's context), then open /admin. */
export async function loginAdmin(page: Page): Promise<void> {
  const res = await page.request.post('/admin/login', { data: { password: adminPassword() } });
  expect(res.status(), 'admin login').toBe(200);
  await page.goto('/admin');
  await expect(A.shell(page)).toBeVisible();
  await expect(A.rows(page).first()).toBeVisible();
}

/** Open a conversation from the inbox (narrowing with search so it is on screen). */
export async function openThread(page: Page, cid: string, search?: string): Promise<void> {
  if (search !== undefined) await A.search(page).fill(search);
  const row = A.row(page, cid);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(row).toHaveClass(/is-active/);
  await expect(A.main(page)).not.toHaveClass(/is-loading/);
  await expect(A.threadMsgs(page).first()).toBeVisible();
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Horizontal overflow of the document (0 when none). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(d.scrollWidth, document.body.scrollWidth) - d.clientWidth;
  });
}

/** Elements whose right edge is outside the viewport (for diagnosing overflow). */
export async function offenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const out: string[] = [];
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > w + 1 && getComputedStyle(el).position !== 'fixed') {
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} right=${Math.round(r.right)}`);
      }
    });
    return out.slice(0, 10);
  });
}

// ---------------------------------------------------------------------------
// Identity images and copy
// ---------------------------------------------------------------------------

/**
 * A message token's picture: its computed background-image names `fragment`
 * (e.g. "avatar-robot", "avatar-human.png") and that image is served as a PNG.
 */
export async function expectTokenImage(page: Page, token: Locator, fragment: string): Promise<void> {
  const bg = await token.evaluate((e) => getComputedStyle(e).backgroundImage);
  expect(bg).toContain(fragment);
  const url = /url\("?([^")]+)"?\)/.exec(bg)?.[1];
  expect(url, `image url in ${bg}`).toBeTruthy();
  const res = await page.request.get(url!);
  expect(res.status(), url).toBe(200);
  expect(res.headers()['content-type']).toContain('image/png');
}

/** No emoji code points in the page's visible text (SPEC UI: "strictly no emojis"). */
export async function expectNoEmoji(page: Page): Promise<void> {
  const text = await page.locator('body').innerText();
  const found = text.match(/\p{Extended_Pictographic}/gu);
  expect(found, `emoji in visible text: ${found?.join(' ')}`).toBeNull();
}
