import { expect, test, type Page } from '@playwright/test';
import { demoId, openPage } from './dashboard.js';

/**
 * Fixes as a to-do list in Chromium over the demo store: j and k over its rows, Enter opening a fix and
 * Esc coming back to its row, a fix's failing runs opening under Failed, the newest unblamed run's id
 * under the pointer rather than its row's link, the focus on a row's next step when the job it started
 * ends, and no sideways scroll at a phone's or a tablet's width.
 */

/** A row as drawn: the bars drawn while the list loads are rows too, with no key. */
const ROWS = 'main#view .pslist .psrow[data-rowkey]';
const openFixes = (page: Page) => openPage(page, '/fixes', ROWS);
const hash = (page: Page) => page.evaluate(() => location.hash);
const keys = (page: Page) => page.locator(ROWS).evaluateAll((rows) => rows.map((r) => r.getAttribute('data-rowkey') ?? ''));
/** The row the focus is in. */
const rowInFocus = (page: Page) => page.evaluate(() => document.activeElement?.closest('[data-rowkey]')?.getAttribute('data-rowkey') ?? document.activeElement?.tagName ?? '');

/** A demo fix's row key: runs.json names the fix by the start of its id. */
async function fixKey(page: Page, name: string): Promise<string> {
  const key = (await keys(page)).find((k) => k.startsWith(`#/fixes/${demoId(name)}`));
  expect(key).toBeTruthy();
  return key!;
}

/** j or k until the row `key` is the one in focus, from the row in focus or, with none, from above the first. */
async function walkTo(page: Page, key: string): Promise<void> {
  const all = await keys(page);
  const to = all.indexOf(key);
  expect(to).toBeGreaterThanOrEqual(0);
  const now = await page.locator(`${ROWS}.krow`).getAttribute('data-rowkey', { timeout: 500 }).catch(() => null);
  const from = now === null ? -1 : all.indexOf(now);
  for (let i = from; i !== to; i += to > from ? 1 : -1) await page.keyboard.press(to > from ? 'j' : 'k');
  await expect(page.locator(`${ROWS}.krow`)).toHaveAttribute('data-rowkey', key);
}

test('j and k walk Fixes, Enter opens a fix with its heading in focus, and Esc comes back to its row', async ({ page }) => {
  await openFixes(page);
  const all = await keys(page);
  expect(all.length).toBeGreaterThan(1);
  await page.keyboard.press('j');
  await expect(page.locator(`${ROWS}.krow`)).toHaveAttribute('data-rowkey', all[0]!);
  await page.keyboard.press('j');
  await expect(page.locator(`${ROWS}.krow`)).toHaveAttribute('data-rowkey', all[1]!);
  await page.keyboard.press('k');
  await expect(page.locator(`${ROWS}.krow`)).toHaveAttribute('data-rowkey', all[0]!);
  const fix = await fixKey(page, 'emailFix');
  await walkTo(page, fix);
  expect(await rowInFocus(page)).toBe(fix);
  await page.keyboard.press('Enter');
  await page.locator('main#view .stepper').waitFor();
  expect(await hash(page)).toBe(fix);
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
  await page.keyboard.press('Escape');
  await page.locator(ROWS).first().waitFor();
  await expect.poll(() => rowInFocus(page)).toBe(fix);
  await expect(page.locator(`${ROWS}.krow`)).toHaveAttribute('data-rowkey', fix);
});

test('a fix’s failing-runs link opens Runs under Failed', async ({ page }) => {
  await openFixes(page);
  const fix = await fixKey(page, 'refundFix');
  const link = page.locator(`${ROWS}[data-rowkey="${fix}"] .rs a.dlink`);
  await expect(link).toHaveText(/^\d+ failing runs?$/);
  await link.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => hash(page)).toBe('#/runs?types=failed');
  await page.locator('main#view table tbody tr').first().waitFor();
});

