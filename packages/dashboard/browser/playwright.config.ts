import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/** The checkout this config is in, which names its results' folder. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const checkout = `${basename(root)}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;

/**
 * The dashboard in a real browser: accessibility (axe-core, contrast, focus order, the skip link,
 * focus rings in scrolling panes, every overlay's focus trap and return, and an axe sweep over every
 * page, run, view, tab, menu and dialog), over the whole demo store built by real commands
 * (scripts/demo-store.mjs) and served by `shadowlap dashboard`, as a user opens it. `npm run
 * test:browser`; set SHADOWLAP_DEMO_DIR to a demo store built before to skip building one.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './global-setup.ts',
  // The demo store takes a minute or two to build; each test then takes a few seconds, the sweep's a minute or more.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  // Nothing the run leaves belongs in the repository. A folder for each checkout: a run empties its
  // own as it starts, which would take a failing run's traces in another worktree with it.
  outputDir: join(tmpdir(), 'shadowlap-dashboard-browser-results', checkout),
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
