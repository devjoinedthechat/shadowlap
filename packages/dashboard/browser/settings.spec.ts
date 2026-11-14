import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { dash, openPage, sideways } from './dashboard.js';

/**
 * Settings and Training on a phone, 390 px: no tab scrolls the page sideways (a table scrolls in a
 * box of its own), the tabs keep one row with the one shown in view, a row's label and line sit
 * over its control, a rule removed comes back from its toast's Undo, the file as it was, and
 * Settings → CI's workflow and, on Gates, a gate's odds, shown, scroll nothing sideways; nor does
 * the CI tab with the part and the lists it folds opened, nor Settings → Store's Pull runs… dialog,
 * nor Settings → Project's Health once it has checked the setup.
 */

const TABS = ['matching', 'redaction', 'ci', 'gates', 'agents', 'tools', 'project', 'store'];

test('no Settings tab scrolls the page sideways on a phone, and the tab shown stays in view in one row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const t of TABS) {
    await openPage(page, `/settings/${t}`, 'main#view .settab > :not(.skel)');
    expect(await sideways(page), `Settings → ${t}`).toBe(0);
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
  // A Switch comes right under what it turns on, and the link beside it (Open Your workflow, or another CI's Copy CI step) after it.
  await openPage(page, '/settings/store', 'main#view .setrow:has(#ciPush-name) [role="switch"]');
  const ci = page.locator('main#view .setrow:has(#ciPush-name)');
  const [line, on, link] = await Promise.all([ci.locator(':scope > div').first().boundingBox(), ci.getByRole('switch', { name: 'Push from CI' }).boundingBox(), ci.locator('.wflink').boundingBox()]);
  expect(on!.y, 'the Switch under its line').toBeGreaterThanOrEqual(line!.y + line!.height);
  expect(link!.y, 'the link under the Switch').toBeGreaterThanOrEqual(on!.y + on!.height);
  await openPage(page, '/training', 'main#view .ph');
  expect(await sideways(page)).toBe(0);
});

test('Settings → Store says when this machine last pushed and pulled, and Pull runs… builds its command as you type on a phone, scrolling nothing sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, '/settings/store', 'main#view dl.kvs');
  const sync = page.locator('main#view dl.kvs dt:text-is("Last sync") + dd');
  // Each part's dot kept with it by a no-break space.
  await expect(sync).toHaveText(/^(never|pushed \S+\s·\spulled \S+)\s\d+ runs? in the store/);
  await sync.getByRole('button', { name: 'Pull runs…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pull runs' });
  const command = dialog.locator('.cmdline');
  await expect(command).toHaveText('$shadowlap pull');
  const runs = dialog.getByRole('textbox', { name: 'Runs' });
  await runs.fill('01k5cq4n7g --all');
  await expect(dialog.locator('.fieldnote.err')).toHaveText('--all is no run: name one by its id, or its first 4 characters or more.');
  await runs.fill('01k5cq4n7g');
  await dialog.getByRole('switch', { name: 'Pull requests’ runs too' }).click();
  await expect(command).toHaveText('$shadowlap pull 01K5CQ4N7G --include-pr');
  expect(await sideways(page)).toBe(0);
});

test('Health checks the setup with shadowlap doctor and lists its checks under it, summed up as the drawer sums them, scrolling nothing sideways on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, '/settings/project', 'main#view .setrow.health');
  await page.locator('main#view .setrow.health').getByRole('button', { name: 'Check setup' }).click();
  const rows = page.locator('main#view ul.doctor li');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  expect(await rows.count()).toBeGreaterThan(3);
  expect(await rows.locator('.st').allTextContents()).toEqual(expect.arrayContaining(['ok']));
  // The same sum on the page as in the drawer, in doctor's words.
  const sum = (await page.locator('#health-help').textContent())!.replace(/\u00a0/g, ' ');
  expect(sum).toMatch(/^(\d+ problems?(, \d+ warnings?)?|\d+ warnings?, nothing blocking|Everything looks fine)\.$/);
  await expect(page.locator('section.drawer')).toContainText(sum.slice(1, -1));
  expect(await sideways(page)).toBe(0);
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
    expect(await sideways(page)).toBe(0);
    await undo.click();
    await expect(rows).toHaveCount(count);
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(before);
  } finally {
    if (readFileSync(file, 'utf8') !== before) writeFileSync(file, before);
  }
});