// Opened at its width: a window narrowed under an open page slides the sidebar out over it for a moment.
for (const width of [1440, 390])
  test(`the newest unblamed run’s id sits above its row’s link, so the pointer gets its about line, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixes(page);
    const id = page.locator(`${ROWS}[data-rowkey="unblamed"] .rs code.rnm`);
    await expect(id).toHaveAttribute('title', /\S/);
    await id.scrollIntoViewIfNeeded();
    const hit = () =>
      id.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return at && (at === el || el.contains(at)) ? 'the id' : (at?.className ?? null);
      });
    // Asked again until it holds: the row's link would cover the id for good, a page still settling only for a moment.
    await expect.poll(hit).toBe('the id');
  });

test('a job started from a row’s next step hands the focus to that row’s step when it ends', async ({ page }) => {
  const email = demoId('emailFix');
  let fixId = '';
  const again = { key: 'blame-again', label: 'Run blame again', command: 'shadowlap blame --again', use: 'reads', stopped: true, gate: null, soFar: 4, lastGood: null };
  // The list as the server answers it, the fix's step Run blame again; no estimate, so the step asks.
  await page.route(/\/api\/fixes(\?.*)?$/, async (route) => {
    const body = (await (await route.fetch()).json()) as { fixes: Array<{ fixId: string }> };
    await route.fulfill({ json: { ...body, fixes: body.fixes.map((f) => (f.fixId.startsWith(email) ? { ...f, next: again } : f)) } });
  });
  await page.route(/\/api\/fixes\/[^/]+\/estimates/, (route) => route.fulfill({ json: { repair: null, blameAgain: null, blameStronger: null, verify: {} } }));
  const job = (done: boolean) => ({ id: 'rowstep', kind: 'blame', title: 'Blaming', args: ['blame'], worktree: { use: 'reads', doing: 'a blame is running your agent from your working tree', folder: null }, runId: null, fixId, opensRun: false, startedAt: Date.now() - 1000, endedAt: done ? Date.now() : null, done, stopped: false, code: done ? 0 : null, newRunId: null, runs: [], links: [], files: [], total: 0, lines: [], project: { id: 'support-agent', name: 'support-agent' } });
  const sent: unknown[] = [];
  let ended = false;
  // The start answered here, so no blame runs: the job ends when the test ends it.
  await page.route('**/api/jobs', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: job(false) });
  });
  await page.route('**/api/jobs/rowstep*', (route) => route.fulfill({ json: job(ended) }));
  await openFixes(page);
  const fix = await fixKey(page, 'emailFix');
  fixId = fix.slice('#/fixes/'.length);
  const step = page.locator(`${ROWS}[data-rowkey="${fix}"] .psn .btn`);
  await expect(step).toHaveText('Run blame again');
  await step.focus();
  await page.keyboard.press('Enter');
  await page.locator('.dialog .dlg-ok').click();
  await expect.poll(() => sent).toEqual([expect.objectContaining({ kind: 'blame', fixId, again: true })]);
  // Its drawer follows it once the server has answered, by when the page has noted the row it started from.
  await expect(page.locator('.drawer #jtitle')).toHaveText('Blaming');
  // The step's control redrawn while the job ran, as the list's answer redraws it: the focus is lost.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await rowInFocus(page)).toBe('BODY');
  ended = true;
  await expect.poll(() => rowInFocus(page)).toBe(fix);
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Run blame again');
});

for (const width of [390, 1024, 1180])
  test(`no sideways scroll at ${width}px, every row’s steps in view`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixes(page);
    const over = await page.evaluate(() => {
      const doc = document.scrollingElement!;
      const list = document.querySelector<HTMLElement>('main#view .pslist')!;
      const rows = [...list.querySelectorAll<HTMLElement>('.psrow')].filter((r) => r.getBoundingClientRect().right > window.innerWidth + 0.5);
      return { page: doc.scrollWidth - doc.clientWidth, list: list.scrollWidth - list.clientWidth, rows: rows.length };
    });
    expect(over).toEqual({ page: 0, list: 0, rows: 0 });
  });
