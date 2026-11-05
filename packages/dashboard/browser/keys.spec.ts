import { expect, test, type Page } from '@playwright/test';
import { demoId, openPage, seriousViolations } from './dashboard.js';

/**
 * The keyboard in Chromium over the demo store: the lists' keys on Runs, Esc going back the way you
 * came, the tabs pattern on a run, the shortcuts sheet with its switch, and a heading that takes the
 * focus with no ring.
 */

const RUNS = 'main#view table.runst tbody tr';
const openRuns = (page: Page) => openPage(page, '/runs', RUNS);
const hash = (page: Page) => page.evaluate(() => location.hash);
const inFocus = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-rowkey') ?? document.activeElement?.tagName ?? '');

test('j and k walk Runs, the row in focus drawn and in view, x picks it, and Esc clears then lets go', async ({ page }) => {
  await openRuns(page);
  await page.keyboard.press('j');
  const first = page.locator(`${RUNS}.krow`);
  await expect(first).toHaveCount(1);
  const key = await first.getAttribute('data-rowkey');
  expect(await inFocus(page)).toBe(key);
  await page.keyboard.press('j');
  await page.keyboard.press('ArrowUp');
  expect(await inFocus(page)).toBe(key);
  await page.keyboard.press('x');
  await expect(page.locator('.bulkbar')).toBeVisible();
  await expect(page.locator(`${RUNS}.picked`)).toHaveCount(1);
  expect(await seriousViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.bulkbar')).toHaveCount(0);
  await expect(page.locator(`${RUNS}.krow`)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator(`${RUNS}.krow`)).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.matches('main#view h1'))).toBe(true);
  // The focus says no ring round the heading, which is no control.
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('none');
});

test('Enter opens the row, the run’s heading takes the focus, and Esc comes back to the row', async ({ page }) => {
  await openRuns(page);
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  const key = await page.locator(`${RUNS}.krow`).getAttribute('data-rowkey');
  await page.keyboard.press('Enter');
  await page.locator('h1.rnm').waitFor();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
  await page.keyboard.press('Escape');
  await page.locator(RUNS).first().waitFor();
  await expect.poll(() => inFocus(page)).toBe(key);
  await expect(page.locator(`${RUNS}.krow`)).toHaveAttribute('data-rowkey', key!);
});

test('Esc on a run opened cold goes up to its parent, or to Runs', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const parent = await page.locator('nav.crumbs a[href^="#/run/"]').last().getAttribute('href');
  await page.keyboard.press('Escape');
  await expect.poll(() => hash(page)).toContain(parent!);
  await page.locator('h1.rnm').waitFor();
  await page.keyboard.press('Escape');
  await expect.poll(() => hash(page)).toContain('#/runs');
});

test('⌘K on a row offers its actions, ⌫ everything, and closing hands the focus back', async ({ page }) => {
  await openRuns(page);
  await page.keyboard.press('j');
  const key = await page.locator(`${RUNS}.krow`).getAttribute('data-rowkey');
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('.palette').waitFor();
  await expect(page.locator('.palit .pl').first()).toHaveText('Open run');
  await expect(page.locator('.palfoot')).toContainText('everything');
  expect(await seriousViolations(page)).toEqual([]);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.palit .pl', { hasText: /^Runs$/ })).toBeVisible();
  await expect(page.locator('.palit .palk kbd').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.palette')).toHaveCount(0);
  await expect.poll(() => inFocus(page)).toBe(key);
});

test('a run’s views and the inspector are tabs with one Tab stop, the arrows moving and v going through them all', async ({ page }) => {
  await openPage(page, `/run/${demoId('refundBug')}`, 'run');
  const views = page.locator('[role="tablist"][aria-label="Views"] [role="tab"]');
  await expect(views.locator('xpath=self::*[@tabindex="0"]')).toHaveCount(1);
  await page.locator('[role="tablist"][aria-label="Views"] [aria-selected="true"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#vtab-turns')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#vtab-turns')).toBeFocused();
  await expect(page.locator('#vbody')).toHaveAttribute('aria-labelledby', 'vtab-turns');
  await page.keyboard.press('End');
  await expect(page.locator('#vtab-provenance')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#vtab-calls')).toBeFocused();
  await expect(page.locator('#vtab-turns')).toHaveAttribute('aria-keyshortcuts', 'v');
  const tabs = page.locator('[role="tablist"][aria-label="The selected call"] [role="tab"]');
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(2)).toHaveAttribute('aria-keyshortcuts', '3');
  await expect(page.locator('#ibody')).toHaveAttribute('role', 'tabpanel');
  // From the provenance view v comes round to Calls.
  await page.locator('#vtab-provenance').click();
  await page.keyboard.press('v');
  await expect(page.locator('#vtab-calls')).toHaveAttribute('aria-selected', 'true');
  expect(await seriousViolations(page)).toEqual([]);
});

test('j moves the selected call and takes the focus, and Esc in the filter goes back to it with the words kept', async ({ page }) => {
  await openPage(page, `/run/${demoId('refundBug')}`, 'run');
  await page.keyboard.press('j');
  await expect.poll(() => page.evaluate(() => document.activeElement?.matches('.vbody tr[aria-selected="true"]'))).toBe(true);
  await page.keyboard.press('/');
  const filter = page.locator('.filter-in input');
  await expect(filter).toBeFocused();
  await page.keyboard.type('a');
  await page.keyboard.press('Escape');
  await expect(filter).toHaveValue('a');
  await expect.poll(() => page.evaluate(() => document.activeElement?.matches('.vbody tr[aria-selected="true"]'))).toBe(true);
});

test('the sheet’s lines each keep to one line, its switch is remembered, and off, nothing advertises a single key', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPage(page, `/run/${demoId('refundBug')}`, 'run');
  await page.keyboard.press('?');
  await page.locator('.help').waitFor();
  const lines = await page.locator('.help dd').evaluateAll((all) => all.map((dd) => [dd.textContent, dd.getBoundingClientRect().height]));
  for (const [text, height] of lines) expect(Number(height), String(text)).toBeLessThan(40);
  expect(await seriousViolations(page)).toEqual([]);
  await page.locator('.help [role="switch"]').click();
  await expect(page.locator('html.nosk')).toHaveCount(1);
  expect(await page.locator('.help dt.sk').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await page.locator('.help footer button').click();
  await expect(page.locator('#forkBtn')).not.toHaveAttribute('aria-keyshortcuts');
  // A single key does nothing now, Esc and the arrows still work.
  await page.keyboard.press('?');
  await expect(page.locator('.help')).toHaveCount(0);
  await page.reload();
  await page.locator('h1.rnm').waitFor();
  await expect(page.locator('html.nosk')).toHaveCount(1);
  await expect(page.locator('#forkBtn')).not.toHaveAttribute('aria-keyshortcuts');
});

test('Tab starts at the skip link, then the top bar, and a new page starts Tab from its heading', async ({ page }) => {
  await openRuns(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('a.skip')).toBeFocused();
  await page.locator('aside#side .navlist a', { hasText: 'Fixes' }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.matches('main#view h1'))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('main#view'))).toBe(true);
});

test('on a phone, the drawer takes the focus to its first item, and a click beside it closes it', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await openRuns(page);
  const menu = page.locator('button.menu-toggle');
  await menu.click();
  await expect(page.locator('aside#side.open')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('aside#side'))).toBe(true);
  await page.mouse.click(700, 500);
  await expect(page.locator('aside#side.open')).toHaveCount(0);
  await expect(menu).toBeFocused();
});
