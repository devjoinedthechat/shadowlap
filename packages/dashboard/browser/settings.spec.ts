import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { dash, openPage } from './dashboard.js';

/**
 * Settings and Training on a phone, 390 px: no tab scrolls the page sideways (a table scrolls in a
 * box of its own), the tabs keep one row with the one shown in view, a row's label and line sit
 * over its control, and a rule removed comes back from its toast's Undo, the file as it was.
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

test('a Settings row puts its label and line over its control on a phone, a Switch right under them with a link after it, and Training scrolls nothing sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, '/settings/matching', 'main#view .setrow');
  const row = page.locator('main#view .setrow').first();
  const [words, control] = await Promise.all([row.locator(':scope > div').first().boundingBox(), row.locator(':scope > :not(div:first-child)').first().boundingBox()]);
  expect(control!.y).toBeGreaterThanOrEqual(words!.y + words!.height);
  // A Switch comes right under what it turns on, and the link beside it (Copy CI step) after it.
  await openPage(page, '/settings/store', 'main#view .setrow:has(#ciPush-name) [role="switch"]');
  const ci = page.locator('main#view .setrow:has(#ciPush-name)');
  const [line, on, link] = await Promise.all([ci.locator(':scope > div').first().boundingBox(), ci.getByRole('switch', { name: 'Push from CI' }).boundingBox(), ci.getByRole('button', { name: 'Copy CI step' }).boundingBox()]);
  expect(on!.y, 'the Switch under its line').toBeGreaterThanOrEqual(line!.y + line!.height);
  expect(link!.y, 'Copy CI step under the Switch').toBeGreaterThanOrEqual(on!.y + on!.height);
  await openPage(page, '/training', 'main#view .ph');
  expect(await page.evaluate(sideways)).toBe(0);
});

test('a redaction rule removed on a phone comes back from its toast’s Undo, shadowlap.config.json as it was', async ({ page }) => {
  // The suite shares one config: whatever happens here, it is put back (the other specs read it too).
  const file = join(dash().demo, 'support-agent', 'shadowlap.config.json');
  const before = readFileSync(file, 'utf8');
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await openPage(page, '/settings/redaction', 'main#view table.ruletable tbody tr');
    const rows = page.locator('main#view table.ruletable tbody tr');
    const count = await rows.count();
    await page.getByRole('button', { name: 'Remove redaction rule #1', exact: true }).click();
    const undo = page.locator('.toast button', { hasText: 'Undo' });
    await expect(undo).toBeVisible();
    await expect(rows).toHaveCount(count - 1);
    expect(await page.evaluate(sideways)).toBe(0);
    await undo.click();
    await expect(rows).toHaveCount(count);
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(before);
  } finally {
    if (readFileSync(file, 'utf8') !== before) writeFileSync(file, before);
  }
});
