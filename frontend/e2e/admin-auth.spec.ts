/**
 * Admin login gate: idle (field focused), empty submit, wrong password (one
 * attempt only - failed logins are rate limited per IP), logging in (request
 * held: button disabled, "Signing in…", aria-busy), success, session
 * persistence across reloads, sign out, and every admin API route refusing
 * requests without the session cookie. (Plan section A-L.)
 */
import { expect, test } from './support/fixtures';
import { adminPassword, newCid, ownerConfig } from './support/env';
import { A, loginAdmin, setTheme, shot } from './support/ui';

test.describe('admin auth', () => {
  test('signed out: the gate shows with the password field focused (A-L1)', async ({ page, request }, testInfo) => {
    const cfg = await ownerConfig(request);
    const session = page.waitForResponse((r) => r.url().endsWith('/admin/api/session'));
    await page.goto('/admin');
    expect((await session).status()).toBe(401);
    await expect(A.gate(page)).toBeVisible();
    await expect(page).toHaveTitle('Avatar Admin');
    await expect(A.password(page)).toBeFocused();
    await expect(A.password(page)).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.locator('.gate-lede')).toContainText(cfg.owner_name);
    await expect(page.locator('#gateError')).toBeHidden();
    await expect(A.shell(page)).toHaveCount(0);
    await shot(page, testInfo, 'admin-gate-dark');
    await setTheme(page, 'light');
    await shot(page, testInfo, 'admin-gate-light');
  });

  test('empty submit asks for the password without a request (A-L3)', async ({ page }) => {
    let logins = 0;
    page.on('request', (r) => { if (r.url().endsWith('/admin/login')) logins += 1; });
    await page.goto('/admin');
    await expect(A.password(page)).toBeFocused();
    await A.password(page).press('Enter');
    await expect(page.locator('#gateError')).toHaveText('Enter the admin password.');
    expect(logins).toBe(0);
    await expect(A.password(page)).toBeFocused();
  });

  test('a wrong password shows "Incorrect password", refocuses and selects; typing clears it (A-L2)', async ({ page }, testInfo) => {
    await page.goto('/admin');
    await A.password(page).fill('definitely-not-the-password');
    await page.locator('.gate-submit').click();
    const error = page.locator('#gateError');
    await expect(error).toHaveText('Incorrect password');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(A.password(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(A.password(page)).toBeFocused();
    const selected = await A.password(page).evaluate((e) => {
      const i = e as HTMLInputElement;
      return i.selectionStart === 0 && i.selectionEnd === i.value.length;
    });
    expect(selected).toBe(true);
    await expect(page.locator('.gate-submit')).toBeEnabled();
    await shot(page, testInfo, 'admin-gate-error');
    await A.password(page).type('x');
    await expect(error).toBeHidden();
  });

  test('the right password opens the dashboard; the session survives a reload; sign out returns to the gate (A-L4..L6)', async ({ page }, testInfo) => {
    await page.goto('/admin');
    await A.password(page).fill(adminPassword());
    const login = page.waitForResponse((r) => r.url().endsWith('/admin/login'));
    await A.password(page).press('Enter');
    expect((await login).status()).toBe(200);
    await expect(A.shell(page)).toBeVisible();
    await expect(page.locator('.appbar .admin-pill')).toHaveText('Admin');
    await expect(page.locator('.secure-note')).toContainText('Secure session');
    await expect(page.locator('.thread-placeholder')).toBeVisible();
    await expect(A.rows(page).first()).toBeVisible();
    // httpOnly: the session cookie is invisible to page scripts.
    const cookie = (await page.context().cookies()).find((c) => c.name === 'avatar_admin');
    expect(cookie?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain('avatar_admin');
    await shot(page, testInfo, 'admin-dashboard-empty-selection');

    await page.reload();
    await expect(A.shell(page)).toBeVisible();
    await expect(A.gate(page)).toHaveCount(0);

    await page.locator('.signout-btn').click();
    await expect(A.gate(page)).toBeVisible();
    await expect(A.password(page)).toBeFocused();
    const res = await page.request.get('/admin/api/conversations');
    expect(res.status()).toBe(401);
    await page.reload();
    await expect(A.gate(page)).toBeVisible();
  });

  test('logging in: while the request is in flight the button is disabled ("Signing in…") and the form is aria-busy (A-L8)', async ({ page }, testInfo) => {
    // Hold the (correct-password) login request so the in-between state can be seen.
    // Successful logins are not throttled, so this costs nothing.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let logins = 0;
    page.on('request', (r) => { if (r.url().endsWith('/admin/login')) logins += 1; });
    await page.route('**/admin/login', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/admin');
    await expect(A.password(page)).toBeFocused();
    await A.password(page).fill(adminPassword());
    await A.password(page).press('Enter');

    const submit = page.locator('.gate-submit');
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveClass(/is-busy/);
    await expect(submit.locator('.gate-submit-label')).toHaveText('Signing in…');
    await expect(page.locator('form.gate-form')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#gateError')).toBeHidden();
    await expect(A.shell(page)).toHaveCount(0);
    // A second Enter while busy sends nothing more.
    await A.password(page).press('Enter');
    expect(logins).toBe(1);
    await shot(page, testInfo, 'admin-gate-logging-in');

    const login = page.waitForResponse((r) => r.url().endsWith('/admin/login'));
    release();
    expect((await login).status()).toBe(200);
    await expect(A.shell(page)).toBeVisible();
    await expect(A.gate(page)).toHaveCount(0);
    expect(logins).toBe(1);
  });

  test('every admin API route is 401 without the session cookie (A-L7)', async ({ request }) => {
    const cid = newCid();
    const calls = [
      request.get('/admin/api/session'),
      request.get('/admin/api/conversations'),
      request.get(`/admin/api/conversations/${cid}`),
      request.post(`/admin/api/conversations/${cid}/messages`, { data: { content: 'hi' } }),
      request.post(`/admin/api/conversations/${cid}/resolve`),
    ];
    for (const res of await Promise.all(calls)) expect(res.status()).toBe(401);
    // A forged cookie is refused too.
    const forged = await request.get('/admin/api/conversations', { headers: { Cookie: 'avatar_admin=forged.token.value' } });
    expect(forged.status()).toBe(401);
  });

  test('an expired/revoked session mid-use returns to the gate with a notice (A-L6)', async ({ page }) => {
    await loginAdmin(page);
    // Revoke this browser's session behind the dashboard's back.
    await page.request.post('/admin/logout');
    // The next poll (<= 10 s) gets a 401 and shows the gate.
    await expect(A.gate(page)).toBeVisible({ timeout: 13_000 });
    await expect(page.locator('.gate-notice')).toContainText('Your session has ended');
  });
});
