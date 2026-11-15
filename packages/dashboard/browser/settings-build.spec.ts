import { expect, test } from '@playwright/test';
import { openPage, seriousViolations, sideways } from './dashboard.js';

/**
 * Build, on Settings → Project, in a real browser over the demo store: the command that builds the
 * agent, written as `build` in shadowlap.config.json against the version the row read. Its write is
 * answered here, so the demo's file, which every test shares, is never written.
 */

// A route may still be reading the server's answer as a test ends; the page's close takes it away, and that is no failure.
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

test('Build writes the command that builds the agent, says so with Undo, and fits a phone', async ({ page }) => {
  const sent: unknown[] = [];
  await page.route((url) => url.pathname === '/api/settings/build', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON() as { command: string | null; expect: string };
    sent.push(body);
    return route.fulfill({ json: { build: body.command, was: null, changed: true, version: body.expect } });
  });
  await openPage(page, '/settings/project', 'main#view #build');
  const row = page.locator('main#view #build');
  await expect(row.locator('b')).toHaveText('Build');
  await expect(row).toContainText('where no --build is given');
  await row.locator('input').fill('npm run build');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => sent).toEqual([{ command: 'npm run build', expect: expect.stringMatching(/^(absent|[0-9a-f]{64})$/) }]);
  await expect(page.locator('.toast')).toContainText('Wrote "build": "npm run build" to shadowlap.config.json');
  await expect(page.locator('.toast .tbtn')).toHaveText('Undo');
  expect(await seriousViolations(page)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row.locator('input')).toBeVisible();
  expect(await sideways(page)).toBe(0);
});
