import { expect, test } from '@playwright/test';
import { openPage } from './dashboard.js';

/**
 * Settings and Training on a phone, 390 px: no tab scrolls the page sideways (a table scrolls in a
 * box of its own), the tabs keep one row with the one shown in view, and a row's label and line sit
 * over its control.
 */

const TABS = ['matching', 'redaction', 'ci', 'agents', 'tools', 'project', 'store'];
const sideways = () => document.documentElement.scrollWidth - document.documentElement.clientWidth;

test('no Settings tab scrolls the page sideways on a phone, and the tab shown stays in view in one row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const t of TABS) {
    await openPage(page, `/settings/${t}`, 'main#view .settab > :not(.skel)');
    expect(await page.evaluate(sideways), `Settings → ${t}`).toBe(0);
    const tabs = page.locator('main#view nav.stabs');
    const shown = tabs.locator('a[aria-current="page"]');
    const [row, tab] = await Promise.all([tabs.boundingBox(), shown.boundingBox()]);
    expect(tab!.x, `Settings → ${t}: its tab in view`).toBeGreaterThanOrEqual(row!.x - 1);
    expect(tab!.x + tab!.width, `Settings → ${t}: its tab in view`).toBeLessThanOrEqual(row!.x + row!.width + 1);
    expect(await tabs.locator('a').evaluateAll((as) => new Set(as.map((a) => Math.round(a.getBoundingClientRect().top))).size), `Settings → ${t}: one row of tabs`).toBe(1);
  }
});

test('a Settings row puts its label and line over its control on a phone, and Training scrolls nothing sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, '/settings/matching', 'main#view .setrow');
  const row = page.locator('main#view .setrow').first();
  const [words, control] = await Promise.all([row.locator(':scope > div').first().boundingBox(), row.locator(':scope > :not(div:first-child)').first().boundingBox()]);
  expect(control!.y).toBeGreaterThanOrEqual(words!.y + words!.height);
  await openPage(page, '/training', 'main#view .ph');
  expect(await page.evaluate(sideways)).toBe(0);
});
