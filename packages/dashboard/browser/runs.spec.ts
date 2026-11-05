import { expect, test } from '@playwright/test';
import { openPage, seriousViolations } from './dashboard.js';

/**
 * Runs as the design draws it, in a real browser: the twelve weeks a slim row of days that a drag
 * picks from, Calendar opening the grid in its place and Hide calendar bringing the row back with
 * the focus on its button; on a phone a bar a week; and days in a link that run past the twelve
 * weeks kept to the days inside, the address saying so. No serious axe violation in either.
 */

const hash = (page: import('@playwright/test').Page) => page.evaluate(() => location.hash);

test('the twelve weeks are a row of days a drag picks from, and Calendar opens the grid until Hide calendar', async ({ page }) => {
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  const row = page.locator('main#view section.cal.hist');
  await expect(row).toHaveAttribute('aria-label', 'Runs per day, last 12 weeks');
  const bars = row.locator('.hbars button.cd.hb');
  const n = await bars.count();
  expect(n).toBeGreaterThan(77);
  // The row keeps to its 32px, the table close under the chips.
  expect((await row.locator('.hbars').boundingBox())?.height).toBe(32);
  expect(await seriousViolations(page)).toEqual([]);
  // A drag across three days picks them: the address says which, and the sentence says how many.
  const a = (await bars.nth(n - 3).boundingBox())!;
  const b = (await bars.nth(n - 1).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => hash(page)).toMatch(/^#\/runs\?from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d$/);
  await expect(row.locator('.hbars button[aria-pressed="true"]')).toHaveCount(3);
  await expect(row.locator('.hsum')).toHaveText(/^\d[\d,]* (run|runs) from \w{3} \d+ to \w{3} \d+(, \d[\d,]* failed)?\.$/);
  await expect(row.locator('.hact button', { hasText: 'Clear' })).toBeVisible();
  // Calendar shows the grid in the row's place, its own button in focus; Hide calendar brings the row back.
  await row.locator('.hact button', { hasText: 'Calendar' }).click();
  const grid = page.locator('main#view section.cal:not(.hist)');
  await expect(grid.locator('.calgrid')).toHaveAttribute('aria-label', 'Days, a column per week');
  await expect(grid.locator('.calside > button')).toBeFocused();
  await expect(grid.locator('.calgrid button[aria-pressed="true"]')).toHaveCount(3);
  expect(await seriousViolations(page)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(row.locator('.hact button', { hasText: 'Calendar' })).toBeFocused();
  await expect(row.locator('.hact button', { hasText: 'Calendar' })).toHaveAttribute('aria-expanded', 'false');
});

test('days in a link that run past the twelve weeks keep to the days inside, and days wholly outside them are let go', async ({ page }) => {
  await openPage(page, '/runs?from=2020-01-01&to=2099-01-01', 'main#view section.cal.hist .hbars button');
  const bars = page.locator('main#view section.cal.hist .hbars button.cd.hb');
  await expect.poll(() => hash(page)).not.toContain('2020-01-01');
  expect(await hash(page)).not.toContain('2099-01-01');
  expect(await bars.count()).toBeGreaterThan(77);
  await expect(page.locator('main#view section.cal.hist .hbars button.cd.hb[aria-pressed="false"]')).toHaveCount(0);
  await page.evaluate(() => (location.hash = '#/runs?from=2020-01-01&to=2020-02-01'));
  await expect.poll(() => hash(page)).toBe('#/runs');
  await expect(page.locator('main#view section.cal.hist .hbars button[aria-pressed="true"]')).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the twelve weeks are a bar a week, which picks its seven days, with no serious axe violation', async ({ page }) => {
    await openPage(page, '/runs', 'main#view section.cal.hist .hbars button');
    const row = page.locator('main#view section.cal.hist');
    await expect(row).toHaveAttribute('aria-label', 'Runs per week, last 12 weeks');
    const bars = row.locator('.hbars button.cd.hb');
    await expect(bars).toHaveCount(12);
    const box = (await bars.nth(10).boundingBox())!;
    expect(box.width).toBeGreaterThan(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await seriousViolations(page)).toEqual([]);
    await bars.nth(10).click();
    await expect.poll(() => hash(page)).toMatch(/from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d/);
    const [, from, to] = /from=([\d-]+)&to=([\d-]+)/.exec(await hash(page))!;
    expect((Date.parse(to!) - Date.parse(from!)) / 86_400_000).toBe(6);
  });
});
