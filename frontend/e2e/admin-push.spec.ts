/**
 * The human-in-the-loop path end to end with the real model and a real
 * Pushover notification (one per run): a visitor asks to get in touch and
 * leaves an email -> push_tool fires -> the thread is flagged "Needs you" in
 * the inbox -> opening it shows "Avatar asked for you" and the push row, and
 * clears the flag on the server -> the owner replies, the visitor sees it.
 * (Plan section A-O.)
 */
import { expect, test } from './support/fixtures';
import { adminApi, chatViaApi } from './support/api';
import { newCid, ownerConfig, testName } from './support/env';
import { A, V, loginAdmin, openThread, openVisitor, shot } from './support/ui';

test.describe.configure({ timeout: 180_000 });

test('a get-in-touch request pushes to the owner and flags the thread until opened (A-O1..O3, A-M6 message search)', async ({ page, browser, request, baseURL }, testInfo) => {
  const cfg = await ownerConfig(request);
  const name = testName('Recruiter');
  const cid = newCid();
  const phrase = `frontend-e2e-${cid.slice(0, 8)}`;
  const admin = await adminApi(baseURL!);
  try {
    // 1. The visitor (API) asks to get in touch and leaves an email.
    const ask = `Hi, I'm a recruiter (${phrase}). I'd like to offer ${cfg.owner_first_name} an AI engineering role on my team. `
      + `My email is test.recruiter@example.com - please pass this on to ${cfg.owner_first_name} so he can contact me.`;
    let r = await chatViaApi(request, cid, ask, name, 120_000);
    expect(r.status).toBe(200);
    let pushed = r.events.some((e) => e.event === 'tool_called' && e.data.name === 'push_tool');
    if (!pushed) {
      // The model sometimes confirms first; answer it once, explicitly.
      r = await chatViaApi(request, cid, `Yes, please notify ${cfg.owner_first_name} now. My email is test.recruiter@example.com.`, name, 120_000);
      pushed = r.events.some((e) => e.event === 'tool_called' && e.data.name === 'push_tool');
    }
    expect(pushed, 'the Avatar called push_tool').toBe(true);
    const pushOut = r.events.find((e) => e.event === 'tool_output' && e.data.name === 'push_tool');
    testInfo.annotations.push({ type: 'pushover-delivered', description: String(pushOut?.data.ok) });

    const before = await admin.summary(cid);
    expect(before.needs_attention).toBe(true);
    expect(before.unread_count).toBeGreaterThan(0);

    // 2. The inbox flags it (search by a phrase from the visitor's message).
    await loginAdmin(page);
    await A.search(page).fill(phrase);
    const row = A.row(page, cid);
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/is-attention/);
    await expect(row.locator('.badge--attention')).toHaveText('Needs you');
    await expect(row.locator('.convo-preview')).toContainText(phrase);
    await expect(A.chip(page, 'attention')).toHaveClass(/has-items/);
    await shot(page, testInfo, 'admin-push-needs-you-row');

    // 3. Opening it: "Avatar asked for you" + the push row; the server clears the flags.
    await openThread(page, cid);
    await expect(A.flag(page)).toBeVisible();
    await expect(A.flag(page)).toContainText('Avatar asked for you');
    const pushRow = page.locator('.thread-inner .tool-status[data-tool="push_tool"]');
    await expect(pushRow).toHaveText(pushOut?.data.ok === false ? 'Flagged for you · push_tool' : 'Notified you · push_tool');
    await shot(page, testInfo, 'admin-push-thread-flag');
    const after = await admin.summary(cid);
    expect(after.needs_attention).toBe(false);
    expect(after.unread_count).toBe(0);
    const opened = await admin.open(cid);
    expect(opened.messages.every((m: any) => m.read && !m.needs_attention)).toBe(true);

    // 4. The owner replies; the flag goes; the visitor sees the reply.
    await A.composer(page).fill(`Thanks for reaching out! I'll email you today. - ${cfg.owner_first_name}`);
    await A.composer(page).press('Enter');
    await expect(page.locator('.thread-inner > .msg--human[data-id]')).toHaveCount(1);
    await expect(A.flag(page)).toBeHidden();
    await A.search(page).fill('');
    await A.search(page).fill(phrase);
    await expect(row).not.toHaveClass(/is-attention/);

    const visitorCtx = await browser.newContext({ baseURL });
    await visitorCtx.addCookies([{ name: 'avatar_cid', value: cid, url: baseURL! }]);
    const visitor = await visitorCtx.newPage();
    await openVisitor(visitor);
    await expect(V.humanMsgs(visitor)).toHaveCount(1);
    await expect(V.humanMsgs(visitor).locator('.human-tag')).toHaveText(`${cfg.owner_name} · live`);
    await expect(visitor.locator('#thread .tool-status[data-tool="push_tool"]').first()).toContainText(`${cfg.owner_first_name} · push_tool`);
    await shot(visitor, testInfo, 'visitor-push-then-owner-reply');
    await visitorCtx.close();
  } finally {
    await admin.dispose();
  }
});
