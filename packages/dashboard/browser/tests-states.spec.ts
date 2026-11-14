import { expect, test, type Page } from '@playwright/test';
import { gateResult, Store, unavailableReason, type StoredCheck } from '@shadowlap/engine';
import { goldenReports, type TestsAnswer } from '../src/golden-report.js';
import { testsView, type GoldenSource } from '../src/tests.js';
import { expectAccessible, openPage } from './dashboard.js';

/**
 * States of a golden Tests says that the demo store has none of, in a real browser: a golden the
 * provider left undecided, whose verdict names the provider, never a check that couldn't be judged;
 * and a golden whose pack can't be read since its last test, which says so over the result it had,
 * its report keeping Find breaking commit in its place, off, saying why. GET /api/tests is answered
 * by page.route with what the server builds from a store of the test's own.
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
