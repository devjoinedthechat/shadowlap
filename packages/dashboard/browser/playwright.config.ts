import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * The dashboard in a real browser: accessibility (axe-core, contrast, focus order, the skip link,
 * focus rings in scrolling panes, every overlay's focus trap and return), over a demo store built by
 * real commands (scripts/demo-store.mjs --fast) and served by `shadowlap dashboard`, as a user opens
 * it. `npm run test:browser`; set SHADOWLAP_DEMO_DIR to a demo store built before to skip building one.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './global-setup.ts',
  // The demo store takes most of a minute to build; each test then takes a few seconds.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  // Nothing the run leaves belongs in the repository.
  outputDir: join(tmpdir(), 'shadowlap-dashboard-browser-results'),
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
