/**
 * Sending and the streamed reply, driven by a controllable /api/chat stand-in
 * so every state is deterministic: chips submit immediately, Enter / Shift+Enter
 * / click-to-send, focus rules, optimistic bubbles and initials, the five
 * stream states, tool rows, Markdown + links, sanitising, error and dropped
 * streams. (Plan sections V-B3..B10, V-C.)
 */
import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { ownerConfig } from './support/env';
import { ackStart, chatRequests, dropStream, installChatMock, push, row, waitForChatRequests } from './support/chat-mock';
import { V, expectTokenImage, isComposerFocused, openVisitor, sendByEnter, setTheme, shot } from './support/ui';

/** Finish the latest mocked reply with `content` (and optional tool calls). */
async function finish(page: Page, content: string, toolCalls: unknown[] | null = null) {
  const done = row('avatar', content, toolCalls);
  await push(page, 'delta', { text: content });
  await push(page, 'done', { message: done });
  return done;
}

test.describe('visitor sending (mocked stream)', () => {
  test.beforeEach(async ({ page }) => {
    await installChatMock(page);
  });

  test('clicking an example chip submits it immediately (V-B3)', async ({ page }) => {
    await openVisitor(page);
    const chip = page.locator('#intro .chip[data-prompt]').first();
    const text = (await chip.innerText()).trim();
    await chip.click();
    await waitForChatRequests(page, 1);
    const [req] = await chatRequests(page);
    expect(req!.message).toBe(text);
    expect(req!.conversation_id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(V.intro(page)).toBeHidden();
    await expect(V.visitorMsgs(page)).toHaveCount(1);
    await expect(V.visitorMsgs(page).first().locator('.bubble')).toHaveText(text);
    await expect(V.composer(page)).toBeFocused();
    await ackStart(page);
    await finish(page, 'Mocked reply.');
    await expect(page.locator('#thread > .msg--avatar[data-state="complete"]')).toHaveCount(1);
  });

  test('Enter sends, clears and refocuses; empty Enter does nothing (V-B4, V-B7)', async ({ page }) => {
    await openVisitor(page);
    await V.composer(page).press('Enter');
    await V.composer(page).fill('   ');
    await V.composer(page).press('Enter');
    expect((await chatRequests(page)).length).toBe(0);
    await expect(V.msgs(page)).toHaveCount(0);

    await sendByEnter(page, 'Hello from Enter');
    await waitForChatRequests(page, 1);
    await expect(V.composer(page)).toHaveValue('');
    await expect(V.composer(page)).toBeFocused();
    await ackStart(page);
    await finish(page, 'Hi!');
    await expect(V.composer(page)).toBeFocused();
  });

  test('clicking the send button sends and keeps focus (V-B5)', async ({ page }) => {
    await openVisitor(page);
    await V.composer(page).fill('Hello from the button');
    await V.send(page).click();
    await waitForChatRequests(page, 1);
    expect((await chatRequests(page))[0]!.message).toBe('Hello from the button');
    await expect(V.composer(page)).toHaveValue('');
    await expect(V.composer(page)).toBeFocused();
  });

  test('Shift+Enter inserts a newline; the message keeps its line break (V-B6, V-B10)', async ({ page }) => {
    await openVisitor(page);
    const box = V.composer(page);
    const h0 = await box.evaluate((e) => (e as HTMLElement).offsetHeight);
    await box.type('first line');
    await box.press('Shift+Enter');
    await box.type('second line');
    await expect(box).toHaveValue('first line\nsecond line');
    expect((await chatRequests(page)).length).toBe(0);

    // Auto-grow: many lines grow the box up to its max height (160px), then it scrolls.
    const h1 = await box.evaluate((e) => e.getBoundingClientRect().height);
    for (let i = 0; i < 3; i++) await box.press('Shift+Enter');
    const h2 = await box.evaluate((e) => e.getBoundingClientRect().height);
    expect(h2).toBeGreaterThan(h1);
    for (let i = 0; i < 12; i++) await box.press('Shift+Enter');
    const h3 = await box.evaluate((e) => e.getBoundingClientRect().height);
    expect(h3).toBeLessThanOrEqual(161);

    await box.fill('first line\nsecond line');
    await box.press('Enter');
    await waitForChatRequests(page, 1);
    expect((await chatRequests(page))[0]!.message).toBe('first line\nsecond line');
    await expect(V.visitorMsgs(page).first().locator('.bubble br')).toHaveCount(1);
    // After sending, the composer shrinks back to one row.
    await expect(box).toHaveJSProperty('offsetHeight', h0);
  });

  test('optimistic bubble shows initials from the name field; renaming updates it (V-C1, V-C3)', async ({ page }, testInfo) => {
    await openVisitor(page);
    await V.name(page).fill('TEST Visitor');
    await sendByEnter(page, 'Who are you?');
    await waitForChatRequests(page, 1);
    const bubble = V.visitorMsgs(page).first();
    await expect(bubble).toHaveAttribute('data-pending', '');
    await expect(bubble.locator('.avatar-initials')).toHaveText('TV');
    expect((await chatRequests(page))[0]!.name).toBe('TEST Visitor');
    const visitor = await ackStart(page);
    await expect(bubble).toHaveAttribute('data-id', String(visitor.id));
    await expect(bubble).not.toHaveAttribute('data-pending', '');
    await V.name(page).fill('TEST Quinn Zed');
    await expect(bubble.locator('.avatar-initials')).toHaveText('TZ');
    await finish(page, 'I am the twin.');
    await shot(page, testInfo, 'visitor-named-initials');
  });

  test('unnamed visitor gets the icon token (V-C2)', async ({ page }) => {
    await openVisitor(page);
    await V.name(page).fill('');
    await sendByEnter(page, 'Anonymous hello');
    await waitForChatRequests(page, 1);
    const token = V.visitorMsgs(page).first().locator('.avatar-initials');
    await expect(token).toHaveAttribute('data-anonymous', '');
    await expect(token.locator('svg use')).toHaveAttribute('href', '#i-visitor');
    expect((await chatRequests(page))[0]!.name).toBeNull();
  });

  test('stream states: thinking -> tool-calling -> tool-returned -> typing -> complete (V-C4..C8, V-B8, V-B9)', async ({ page, request }, testInfo) => {
    const cfg = await ownerConfig(request);
    await openVisitor(page);
    await V.name(page).fill('TEST Stream');
    await sendByEnter(page, 'Tell me about the trading floor project');
    await waitForChatRequests(page, 1);
    const reply = V.avatarMsgs(page).last();

    // thinking
    await expect(reply).toHaveAttribute('data-state', 'thinking');
    await expect(reply).toHaveAttribute('aria-busy', 'true');
    await expect(reply.locator('.bubble.is-thinking .thinking > span')).toHaveCount(3);
    expect(await reply.locator('.bubble').evaluate((e) => getComputedStyle(e, '::after').content)).toContain('thinking');
    // busy composer: button disabled, textarea editable + focused
    await expect(V.send(page)).toBeDisabled();
    await expect(V.composer(page)).toBeEditable();
    await expect(V.composer(page)).toBeFocused();
    await shot(page, testInfo, 'visitor-stream-1-thinking');

    await ackStart(page);
    // The day separator is placed as soon as the visitor message is confirmed
    // (not when the reply completes - that made the thread jump).
    await expect(page.locator('#thread > .day-sep')).toHaveCount(1);
    await expect(page.locator('#thread > .day-sep')).toContainText('Today');
    // tool-calling
    await push(page, 'tool_called', { call_id: 'c1', name: 'faq_tool', arguments: '{"question_number": 11}' });
    await expect(reply).toHaveAttribute('data-state', 'tool-calling');
    const tool = reply.locator('.tool-status');
    await expect(tool).toHaveText(/Calling faq_tool/);
    await expect(tool).toHaveAttribute('data-state', 'live');
    expect(await tool.locator('.dots').evaluate((e) => getComputedStyle(e, '::after').content)).toContain('…');
    const toolFont = await tool.evaluate((e) => getComputedStyle(e).fontFamily);
    expect(toolFont).toMatch(/JetBrains Mono/);
    await shot(page, testInfo, 'visitor-stream-2-tool-calling');

    // tool-returned
    await push(page, 'tool_output', { call_id: 'c1', name: 'faq_tool' });
    await expect(reply).toHaveAttribute('data-state', 'tool-returned');
    await expect(tool).toHaveClass(/is-done/);
    await expect(tool).toHaveText(/Looked up the FAQ · Q11/);
    expect(await reply.locator('.bubble').evaluate((e) => getComputedStyle(e, '::after').content)).toContain('writing');
    await shot(page, testInfo, 'visitor-stream-3-tool-returned');

    // typing
    await push(page, 'delta', { text: '**Autonomous Trading Floor** is a multi-agent ' });
    await expect(reply).toHaveAttribute('data-state', 'typing');
    await expect(reply.locator('.bubble.is-streaming strong')).toHaveText('Autonomous Trading Floor');
    await push(page, 'delta', { text: 'simulation where' });
    await expect(reply.locator('.bubble')).toContainText('simulation where');
    await shot(page, testInfo, 'visitor-stream-4-typing');

    // complete
    const content = '**Autonomous Trading Floor** is a multi-agent simulation where traders research and trade.\n\n'
      + '- Built with the OpenAI Agents SDK\n- Uses MCP servers\n\n'
      + '[Code on GitHub](https://github.com/Neuromediator) · `python -m app`';
    const done = row('avatar', content, [{ type: 'function', name: 'faq_tool', arguments: '{"question_number": 11}', output: '...' }]);
    await push(page, 'done', { message: done });
    await expect(reply).toHaveAttribute('data-state', 'complete');
    await expect(reply).toHaveAttribute('data-id', String(done.id));
    await expect(reply).not.toHaveAttribute('aria-busy', 'true');
    await expect(reply.locator('.bubble')).not.toHaveClass(/is-streaming|is-thinking/);
    await expect(reply.locator('.bubble li')).toHaveCount(2);
    await expect(reply.locator('.bubble code')).toHaveText('python -m app');
    const link = reply.locator('.bubble a');
    await expect(link).toHaveAttribute('href', 'https://github.com/Neuromediator');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(reply.locator('.tool-status.is-done')).toHaveCount(1);
    await expect(V.send(page)).toBeEnabled();
    expect(await isComposerFocused(page)).toBe(true);
    await expect(page.locator('#liveRegion')).toContainText('Avatar:');
    // The Avatar's token is the robotic twin of the owner (SPEC UI), and the image is served.
    await expectTokenImage(page, reply.locator('.avatar.avatar-twin'), 'avatar-robot');
    await expect(reply.locator('.avatar-human')).toHaveCount(0);
    await expect(V.visitorMsgs(page).last().locator('.avatar-initials')).toHaveText('TS');
    await shot(page, testInfo, 'visitor-stream-5-complete-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'visitor-stream-5-complete-light');
    expect(cfg.owner_first_name.length).toBeGreaterThan(0);
  });

  test('push_tool rows: delivered vs flagged (V-C9)', async ({ page, request }, testInfo) => {
    const cfg = await ownerConfig(request);
    await openVisitor(page);
    await sendByEnter(page, 'I want to hire Sergei, my email is test@example.com');
    await waitForChatRequests(page, 1);
    await ackStart(page);
    await push(page, 'tool_called', { call_id: 'p1', name: 'push_tool', arguments: '{"message":"hire"}' });
    const reply = V.avatarMsgs(page).last();
    await expect(reply.locator('.tool-status')).toHaveText(/Calling push_tool/);
    await push(page, 'tool_output', { call_id: 'p1', name: 'push_tool', ok: true });
    await expect(reply.locator('.tool-status')).toHaveText(`Notified ${cfg.owner_first_name} · push_tool`);
    await finish(page, `Thanks! I've passed that on to ${cfg.owner_first_name}.`,
      [{ type: 'function', name: 'push_tool', arguments: '{"message":"hire"}', output: 'Notification sent' }]);
    await expect(reply.locator('.tool-status.is-done')).toHaveText(`Notified ${cfg.owner_first_name} · push_tool`);
    await shot(page, testInfo, 'visitor-push-notified');

    // A failed delivery says "Flagged for", never claims a notification.
    await sendByEnter(page, 'Another request');
    await waitForChatRequests(page, 2);
    await ackStart(page);
    await push(page, 'tool_called', { call_id: 'p2', name: 'push_tool', arguments: '{}' });
    await push(page, 'tool_output', { call_id: 'p2', name: 'push_tool', ok: false });
    const second = V.avatarMsgs(page).last();
    await expect(second.locator('.tool-status')).toHaveText(`Flagged for ${cfg.owner_first_name} · push_tool`);
    await finish(page, 'Flagged.', [{ type: 'function', name: 'push_tool', arguments: '{}', output: 'Push failed' }]);
    await expect(second.locator('.tool-status.is-done')).toHaveText(`Flagged for ${cfg.owner_first_name} · push_tool`);
  });

  test('an error event shows an inline notice and re-enables the composer (V-C10)', async ({ page }, testInfo) => {
    await openVisitor(page);
    await sendByEnter(page, 'This one fails');
    await waitForChatRequests(page, 1);
    await ackStart(page);
    await push(page, 'error', { detail: 'Sorry, something went wrong while I was writing my reply. Please try again in a moment.' });
    const reply = V.avatarMsgs(page).last();
    await expect(reply).toHaveAttribute('data-state', 'error');
    await expect(reply.locator('.notice.notice--error')).toContainText('something went wrong');
    await expect(reply).not.toHaveAttribute('data-pending', '');
    await expect(V.send(page)).toBeEnabled();
    await expect(V.composer(page)).toBeFocused();
    await shot(page, testInfo, 'visitor-stream-error');
    // The visitor can send again straight away.
    await sendByEnter(page, 'Retry');
    await waitForChatRequests(page, 2);
  });

  test('an error before the tool returns leaves a stopped tool row, not a running one (V-C15)', async ({ page }, testInfo) => {
    await openVisitor(page);
    await sendByEnter(page, 'This one fails mid-tool');
    await waitForChatRequests(page, 1);
    await ackStart(page);
    await push(page, 'tool_called', { call_id: 'c1', name: 'faq_tool', arguments: '{"question_number": 3}' });
    const reply = V.avatarMsgs(page).last();
    const tool = reply.locator('.tool-status');
    await expect(tool).toHaveAttribute('data-state', 'live');
    await push(page, 'error', { detail: 'Sorry, something went wrong while I was writing my reply. Please try again in a moment.' });
    await expect(reply).toHaveAttribute('data-state', 'error');
    await expect(tool).toHaveAttribute('data-state', 'stopped');
    await expect(tool).toHaveClass(/is-stopped/);
    await expect(tool).toHaveText('faq_tool · stopped');
    await expect(tool.locator('use')).toHaveAttribute('href', '#i-close');
    await expect(tool.locator('.dots')).toHaveCount(0);
    expect(await tool.locator('svg').evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
    await expect(reply.locator('.notice.notice--error')).toContainText('something went wrong');
    await expect(V.send(page)).toBeEnabled();
    await shot(page, testInfo, 'visitor-stream-error-mid-tool');
  });

  test('a dropped stream shows the reconnect note without crashing (V-C11)', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openVisitor(page);
    await sendByEnter(page, 'Stream will drop');
    await waitForChatRequests(page, 1);
    await ackStart(page);
    await push(page, 'delta', { text: 'Partial answer' });
    await dropStream(page);
    const reply = V.avatarMsgs(page).last();
    await expect(reply).toHaveAttribute('data-state', 'error');
    await expect(reply.locator('.notice')).toContainText('The connection dropped');
    await expect(reply.locator('.bubble')).toContainText('Partial answer');
    await expect(V.composer(page)).toBeFocused();
    await expect(V.send(page)).toBeEnabled();
    expect(errors).toEqual([]);
    await shot(page, testInfo, 'visitor-stream-dropped');
  });

  test('unsafe Markdown in a reply is sanitised (V-C13)', async ({ page }) => {
    await openVisitor(page);
    await sendByEnter(page, 'xss please');
    await waitForChatRequests(page, 1);
    await ackStart(page);
    const evil = 'Hi <img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script>'
      + ' [click](javascript:window.__pwned=3) <a href="https://example.com" onclick="window.__pwned=4">ok</a>'
      + ' <iframe src="https://example.com"></iframe><b style="color:red" class="msg--human">bold</b>';
    await finish(page, evil);
    const bubble = V.avatarMsgs(page).last().locator('.bubble');
    await expect(bubble).toContainText('Hi');
    await expect(bubble.locator('img, script, iframe')).toHaveCount(0);
    await expect(bubble.locator('a[href^="javascript"]')).toHaveCount(0);
    await expect(bubble.locator('[onclick], [onerror], [style], [class]')).toHaveCount(0);
    await expect(bubble.locator('a[href="https://example.com"]')).toHaveAttribute('target', '_blank');
    await bubble.locator('a', { hasText: 'click' }).click().catch(() => undefined);
    await bubble.locator('a[href="https://example.com"]').evaluate((a) => a.dispatchEvent(new MouseEvent('click', { cancelable: true })));
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  });

  test('while a reply is in flight a second Enter does not send; the draft waits (V-B11)', async ({ page }) => {
    await openVisitor(page);
    await sendByEnter(page, 'First question');
    await waitForChatRequests(page, 1);
    await V.composer(page).fill('Second question');
    await V.composer(page).press('Enter');
    await expect(V.send(page)).toBeDisabled();
    expect((await chatRequests(page)).length).toBe(1);
    await expect(V.composer(page)).toHaveValue('Second question');
    await expect(V.composer(page)).toBeFocused();
    await ackStart(page);
    await finish(page, 'First answer.');
    await expect(V.send(page)).toBeEnabled();
    await V.composer(page).press('Enter');
    await waitForChatRequests(page, 2);
    expect((await chatRequests(page))[1]!.message).toBe('Second question');
  });

  test('Reset during a reply drops it cleanly; late events are ignored (V-F7)', async ({ page }) => {
    await openVisitor(page);
    await sendByEnter(page, 'Reset me mid-stream');
    await waitForChatRequests(page, 1);
    await ackStart(page);
    await push(page, 'delta', { text: 'Half an ans' });
    await V.reset(page).click();
    await expect(V.msgs(page)).toHaveCount(0);
    await expect(V.intro(page)).toBeVisible();
    await expect(V.send(page)).toBeEnabled();
    await expect(V.composer(page)).toBeFocused();
    // The old stream finishing later must not resurrect anything.
    await push(page, 'delta', { text: 'wer' }).catch(() => undefined);
    await push(page, 'done', { message: row('avatar', 'Half an answer') }).catch(() => undefined);
    await expect(V.msgs(page)).toHaveCount(0);
    // And the next message works normally.
    await sendByEnter(page, 'Fresh start');
    await waitForChatRequests(page, 2);
    const reqs = await chatRequests(page);
    expect(reqs[1]!.conversation_id).not.toBe(reqs[0]!.conversation_id);
    await expect(V.visitorMsgs(page)).toHaveCount(1);
  });

  test('Enter in the name field jumps to the composer (V-B12)', async ({ page }) => {
    await openVisitor(page);
    await V.name(page).click();
    await V.name(page).fill('TEST Enter');
    await V.name(page).press('Enter');
    await expect(V.composer(page)).toBeFocused();
    expect((await chatRequests(page)).length).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('avatar-name'))).toBe('TEST Enter');
  });
});

test.describe('visitor HTTP errors (routed)', () => {
  test('a mocked 429 shows the friendly rate-limit notice and restores the draft (V-H2)', async ({ page }, testInfo) => {
    await page.route('**/api/chat', (route) => route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'Retry-After': '30' },
      body: JSON.stringify({ detail: "You're sending messages too quickly. Please wait a moment and try again." }),
    }));
    await openVisitor(page);
    await sendByEnter(page, 'Too fast');
    const notice = V.notices(page).last();
    await expect(notice).toHaveClass(/notice--rate-limit/);
    await expect(notice).toContainText('sending messages too quickly');
    await expect(notice).toHaveAttribute('role', 'alert');
    await expect(V.msgs(page)).toHaveCount(0);
    await expect(V.intro(page)).toBeVisible();
    await expect(V.composer(page)).toHaveValue('Too fast');
    await expect(V.composer(page)).toBeFocused();
    await shot(page, testInfo, 'visitor-rate-limit-mocked');
    await notice.locator('.notice-close').click();
    await expect(V.notices(page)).toHaveCount(0);
  });
});
