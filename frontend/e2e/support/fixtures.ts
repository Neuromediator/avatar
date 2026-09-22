/**
 * The suite's `test`: Playwright's, plus an automatic guard that fails a test
 * when its page throws an uncaught error or logs a console error. Network
 * status logs for responses the tests provoke on purpose are expected:
 * 401 (GET /admin/api/session while signed out, a wrong password), 413 (the
 * oversized message), 429 (rate limit) and 503 (the mocked history failure).
 */
import { test as base, expect, type Page } from '@playwright/test';

const EXPECTED_STATUS_LOG = /Failed to load resource: the server responded with a status of (401|413|429|503)\b/;

/**
 * Record `page`'s uncaught errors and unexpected console errors into `problems`
 * (prefixed with `label`). The automatic guard uses it for the default page;
 * tests that open more pages (extra contexts, tabs) call it for each of them.
 */
export function watchPage(page: Page, problems: string[], label = ''): void {
  const prefix = label ? `${label} ` : '';
  page.on('pageerror', (e) => problems.push(`${prefix}pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (EXPECTED_STATUS_LOG.test(text)) return;
    problems.push(`${prefix}console.error: ${text}`);
  });
}

export const test = base.extend<{ consoleGuard: void }>({
  consoleGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      watchPage(page, problems);
      await use();
      expect(problems, 'no uncaught page errors or console errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
