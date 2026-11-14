import { expect, test, type Page } from '@playwright/test';
import { gateResult, Store, unavailableReason, type StoredCheck } from '@shadowlap/engine';
import { goldenReports, type TestsAnswer } from '../src/golden-report.js';
import { testsView, type GoldenSource } from '../src/tests.js';
import { dash, expectAccessible, openPage, RESET_RETRY, seriousViolations } from './dashboard.js';
import { DIALOG } from './routes.js';

/**
 * States of a golden Tests says that the demo store has none of, in a real browser: a golden the
 * provider left undecided, whose verdict names the provider, never a check that couldn't be judged;
 * and a golden whose pack can't be read since its last test, which says so over the result it had,
 * its report keeping Find breaking commit in its place, off, saying why. GET /api/tests is answered
 * by page.route with what the server builds from a store of the test's own. Run tests on… over the
 * demo's goldens starts a test of those picked, the job answered by page.route so nothing runs.
 */

// A route may still be reading the server's answer as a test ends; the page's close takes it away, and that is no failure.
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

const check = (label: string, status: StoredCheck['status'], detail?: string): StoredCheck => ({ label, ok: status === 'passed', status, ...(detail ? { detail } : {}) }) as StoredCheck;
const DOWN = { callNo: 3, provider: 'anthropic', status: 529, error: null, retryAfterMs: null, reason: 'HTTP 529 from anthropic at call #3', early: true };
const SPRT = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 20 };

/**
 * Tests over two goldens: `overloaded`, a gated fork golden the provider stopped while its gate was
 * open, and, with `broken`, `refunds`, which failed a check and whose pack has lost its run.json since.
 */
function answer(o: { broken: boolean }): TestsAnswer {
  const store = Store.open(':memory:');
  const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'abc1234' });
  const command = { argv: ['python', 'refund_agent.py'], cwd: '/work/shop' };
  const goldens: GoldenSource[] = [];
  const add = (name: string, over: Partial<GoldenSource>, result: Omit<Parameters<Store['addTestResult']>[0], 'sessionId' | 'golden' | 'runId'>) => {
    const recording = store.createRun({ mode: 'record', command });
    const replay = store.createRun({ mode: 'replay', command, meta: { test: { golden: `goldens/${name}`, session: s.sessionId } } });
    store.addTestResult({ sessionId: s.sessionId, golden: `goldens/${name}`, runId: replay.runId, ...result });
    goldens.push({ path: `goldens/${name}`, runId: recording.runId, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: result.data?.checks?.map((c) => c.label) ?? [], ...over });
  };
  add('overloaded', { mode: 'fork', gate: SPRT }, { ok: false, failure: 'inconclusive', reason: unavailableReason(3, DOWN), data: { mode: 'fork', verdict: 'inconclusive', upstreamRequests: 5, attempts: { total: 2, passed: 2, required: null, runs: [], unavailable: 3 }, gate: gateResult(SPRT, [true, true], { decision: 'continue' }) } });
  if (o.broken) add('refunds', { runId: null, error: 'no run.json: not a pack' }, { ok: false, failure: 'check', reason: 'check failed: issue_refund called 1 time, but called 0 times', data: { mode: 'replay', verdict: 'failed', calls: { total: 8, replayed: 8, live: 0, blocked: 0, stubbed: 0 }, checks: [check('issue_refund called 1 time', 'failed', 'called 0 times')] } });
  store.finishTestSession(s.sessionId, { passed: 0, failed: o.broken ? 1 : 0, upstreamRequests: 5 });
  const view = testsView(store, goldens, { folder: 'goldens' });
  const reports = goldenReports(view, { store, goldens, normalizers: [], project: '/work/shop' });
  store.close();
  return { ...view, reports };
}

async function openTests(page: Page, view: TestsAnswer): Promise<void> {
  await page.route((url) => url.pathname === '/api/tests', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: view }) : route.continue()));
  await openPage(page, '/tests', 'main#view table.gt');
}

