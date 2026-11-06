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

test('x picks a row and the bar comes; Delete takes the run off every list at once, and Undo puts it back', async ({ page }) => {
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  const nav = page.locator('nav.navlist a[href="#/runs"]');
  const before = await nav.textContent();
  const row = page.locator('main#view table.runst tbody tr:not(.wspace)').first();
  const link = (await row.locator('a.rowa').getAttribute('href'))!;
  await row.locator('a.rowa').focus();
  await page.keyboard.press('x');
  const bar = page.locator('.bulkbar');
  await expect(bar.locator('b')).toHaveText('1 selected');
  expect(await bar.locator('button').allTextContents()).toEqual(expect.arrayContaining(['Add label…', 'Export dataset…', 'Compare', 'Delete 1 run', 'Clear selection']));
  await bar.locator('button', { hasText: 'Delete 1 run' }).click();
  await page.locator('.dialog button', { hasText: /^Delete run$/ }).click();
  await expect(page.locator(`main#view table.runst a.rowa[href="${link}"]`)).toHaveCount(0);
  await expect(nav).not.toHaveText(before!);
  const toast = page.locator('.toasts .toast');
  await expect(toast).toContainText('Deleted');
  await toast.locator('button', { hasText: 'Undo' }).click();
  await expect(page.locator(`main#view table.runst a.rowa[href="${link}"]`)).toHaveCount(1);
  await expect(nav).toHaveText(before!);
  await expect(page.locator('.toasts .toast')).toContainText('Restored');
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

test('Enter makes the words a step that Back undoes with them; the nav’s Runs opens the last view where its list was left, and all every run', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await openPage(page, '/runs?types=recording', 'main#view table.runst tbody tr');
  const field = page.locator('main#view #runsQuery');
  await field.fill('ticket');
  await expect.poll(() => hash(page)).toBe('#/runs?q=ticket&types=recording');
  await field.press('Enter');
  await page.goBack();
  await expect.poll(() => hash(page)).toBe('#/runs?types=recording');
  await expect(field).toHaveValue('');
  await page.goForward();
  await expect(field).toHaveValue('ticket');
  // Every run, scrolled down, then a run opened from it.
  await page.locator('main#view .tbar .chips button', { hasText: /^All/ }).click();
  await expect.poll(() => hash(page)).toBe('#/runs?q=ticket');
  await field.fill('');
  await expect.poll(() => hash(page)).toBe('#/runs');
  await page.locator('main#view .tbar .chips button', { hasText: /^Recordings/ }).click();
  await expect.poll(() => hash(page)).toBe('#/runs?types=recording');
  const pane = page.locator('main#view .page');
  const y = await pane.evaluate((el) => {
    el.scrollTop = 240;
    return el.scrollTop;
  });
  expect(y).toBeGreaterThan(100);
  await page.locator('main#view table.runst tbody tr a.rowa').nth(4).click();
  await expect.poll(() => hash(page)).toMatch(/^#\/run\//);
  // The nav's Runs: the view it showed, where it was.
  const nav = page.locator('nav.navlist[aria-label="Sections"] a', { hasText: 'Runs' });
  await expect(nav).toHaveAttribute('href', '#/runs?types=recording');
  await nav.click();
  await expect.poll(() => hash(page)).toBe('#/runs?types=recording');
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(y);
  // The sidebar's all: every run.
  await page.locator('.side-k a', { hasText: 'all' }).click();
  await expect.poll(() => hash(page)).toBe('#/runs');
  await expect(page.locator('main#view .tbar .chips button[aria-pressed="true"]')).toHaveText(/^All/);
});
