/**
 * Playwright Test config for the Avatar frontend end-to-end suite (frontend/e2e/).
 *
 * The suite runs against a live backend that serves the built frontend:
 *
 *   npm run build
 *   cd ../backend && MODEL=openai/gpt-5.4-nano uv run uvicorn app.main:app --app-dir . --port 8100
 *   BASE_URL=http://localhost:8100 npm run test:e2e
 *
 * Env:
 *   BASE_URL        backend origin (default http://localhost:8100)
 *   SCREENSHOT_DIR  where tests write named screenshots, relative to frontend/
 *                   (default ../test/screenshots/frontend)
 *   ADMIN_PASSWORD  admin password (default: read from ../.env)
 *
 * Projects: "desktop" (Chromium 1440x900) runs every spec except *.mobile.spec.ts
 * and *.e2e.spec.ts; "mobile" (390x844, isMobile + hasTouch, desktop Chrome UA) runs the
 * *.mobile.spec.ts files. `npm run test:e2e` runs these two (the frontend suite).
 * "three-way" runs the *.e2e.spec.ts files: the Docker end-to-end scenario with
 * three visitors, the Avatar and the owner at once (it makes real LLM calls and
 * sends one real Pushover notification), `npm run test:e2e:three-way`.
 * Workers are capped at 3: the admin inbox is shared by every test.
 */
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || 'http://localhost:8100';

// Resolved once here so every worker writes to the same absolute folder.
process.env.AVATAR_SCREENSHOT_DIR = path.resolve(
  FRONTEND_DIR,
  process.env.SCREENSHOT_DIR || '../test/screenshots/frontend',
);

export default defineConfig({
  testDir: './e2e',
  // Real LLM calls (openai/gpt-5.4-nano) take a few seconds; keep generous headroom.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 3,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    colorScheme: 'dark',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: [/.*\.mobile\.spec\.ts/, /.*\.e2e\.spec\.ts/],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: 'mobile',
      testMatch: /.*\.mobile\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        // Phone viewport, DPR, touch and isMobile, but a desktop Chrome user agent:
        // with the Android UA Google Fonts serves Android-specific font files that
        // headless Linux Chromium spaces badly ("lif estyle"), which would make the
        // screenshots look worse than real phones. The app itself never reads the UA.
        userAgent: devices['Desktop Chrome'].userAgent,
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      // Opens its own desktop and phone contexts for each participant.
      name: 'three-way',
      testMatch: /.*\.e2e\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
  ],
});
