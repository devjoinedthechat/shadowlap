import { expect, test, type Page } from '@playwright/test';
import { demoId, openPage, patched } from './dashboard.js';

/**
 * Several runs recording at once: the Overview's Watch live names each run by its short id, as the
 * sidebar does, and keeps them beside the title at a laptop's widths, the rest counted in a link to
 * Runs; one recording keeps Watch live's words. The top bar's chip counts them, its card naming
 * each, and leads to Runs on every run recording. The demo records nothing: the server's answers
 * say these four are recording.
 */

const NAMES = ['refundBug', 'good', 'ticket', 'clean'];
const ids = () => NAMES.map((n) => demoId(n));
const short = (id: string) => id.slice(0, 10);

/** The Overview's summary with these runs recording, newest first, as the server lists them. */
async function recordingOnOverview(page: Page, runIds: string[]): Promise<void> {
  await page.route('**/api/summary?*', (route) =>
    patched<{ today: Record<string, unknown> }>(route, (s) => ({
      ...s,
      today: { ...s.today, recording: runIds.map((runId, i) => ({ runId, command: 'node refund_agent.mjs', calls: i + 1, startedAt: Date.now() - i * 60_000, about: { text: `Ticket T-88${i}: the order arrived damaged`, from: 'user' } })) },
    })),
  );
}

/** Where a box is, in the page. */
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

/** Watch live for each run recording that has room beside the title, each naming its run, the rest counted on the link to Runs. */
async function besideTheTitle(page: Page, runIds: string[], at: string): Promise<number> {
  const buttons = page.locator('main#view .ph .actions a.livebtn');
  const shown = await buttons.count();
  expect(shown, `${at}: at least one Watch live`).toBeGreaterThanOrEqual(1);
  // Each says which run it is: its short id, and its calls.
  expect(await buttons.locator('.lt code.rnm').allTextContents(), at).toEqual(runIds.slice(0, shown).map(short));
  for (let i = 0; i < shown; i++) await expect(buttons.nth(i)).toHaveAccessibleName(`Watch live ${short(runIds[i]!)} ${i + 1} call${i ? 's' : ''}`);
  await expect(page.locator('main#view .ph .actions a.btn:not(.livebtn)')).toHaveText(`${runIds.length - shown} more recording`);
  // Beside the title, on its line, as one recording's is: never under it, on the facts.
  const [head, actions, facts] = await Promise.all([box(page, 'main#view .ph > .phl'), box(page, 'main#view .ph > .actions'), box(page, 'main#view .pfacts')]);
  expect(Math.abs(actions.y - head.y), `${at}: the buttons on the title’s line`).toBeLessThanOrEqual(1);
  expect(actions.y + actions.height, `${at}: the buttons above the facts`).toBeLessThanOrEqual(facts.y);
  const tops = await buttons.evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
  expect(tops, `${at}: one row of buttons`).toBe(1);
  return shown;
}

for (const width of [1180, 1440]) {
  test(`at ${width}px the Overview names each run recording on its Watch live, beside the title, the rest counted on a link to Runs`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const runIds = ids();
    await recordingOnOverview(page, runIds);
    await openPage(page, '/', 'main#view .ph .actions .livebtn');
    await besideTheTitle(page, runIds, `${width}px`);
  });
}

test('Watch live fits beside the title again as the window narrows and widens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const runIds = ids();
  await recordingOnOverview(page, runIds);
  await openPage(page, '/', 'main#view .ph .actions .livebtn');
  const wide = await besideTheTitle(page, runIds, '1440px');
  await page.setViewportSize({ width: 1180, height: 900 });
  await expect.poll(() => page.locator('main#view .ph .actions a.livebtn').count()).toBeLessThan(wide);
  await besideTheTitle(page, runIds, 'narrowed to 1180px');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.locator('main#view .ph .actions a.livebtn').count()).toBe(wide);
});

test('one recording keeps Watch live’s words, its calls beside them', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  const [one] = ids();
  await recordingOnOverview(page, [one!]);
  await openPage(page, '/', 'main#view .ph .actions .livebtn');
  const live = page.locator('main#view .ph .actions a.livebtn');
  await expect(live).toHaveCount(1);
  await expect(live.locator('.lt')).toHaveText('Watch live');
  await expect(live.locator('code')).toHaveCount(0);
  await expect(live).toHaveAttribute('href', `#/run/${one!}`);
});

test('the top bar’s chip counts the runs recording, names each on its card, and opens Runs on every run recording', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const runIds = ids();
  // The run list says they are recording; no change feed says otherwise.
  await page.route('**/api/runs', (route) => patched<{ runs: Array<{ runId: string; status: string }> }>(route, (b) => ({ ...b, runs: b.runs.map((r) => (runIds.includes(r.runId) ? { ...r, status: 'running' } : r)) })));
  await openPage(page, '/tests', 'main#view .ph');
  const chip = page.locator('header.top a.livechip');
  await expect(chip).toHaveText('4 recording');
  const card = JSON.parse((await chip.getAttribute('data-tip'))!) as { t: string; rows: Array<[string, string, string]> };
  expect(card.t).toBe('4 runs recording');
  expect(card.rows.map((r) => r[0]).sort()).toEqual(runIds.map(short).sort());
  await chip.hover();
  await expect(page.locator('.tip')).toContainText('4 runs recording');
  await chip.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/runs?q=status:live');
});
