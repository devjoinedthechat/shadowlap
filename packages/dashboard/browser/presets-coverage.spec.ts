import { expect, test, type Page, type Request } from '@playwright/test';
import { dash, openPage, RESET_RETRY, seriousViolations } from './dashboard.js';

/**
 * Error-path presets and production coverage in Chromium over the demo store: Tests › Not covered's
 * rows in the keys' reach (j walks into them after the goldens, Enter opens a row's details, Tab goes
 * to its count and then its pack, the cards in its lines taking no focus) with their actions as wide
 * as the widest, and the presets' results
 * on their recording's page at a desk's widths and a phone's, every cell holding its words and the
 * page never scrolling sideways.
 */

const ROWS = 'main#view #notcovered ul.covl > li';
const inFocus = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-rowkey') ?? document.activeElement?.className ?? '');

test('Not covered’s rows: j walks into them after the goldens, Enter opens a row’s details, and Tab goes to its count, then its pack', async ({ page }) => {
  await openPage(page, '/tests', ROWS);
  const keys = await page.locator(ROWS).evaluateAll((rows) => rows.map((r) => r.getAttribute('data-rowkey') ?? ''));
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) expect(key).toMatch(/^cov:[0-9a-f]{16}$/);
  // j walks Tests' goldens first, then Not covered's rows, in the page's order.
  let key = '';
  for (let i = 0; i < 40 && !key.startsWith('cov:'); i++) {
    await page.keyboard.press('j');
    key = await inFocus(page);
  }
  expect(key).toBe(keys[0]);
  const row = page.locator(`${ROWS}[data-rowkey="${key}"]`);
  await expect(row).toHaveClass(/krow/);
  await expect(row.locator('.cvx')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(row.locator('.cvx')).toBeVisible();
  await expect(row.locator('button.cvn')).toHaveAttribute('aria-expanded', 'true');
  // The row's first Tab stop is its count, the toggle of its details; the next its pack. A card in its lines takes none.
  await row.focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.classList.contains('cvn') ?? false)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('.cvacts') !== null)).toBe(true);
  await expect(page.locator(':focus')).toHaveText(/^Pack (as golden|with checks…)$/);
  // So is a row whose behaviour the agent no longer does, and one whose path folds steps: their cards take no
  // focus. j walks to the row from the first, as a row takes focus only once the keys have been on it.
  const stops = async (has: string) => {
    const want = await page.locator(`${ROWS}:has(${has})`).first().getAttribute('data-rowkey');
    await row.focus();
    for (let i = 0; i < keys.length && (await inFocus(page)) !== want; i++) await page.keyboard.press('j');
    expect(await inFocus(page)).toBe(want);
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('Tab');
      seen.push(await page.evaluate(() => (document.activeElement?.classList.contains('cvn') ? 'count' : document.activeElement?.closest('.cvacts') ? 'pack' : (document.activeElement?.className ?? ''))));
    }
    return seen;
  };
  await expect(page.locator(`${ROWS}:has(.cvst)`).first()).toBeVisible();
  expect(await stops('.cvst')).toEqual(['count', 'pack']);
  if (await page.locator(`${ROWS}:has(.cvmore)`).count()) expect(await stops('.cvmore')).toEqual(['count', 'pack']);
  // Every row's action is as wide as the widest, so the counts and dates beside them line up.
  const edges = await page.locator(`${ROWS} > .cvacts`).evaluateAll((acts) => acts.map((a) => Math.round(a.getBoundingClientRect().left)));
  expect(new Set(edges).size).toBe(1);
  expect(await seriousViolations(page)).toEqual([]);
});

/** The recording the demo's error-path presets ran on: the in-limit refund golden's, else the first the API gives. */
async function presetsRecording(page: Page): Promise<string> {
  const { origin, token } = dash();
  const view = (await (await page.request.get(`${origin}/api/chaos`, { headers: { 'x-shadowlap-token': token }, ...RESET_RETRY })).json()) as { matrices: Array<{ runId: string; golden: string | null }> };
  const m = view.matrices.find((x) => x.golden === 'goldens/refund-in-limit') ?? view.matrices[0];
  if (!m) throw new Error('the demo store has no error-path presets');
  return m.runId;
}

const PANEL = 'main#view section.rmxp[data-kind="presets"]';

/** The page's requests to the API still out: a run's page has settled, its call picked, once none is. */
function apiOut(page: Page): Set<Request> {
  const out = new Set<Request>();
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) out.add(r);
  });
  page.on('requestfinished', (r) => out.delete(r));
  page.on('requestfailed', (r) => out.delete(r));
  return out;
}

test('the presets’ results on their recording fit at 1440, 1180, 1024 and 390: no cell runs past its column, the page never scrolls sideways, and axe finds nothing', async ({ page }) => {
  const id = await presetsRecording(page);
  const out = apiOut(page);
  for (const width of [1440, 1180, 1024, 390]) {
    // A page loaded at that width, never the last one's: its results stay open across a link to the same run.
    await page.goto('about:blank');
    // The last width's page has gone, and a poll it had out goes with it, never finishing nor failing.
    out.clear();
    await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
    await openPage(page, `/run/${id}`, 'run');
    // The page has picked the call it opens on, which gives the inspector back, and read what that call shows; two frames are drawn since.
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/run\/[^/]+\/\d+$/);
    await expect.poll(() => out.size, { message: 'the page’s requests to the API to come back', timeout: 60_000, intervals: [25] }).toBe(0);
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await page.locator('button[data-act="results"][data-which="presets"]').first().click();
    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.locator(`${PANEL} .rmx-c`).first()).toBeVisible();
    const over = await page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(`${sel} .rmx-c`)].filter((c) => c.scrollWidth > c.clientWidth + 0.5).map((c) => c.textContent), PANEL);
    expect(over, `cells that run past their column at ${width}`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `sideways scroll at ${width}`).toBeLessThanOrEqual(0);
    expect(await seriousViolations(page), `axe at ${width}`).toEqual([]);
  }
});