test('Settings → CI on a phone: Write file in Your workflow’s header, and the file shown scrolls nothing sideways; on Gates, neither do a gate’s odds', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, '/settings/ci', 'main#view #alerts .cifold');
  // The demo's repository has no workflow yet: Write file asks to add it.
  await expect(page.locator('#workflow header button', { hasText: 'Write file' })).toBeVisible();
  await page.locator('#workflow .wftog button[aria-controls="wfBox"]').click();
  await expect(page.locator('#wfBox pre.wfcode')).toBeVisible();
  expect(await sideways(page), 'Your workflow shown').toBe(0);
  // A gate's figures are a tab of their own, the CI tab holding none of them.
  await expect(page.locator('main#view #gates')).toHaveCount(0);
  await openPage(page, '/settings/gates', 'main#view #gates .gsays');
  await page.locator('#gates .xbtn').click();
  await expect(page.locator('#gates table.godds')).toBeVisible();
  expect(await sideways(page), 'the odds shown').toBe(0);
});

test('Settings → CI folds a part that is off to one line and each list behind its count, and opens them on a phone with nothing scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, '/settings/ci', 'main#view #alerts .cifold');
  // The demo's workflow has Fix on failure off: its header, what happens without it, and Show settings.
  const fix = page.locator('#fix-on-failure');
  await expect(fix.locator('.cioff .offnote')).toHaveText('Off: a failed check fails the build, and nobody opens a fix.');
  await expect(fix.locator('.alertgrid')).toBeHidden();
  const folded = await fix.evaluate((el) => el.getBoundingClientRect().height);
  await fix.getByRole('button', { name: 'Show settings' }).click();
  await expect(fix.locator('.alertgrid .prcard')).toBeVisible();
  await expect(fix.getByRole('button', { name: 'Hide settings' })).toHaveAttribute('aria-expanded', 'true');
  expect(await fix.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(folded * 3);
  // Each list opens from its name and count, the keyboard's Enter too.
  await expect(page.locator('main#view .cilist:visible')).toHaveCount(0);
  const needs = page.locator('#alerts .cimain .cifold > button');
  await expect(needs).toHaveText(/^It needs\s*\d+$/i);
  await needs.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#alerts .cimain .cilist')).toBeVisible();
  const shut = page.locator('main#view .cifold > button[aria-expanded="false"]');
  while (await shut.count()) await shut.first().click();
  await expect(page.locator('main#view .cilist:visible')).toHaveCount(5);
  expect(await sideways(page), 'every fold open').toBe(0);
  // Its switch opens a part too, with no line; off again, it folds.
  await fix.getByRole('button', { name: 'Hide settings' }).click();
  await expect(fix.locator('.alertgrid')).toBeHidden();
  await fix.locator('header .switch').click();
  await expect(fix.locator('.alertgrid .prcard')).toBeVisible();
  await expect(fix.locator('.cioff')).toHaveCount(0);
  await fix.locator('header .switch').click();
  await expect(fix.locator('.alertgrid')).toBeHidden();
});

test('a link to a gate’s kind opens Gates on it, the one CI’s address had too, and Gates leads to where an inconclusive golden is set', async ({ page }) => {
  // As a rule under Tests' table links, from a page of the dashboard: history's figures, the address the tab's own once read.
  const go = (hash: string) => page.evaluate((to) => void (location.hash = to), hash);
  await openPage(page, '/tests', 'main#view table.gt');
  await go('#/settings/gates?gate=baseline');
  await expect(page.locator('#gates select[aria-label="Window"]')).toBeVisible();
  await expect(page.locator('#gates header .seg button[aria-pressed="true"]')).toHaveText('fork · history');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/settings/gates');
  await expect(page.locator('main#view nav.stabs a[aria-current="page"]')).toHaveText('Gates');
  // From when Gates was CI's last panel, with the CI tab shown already: the same tab, on the kind it asks for.
  await page.locator('#gates header .seg button', { hasText: 'fork · gate' }).click();
  await expect(page.locator('#gates select[aria-label="Good"]')).toBeVisible();
  await go('#/settings/ci');
  await expect(page.locator('#workflow')).toBeVisible();
  await go('#/settings/ci?gate=baseline');
  await expect(page.locator('#gates select[aria-label="Window"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/settings/gates');
  // What an inconclusive golden does in CI is Your workflow's to set: Gates says it and leads there.
  const line = page.locator('#gates .setrow', { hasText: 'An inconclusive golden' });
  await expect(line.locator('.seg')).toHaveCount(0);
  await line.getByRole('link', { name: 'Settings → CI' }).click();
  await expect(page.locator('#workflow [aria-labelledby="inconclusive-name"] button[aria-pressed="true"]')).toHaveText('Fails');
});
