import { expect, test, type Page } from '@playwright/test';
import { openPage, RESET_RETRY, seriousViolations } from './dashboard.js';

/**
 * Dismiss on the Overview's Needs a look in Chromium over the demo store: the × on advice, shown on
 * focus, Tab reaching it after the row's link and its step, Enter putting the row away under its
 * group's Dismissed (n) with the focus on the row after it, else on Dismissed (n), ⌘Z bringing it
 * back with the focus on it, and no serious axe violation with the × shown and a fold open, on a
 * laptop or a phone. The store's writes are answered here, so the shared demo store is never
 * written: the page holds what it shows, its answers' counter ahead of any list the server sends.
 */

const ROWS = 'main#view .attn .arow';
const LOCAL = `${ROWS}[data-rowkey="attn:local"]`;
const COVERAGE = `${ROWS}[data-rowkey^="attn:coverage:"]`;
const fold = (page: Page, group: string) => page.locator(`main#view [data-fold="${group}"]`);

test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

interface Sent {
  method: string;
  key: string;
  facts?: string[];
}

/** Answers Dismiss and Restore here, never reaching the store, and keeps what each sent. */
async function answerWrites(page: Page): Promise<Sent[]> {
  const sent: Sent[] = [];
  let n = 1_000_000;
  await page.route(/\/api\/needs-look\/dismissals(\/[^/?]+)?(\?.*)?$/, (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as { key: string; facts: string[] };
      sent.push({ method: 'POST', key: body.key, facts: body.facts });
      return route.fulfill({ json: { key: body.key, facts: body.facts, was: null, dismissals: ++n } });
    }
    const key = decodeURIComponent(new URL(req.url()).pathname.split('/').pop()!);
    sent.push({ method: req.method(), key });
    return route.fulfill({ json: { key, restored: true, dismissals: ++n } });
  });
  return sent;
}

/**
 * Takes the step away from the rows whose key starts with `prefix` in the summary the server answers,
 * so each says Open →: every advice row the demo store has carries one (Pack as golden, Push local runs).
 */
async function withoutStep(page: Page, prefix: string): Promise<void> {
  await page.route(/\/api\/summary(\?.*)?$/, async (route) => {
    const body = (await (await route.fetch(RESET_RETRY)).json()) as { needsLook: { items: Array<{ key: string }> } };
    const items = body.needsLook.items.map((r) => (r.key.startsWith(prefix) ? { ...r, step: null } : r));
    await route.fulfill({ json: { ...body, needsLook: { ...body.needsLook, items } } });
  });
}

/** Where the focus is: its row, or the group whose Dismissed (n) it is on; whether it is on the row's link; and its name. */
const focusAt = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    const row = a?.closest('[data-rowkey]')?.getAttribute('data-rowkey');
    const at = row ?? (a?.getAttribute('data-fold') ? `fold:${a.getAttribute('data-fold')}` : (a?.tagName ?? ''));
    return [at, !!a?.matches('a.at'), a?.getAttribute('aria-label') ?? a?.textContent?.trim() ?? ''] as const;
  });

/** What takes the focus once `row` is put away: the row after it in its group, else its group's Dismissed (n). */
const after = (page: Page, row: string) =>
  page.locator(row).evaluate((x) => {
    const next = x.nextElementSibling;
    return next?.matches('.arow') && next.getAttribute('data-agrp') === x.getAttribute('data-agrp') ? next.getAttribute('data-rowkey') : `fold:${x.getAttribute('data-agrp')}`;
  });

for (const width of [1440, 390]) {
  test(`Dismiss has no serious or critical axe violation with its × shown and a Dismissed (n) open, at ${width}px`, async ({ page }) => {
    const sent = await answerWrites(page);
    await page.setViewportSize({ width, height: 900 });
    await openPage(page, '/', 'main#view .ovg');
    const cross = page.locator(`${LOCAL} .adis`);
    await cross.focus();
    await expect(cross).toHaveCSS('opacity', '1');
    expect(await seriousViolations(page)).toEqual([]);
    await cross.click();
    await expect(fold(page, 'housekeeping')).toHaveText('Dismissed (1)');
    await fold(page, 'housekeeping').click();
    await expect(fold(page, 'housekeeping')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`${LOCAL}.off .ast .btn`)).toHaveText('Restore');
    expect(await seriousViolations(page)).toEqual([]);
    expect(sent.map((s) => [s.method, s.key])).toEqual([['POST', 'local']]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });
}

test('Tab reaches a row’s × after its link and its step, Enter puts the row away with the focus after it, and ⌘Z brings it back', async ({ page }) => {
  const sent = await answerWrites(page);
  await openPage(page, '/', 'main#view .ovg');
  const named = await page.locator(`${LOCAL} .adis`).getAttribute('aria-label');
  expect(named).toMatch(/^Dismiss: \d+ runs? (is|are) only on this machine$/);
  const next = await after(page, LOCAL);
  await page.locator(`${LOCAL} a.at`).focus();
  const path = [];
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Tab');
    path.push(await focusAt(page));
  }
  expect(path).toEqual([
    ['attn:local', false, 'Push local runs'],
    ['attn:local', false, named],
  ]);
  await expect(page.locator(`${LOCAL} .adis`)).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(page.locator(LOCAL)).toHaveCount(0);
  await expect(fold(page, 'housekeeping')).toHaveText('Dismissed (1)');
  expect((await focusAt(page))[0]).toBe(next);
  expect(sent).toEqual([{ method: 'POST', key: 'local', facts: expect.any(Array) }]);
  expect(sent[0]?.facts?.length).toBeGreaterThan(0);
  await expect(page.locator('.toast')).toContainText('Dismissed until it changes');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator(LOCAL)).toHaveCount(1);
  await expect.poll(() => focusAt(page).then(([at, link]) => [at, link])).toEqual(['attn:local', true]);
  await expect(fold(page, 'housekeeping')).toHaveCount(0);
  expect(sent.map((s) => [s.method, s.key])).toEqual([
    ['POST', 'local'],
    ['DELETE', 'local'],
  ]);
});

test('Tab goes from a row’s link straight to its × where its step is Open →, which takes no focus', async ({ page }) => {
  const sent = await answerWrites(page);
  await withoutStep(page, 'attn:coverage:');
  await openPage(page, '/', 'main#view .ovg');
  const key = await page.locator(COVERAGE).getAttribute('data-rowkey');
  const named = await page.locator(`${COVERAGE} .adis`).getAttribute('aria-label');
  expect(named).toMatch(/^Dismiss: /);
  await expect(page.locator(`${COVERAGE} .ast`)).toHaveText('Open →');
  const next = await after(page, COVERAGE);
  await page.locator(`${COVERAGE} a.at`).focus();
  await page.keyboard.press('Tab');
  expect(await focusAt(page)).toEqual([key, false, named]);
  await page.keyboard.press('Enter');
  await expect(page.locator(COVERAGE)).toHaveCount(0);
  await expect(fold(page, 'tests')).toHaveText('Dismissed (1)');
  expect((await focusAt(page))[0]).toBe(next);
  expect(sent.map((s) => [s.method, s.key])).toEqual([['POST', 'coverage']]);
});
