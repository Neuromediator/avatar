/**
 * Real Avatar replies from the cheap model (openai/gpt-5.4-nano via OpenRouter):
 * an example chip streams a reply (states observed live, tool rows settle to
 * done, composer focused after completion), and a free-form question is
 * answered from the owner's knowledge and persisted. (Plan section V-I.)
 */
import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { ownerConfig, testName } from './support/env';
import { V, cookieCid, isComposerFocused, openVisitor, sendByEnter, setTheme, shot, waitForAvatarReplies } from './support/ui';

test.describe.configure({ timeout: 150_000 });

/** Record every data-state the streaming avatar bubble goes through. */
async function recordStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as any).__states = seen;
    new MutationObserver((records) => {
      for (const r of records) {
        const t = r.target as HTMLElement;
        if (r.attributeName === 'data-state' && t.classList?.contains('msg--avatar')) {
          const s = t.dataset.state!;
          if (seen[seen.length - 1] !== s) seen.push(s);
        }
      }
    }).observe(document.getElementById('thread')!, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
  });
}

test.describe('real Avatar replies (nano)', () => {
  test('an example chip streams a real reply; composer focused after completion (V-I1, V-B8)', async ({ page }, testInfo) => {
    await openVisitor(page);
    await V.name(page).fill(testName('LLMChip'));
    await recordStates(page);
    const chip = page.locator('#intro .chip[data-prompt]', { hasText: 'projects' });
    await chip.click();
    const reply = V.avatarMsgs(page).last();
    await expect(reply).toBeVisible();
    await shot(page, testInfo, 'visitor-llm-in-flight');
    await expect(reply).toHaveAttribute('data-state', 'complete', { timeout: 120_000 });
    const states: string[] = await page.evaluate(() => (window as any).__states);
    testInfo.annotations.push({ type: 'stream-states', description: states.join(' -> ') });
    expect(states).toContain('complete');
    expect(states.indexOf('typing')).toBeGreaterThanOrEqual(0);
    expect(states.indexOf('typing')).toBeLessThan(states.indexOf('complete'));
    await expect(reply).toHaveAttribute('data-id', /\d+/);
    expect((await reply.locator('.bubble').innerText()).trim().length).toBeGreaterThan(40);
    // Tool rows (when the model used tools) all settle to the done state.
    const tools = reply.locator('.tool-status');
    const toolCount = await tools.count();
    testInfo.annotations.push({ type: 'tool-rows', description: String(toolCount) });
    if (toolCount) await expect(reply.locator('.tool-status:not(.is-done)')).toHaveCount(0);
    await expect.poll(() => isComposerFocused(page)).toBe(true);
    await expect(page.locator('#thread .notice')).toHaveCount(0);
    await shot(page, testInfo, 'visitor-llm-chip-reply-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'visitor-llm-chip-reply-light');
  });

  test('a free-form question is answered from the knowledge and kept after reload (V-I2)', async ({ page, request }, testInfo) => {
    const cfg = await ownerConfig(request);
    await openVisitor(page);
    await V.name(page).fill(testName('LLMFree'));
    await sendByEnter(page, `Which city does ${cfg.owner_first_name} live in now?`);
    await waitForAvatarReplies(page, 1, 120_000);
    const reply = V.avatarMsgs(page).last();
    await expect(reply.locator('.bubble')).toContainText(/Tallinn/i);
    await expect(V.composer(page)).toBeFocused();
    const cid = await cookieCid(page);
    await page.reload();
    await expect(V.msgs(page)).toHaveCount(2);
    expect(await cookieCid(page)).toBe(cid);
    await expect(V.avatarMsgs(page).last().locator('.bubble')).toContainText(/Tallinn/i);
    await shot(page, testInfo, 'visitor-llm-freeform');
  });
});
