/**
 * Visitor page shell: owner identity from config, intro + example prompts,
 * footer links, background texture, fonts, theme toggle + persistence and
 * accessibility basics. (Plan sections V-A, V-B1/B2, V-J.)
 */
import { expect, test } from './support/fixtures';
import { ownerConfig } from './support/env';
import { V, currentTheme, isComposerFocused, openVisitor, setTheme, shot } from './support/ui';

test.describe('visitor shell', () => {
  test('title, meta and brand carry the owner name from config (V-A1..A3)', async ({ page, request }) => {
    const cfg = await ownerConfig(request);
    await openVisitor(page);

    await expect(page).toHaveTitle(`${cfg.owner_name} · Avatar`);
    const description = await page.locator('meta[name="description"]').getAttribute('content');
    expect(description).toContain(cfg.owner_name);
    expect(await page.locator('meta[property="og:title"]').getAttribute('content')).toContain(cfg.owner_name);

    // No unsubstituted placeholders anywhere (text, attributes, title).
    const html = await page.content();
    expect(html).not.toContain('{{');

    await expect(page.locator('.brand-name')).toHaveText('Avatar');
    await expect(page.locator('.brand-sub')).toHaveText(`${cfg.owner_name} · digital twin`);
    await expect(page.locator('#introTitle')).toContainText(`${cfg.owner_first_name}’s digital twin`);
    await expect(V.composer(page)).toHaveAttribute('placeholder', new RegExp(`Message ${cfg.owner_first_name}’s twin`));
  });

  test('no template-author copy and no emoji (V-A4)', async ({ page }) => {
    await openVisitor(page);
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/donner/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(await page.content()).not.toMatch(/youtube/i);
  });

  test('footer social links are exact, open in a new tab, and there is no YouTube (V-A5)', async ({ page }) => {
    await openVisitor(page);
    const links = page.locator('nav.social a');
    await expect(links).toHaveCount(3);
    const expected = [
      ['LinkedIn', 'https://www.linkedin.com/in/sergei-maslennikov-ai'],
      ['GitHub', 'https://github.com/Neuromediator'],
      ['Hugging Face', 'https://huggingface.co/Neuromediator'],
    ];
    for (const [i, [label, href]] of expected.entries()) {
      const a = links.nth(i);
      await expect(a).toHaveText(label!);
      await expect(a).toHaveAttribute('href', href!);
      await expect(a).toHaveAttribute('target', '_blank');
      await expect(a).toHaveAttribute('rel', /noopener/);
      await expect(a.locator('svg use')).toHaveAttribute('href', /#i-(linkedin|github|huggingface)/);
    }
    await expect(page.locator('a[href*="youtube" i]')).toHaveCount(0);
  });

  test('rings background texture, fonts and dark default (V-A6..A8)', async ({ page }) => {
    await openVisitor(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('body')).toHaveClass(/hud-grid/);
    const tex = await page.evaluate(() => {
      const s = getComputedStyle(document.body, '::before');
      return {
        mask: s.maskImage || (s as any).webkitMaskImage || '',
        position: s.position,
        zIndex: s.zIndex,
        maskSize: s.maskSize || (s as any).webkitMaskSize || '',
      };
    });
    expect(tex.mask).toContain('circle');
    expect(tex.position).toBe('fixed');
    expect(tex.zIndex).toBe('-1');
    expect(tex.maskSize).toContain('44px');

    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => ({
      h1: getComputedStyle(document.querySelector('#introTitle')!).fontFamily,
      body: getComputedStyle(document.body).fontFamily,
      loaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
    }));
    expect(fonts.h1).toMatch(/Newsreader/);
    expect(fonts.body).toMatch(/Hanken Grotesk/);
    expect(fonts.loaded.join(',')).toMatch(/Newsreader/);
    expect(fonts.loaded.join(',')).toMatch(/Hanken Grotesk/);
  });

  test('intro with twin avatar and example prompts; composer focused on load (V-B1, V-B2)', async ({ page }, testInfo) => {
    await openVisitor(page);
    await expect(V.intro(page)).toBeVisible();
    const introAvatar = page.locator('#intro .intro-avatar');
    await expect(introAvatar).toBeVisible();
    expect(await introAvatar.evaluate((e) => getComputedStyle(e).backgroundImage)).toContain('avatar-robot-round.png');
    const chips = page.locator('#intro .chip[data-prompt]');
    // ux-flows.md A: editorial hero + 2-3 suggestion chips.
    await expect(chips).toHaveCount(3);
    for (const text of await chips.allInnerTexts()) expect(text.trim().length).toBeGreaterThan(5);
    await expect(V.composer(page)).toBeFocused();
    expect(await isComposerFocused(page)).toBe(true);
    await shot(page, testInfo, 'visitor-intro-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'visitor-intro-light');
  });

  test('theme toggle switches, persists across reload and swaps icons (V-J1, V-J2)', async ({ page }) => {
    await openVisitor(page);
    const toggle = page.locator('#themeToggle');
    expect(await currentTheme(page)).toBe('dark');
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to light theme');
    await expect(toggle.locator('.theme-moon')).toBeVisible();
    await expect(toggle.locator('.theme-sun')).toBeHidden();

    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('avatar-theme'))).toBe('light');
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark theme');
    await expect(toggle.locator('.theme-sun')).toBeVisible();
    await expect(toggle.locator('.theme-moon')).toBeHidden();
    // Desktop: the composer regains focus after a non-send control.
    await expect(V.composer(page)).toBeFocused();

    // Surfaces really change colour.
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('avatar-theme'))).toBe('dark');
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(darkBg).not.toBe(lightBg);

    // The admin page shares the preference.
    await toggle.click();
    await page.goto('/admin');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('dark is the default even when the OS prefers light (V-A8)', async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ baseURL, colorScheme: 'light' });
    const page = await ctx.newPage();
    await openVisitor(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('avatar-theme'))).toBeNull();
    await ctx.close();
  });

  test('accessibility basics: labels, roles, live region (V-A9)', async ({ page }) => {
    await openVisitor(page);
    await expect(page.getByLabel('Your name or initials (optional)')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Keep chat' })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Reset chat' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Switch to (light|dark) theme/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Example questions' })).toBeVisible();
    const composerName = await V.composer(page).evaluate((e) => (e as HTMLTextAreaElement).labels?.[0]?.textContent ?? '');
    expect(composerName).toMatch(/digital twin/);
    await expect(page.locator('#liveRegion')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // Every icon-only button has an accessible name.
    const unnamed = await page.locator('button').evaluateAll((btns) =>
      btns.filter((b) => !(b.getAttribute('aria-label') || b.textContent?.trim() || b.getAttribute('title'))).length);
    expect(unnamed).toBe(0);
  });
});