test('a golden the provider left undecided leads the verdict as the provider’s, never as a check that couldn’t be judged', async ({ page }) => {
  await openTests(page, answer({ broken: false }));
  const verdict = page.locator('main#view .verdict.tv');
  await expect(verdict.locator('.vw')).toHaveText('inconclusive');
  await expect(verdict.locator('h2')).toContainText('overloaded inconclusive: the provider was unavailable');
  await expect(verdict).not.toContainText('a check could not be judged');
});

test('a golden whose pack can’t be read says so over its last result, and its report keeps Find breaking commit off, saying why, with no serious axe violation', async ({ page }) => {
  await openTests(page, answer({ broken: true }));
  const row = page.locator('main#view table.gt tbody tr[data-rowkey]').filter({ has: page.locator('code.gn', { hasText: /^refunds$/ }) });
  await expect(row.locator('td.glast .st')).toHaveText('can’t be read');
  await expect(row.locator('td.glast .st')).toHaveClass(/\berr\b/);
  await expect(row.locator('td.glast .rsub')).toHaveText("can't be read: no run.json: not a pack");
  const toggle = page.locator('main#view button.grptog[aria-controls="grp-refunds"]');
  await toggle.click();
  const find = page.locator('main#view section[id="report-refunds"] .actions button', { hasText: 'Find breaking commit…' });
  await expect(find).toHaveAttribute('aria-disabled', 'true');
  await expect(find).toHaveAttribute('data-why', 'The golden’s pack can’t be read: no run.json: not a pack');
  // A press says why in a toast, and the button keeps the focus.
  await find.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').filter({ hasText: 'The golden’s pack can’t be read: no run.json: not a pack' })).toBeVisible();
  await expect(find).toBeFocused();
  await expectAccessible(page);
});

test('Run tests on… picks goldens, its command and price following the picks, and starts a test of those alone, with no serious axe violation', async ({ page }) => {
  // The job the dialog starts is answered here, ended, so nothing runs.
  const sent: Array<Record<string, unknown>> = [];
  const job = { id: 'feedfacefeedfac1', kind: 'test', title: 'Running tests', args: [], worktree: null, runId: null, opensRun: false, startedAt: Date.now(), done: true, stopped: false, code: 0, newRunId: null, lines: [], total: 0 };
  await page.route(/\/api\/jobs$/, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 202, json: job });
  });
  await page.route(new RegExp(`/api/jobs/${job.id}(\\?.*)?$`), (route) => route.fulfill({ json: job }));
  const { origin, token } = dash();
  const rows = ((await (await page.request.get(`${origin}/api/tests`, { headers: { 'x-shadowlap-token': token }, ...RESET_RETRY })).json()) as TestsAnswer).rows.filter((r) => !r.error);
  await openPage(page, '/tests', 'main#view table.gt');
  await page.locator('main#view .ph .btn', { hasText: 'Run tests on…' }).click();
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('.togchips button')).toHaveText(rows.map((r) => r.name));
  for (const b of await dialog.locator('.togchips button').all()) await expect(b).toHaveAttribute('aria-pressed', 'false');
  // Picked out of order, they run in the goldens' order.
  const [first, second] = [rows[0]!, rows[1]!];
  await dialog.locator('.togchips button', { hasText: new RegExp(`^${second.name}$`) }).click();
  await dialog.locator('.togchips button', { hasText: new RegExp(`^${first.name}$`) }).click();
  await expect(dialog.locator('.cmdline')).toHaveText(`$shadowlap test ${first.path} ${second.path}`);
  await expect(dialog.locator('.dlg-ok')).not.toHaveAttribute('data-why', /./);
  expect(await seriousViolations(page)).toEqual([]);
  await dialog.locator('.dlg-ok').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ kind: 'test', goldens: [first.path, second.path] });
});
