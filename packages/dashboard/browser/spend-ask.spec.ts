import { expect, test, type Page } from '@playwright/test';
import { demoId, openPage, seriousViolations } from './dashboard.js';

/**
 * Spending in Chromium over the demo store: a fork's row says its price and whether it starts at
 * once, and a press follows the threshold, starting with the estimate its drawer says or asking with
 * why in its footer, whose Change lands on the Spending row; Run repair asks on every setting; and the
 * row itself at 1440 and on a phone. The suite's dashboards share one Spending, so each page is held
 * to its threshold by answering its read (`page.route`), never by keeping one, and a press's job is
 * answered here too, so nothing runs live and the demo store gains no run.
 */

const MENU = '.pop[role="menu"]';
const DIALOG = '[role="dialog"][aria-modal="true"]';
const CARD = '.tip[role="tooltip"] .tc';
const RUN_LIVE = 'Run live from here';
const ID = 'cafebabecafebabe';

/** Holds the page to a threshold: dollars, 0 for Always ask, null for Never ask. */
const holdSpending = (page: Page, askAbove: number | null) =>
  page.route('**/api/user/spending', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { askAbove, set: true, problems: [] } }) : route.abort()));

/** Answers a fork's start as the server would, keeping the estimate the press sent, and lists the job once it has started. */
async function answerForks(page: Page) {
  const run = demoId('ticket');
  const sent: Array<Record<string, unknown>> = [];
  const job = (estimate: unknown) => ({ id: ID, kind: 'action', title: 'Forking', args: ['replay', run, '--diverge-at', '1'], worktree: null, runId: run, opensRun: true, startedAt: Date.now(), done: false, stopped: false, code: null, newRunId: null, lines: [], total: 0, ...(estimate ? { estimate } : {}) });
  await page.route(/\/api\/runs\/[^/]+\/actions$/, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    return route.fulfill({ status: 202, json: job(body.estimate) });
  });
  await page.route(/\/api\/jobs(\?.*)?$/, (route) => route.fulfill({ json: { jobs: sent.length ? [{ ...job(sent.at(-1)!.estimate), lines: undefined }] : [] } }));
  await page.route(new RegExp(`/api/jobs/${ID}(\\?.*)?$`), (route) => route.fulfill({ json: job(sent.at(-1)?.estimate) }));
  return { run, sent };
}

/** The fork menu on the run's page, and the card of its Run live row. */
async function runLiveCard(page: Page, run: string): Promise<string> {
  await openPage(page, `/run/${run}`, 'run');
  await page.locator('#forkBtn').click();
  const row = page.locator(`${MENU} [role="menuitem"]`, { hasText: RUN_LIVE });
  await row.hover();
  const card = page.locator(CARD);
  await expect(card).toHaveText(/ · (starts at once|asks first)$/);
  return (await card.textContent())!;
}

test('a fork priced at or under the threshold starts at once, its drawer saying the estimate its card said', async ({ page }) => {
  await holdSpending(page, 100);
  const { run, sent } = await answerForks(page);
  const card = await runLiveCard(page, run);
  expect(card).toMatch(/^≈\$[\d.,]+ · starts at once$/);
  await page.locator(`${MENU} [role="menuitem"]`, { hasText: RUN_LIVE }).click();
  await expect(page.locator('section.drawer')).toContainText(`running · ${card.split(' · ')[0]!}`);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.estimate).toMatchObject({ ceiling: false });
});

test('Always ask asks first, its footer saying why, and Change lands on the Spending row’s field', async ({ page }) => {
  await holdSpending(page, 0);
  const { run, sent } = await answerForks(page);
  expect(await runLiveCard(page, run)).toMatch(/^≈\$[\d.,]+ · asks first$/);
  await page.locator(`${MENU} [role="menuitem"]`, { hasText: RUN_LIVE }).click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Always asks · Change');
  expect(await seriousViolations(page)).toEqual([]);
  expect(sent).toHaveLength(0);
  await dialog.getByRole('link', { name: 'Change Spending' }).click();
  await page.waitForSelector('#spending');
  await expect(page.locator('#spending')).toContainText('Always ask before spending.');
  await expect(page.locator('#askAbove')).toBeFocused();
  expect(sent).toHaveLength(0);
});

test('Never ask starts a priced fork at once, and Run repair still asks', async ({ page }) => {
  await holdSpending(page, null);
  const { run, sent } = await answerForks(page);
  expect(await runLiveCard(page, run)).toMatch(/^≈\$[\d.,]+ · starts at once$/);
  await page.locator(`${MENU} [role="menuitem"]`, { hasText: RUN_LIVE }).click();
  await expect(page.locator('section.drawer')).toContainText('running · ≈$');
  expect(sent).toHaveLength(1);
  // Run repair asks on every setting, so its footer says nothing of the threshold.
  await openPage(page, `/fixes/${demoId('emailFix')}`, 'fix');
  const repair = page.locator('.ph .actions button', { hasText: 'Run repair' });
  await expect(repair.first()).toBeVisible();
  await repair.first().click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText('Change');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
  [360, 780],
] as const) {
  test(`the Spending row at ${width} px: its four picks fit, wrapping on a phone, with no serious axe violation`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await holdSpending(page, 0.5);
    await openPage(page, '/settings/project', '#spending');
    const row = page.locator('#spending');
    await expect(row).toContainText('Ask before spending more than $0.50.');
    const picks = row.locator('.seg button');
    await expect(picks).toHaveText(['Always ask', '$0.50', '$2', 'Never ask']);
    const boxes = await picks.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ right: r.right, top: r.top })));
    const room = await row.evaluate((el) => ({ right: Math.min(el.getBoundingClientRect().right, document.documentElement.clientWidth), scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    for (const b of boxes) expect(b.right).toBeLessThanOrEqual(room.right + 0.5);
    // Wide, the picks share one line beside the field; on a phone they wrap inside the row, and the
    // page doesn't scroll sideways at 390 (at 360 the top bar alone is wider, which is the shell's).
    if (width === 1440) expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(1);
    if (width !== 360) expect(room.scroll).toBeLessThanOrEqual(room.width);
    expect(await seriousViolations(page)).toEqual([]);
  });
}
