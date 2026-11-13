import { expect, type Page } from '@playwright/test';
import { gateResult, Store, type StoredCheck } from '@shadowlap/engine';
import { goldenReports, type TestsAnswer } from '../src/golden-report.js';
import { testsView, type GoldenSource } from '../src/tests.js';
import { evidenceWords } from '../src/tests-evidence.js';
import type { DivergenceView, TestEvidence } from '../ui/types.js';
import { dash } from './dashboard.js';

/** A rule Add normalizer and update adds for a golden, as `newRules` gives it: the `normalize add` arguments. */
const rule = (field: string): string[] => ['normalize', 'add', '--kind', 'api', '--path', `$.body.${field}`, '--replace', `<${field}>`];

/** The agent's last lines as a crashed replay keeps them: a Python traceback, its frame in the agent's own code. */
// A library's frame past the agent's own, its site-packages path a long word, as real tracebacks have: the box wraps it, never scrolls.
const PY_TAIL = ['Issuing the refund for order 8f3a.', 'Traceback (most recent call last):', '  File "/work/shop/refund_agent.py", line 141, in issue_refund', '    log.info("refund %s of %s", refund["refund_id"], order["total"])', '  File "/work/shop/.venv/lib/python3.12/site-packages/structlog/processors/formatting.py", line 77, in format_order', '    return record["order"]["total"]', "KeyError: 'total'"].join('\n');
const TWICE = 'send_email called at most 1 time';
const check = (label: string, status: StoredCheck['status'], detail?: string): StoredCheck => ({ label, ok: status === 'passed', status, ...(detail ? { detail } : {}) }) as StoredCheck;

/**
 * Two goldens the demo has none of, as GET /api/tests answers them, each with its report built by
 * golden-report.ts from a store of its own: `refund-crash`, a replay whose agent died of a KeyError at
 * call 19 of 30, and `email-gate`, a fork golden whose gate failed it, 12 of its 40 attempts sending
 * the email twice (past 24, so the Gate's caret folds its attempts).
 */
function reported(): Pick<TestsAnswer, 'rows' | 'failures' | 'reports'> & { attempts: TestEvidence['attempts'] } {
  const store = Store.open(':memory:');
  const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'abc1234' });
  const command = { argv: ['python', 'refund_agent.py'], cwd: '/work/shop' };
  const goldens: GoldenSource[] = [];
  const add = (name: string, mode: 'replay' | 'fork', result: Omit<Parameters<Store['addTestResult']>[0], 'sessionId' | 'golden' | 'runId'>, ended?: number) => {
    const recording = store.createRun({ mode: 'record', command });
    const replay = store.createRun({ mode: 'replay', command, meta: { test: { golden: `goldens/${name}`, session: s.sessionId } } });
    if (ended) store.setDivergence(replay.runId, { type: 'ended_early', callNo: ended, kind: 'api', name: 'POST /v1/messages', replayedBefore: ended - 1, recorded: 30 });
    store.addTestResult({ sessionId: s.sessionId, golden: `goldens/${name}`, runId: replay.runId, ...result });
    goldens.push({ path: `goldens/${name}`, runId: recording.runId, packedAt: 1, mode, repeat: 1, passes: 1, checks: result.data?.checks?.map((c) => c.label) ?? [] });
  };
  add('refund-crash', 'replay', { ok: false, failure: 'exit', reason: 'the agent exited with code 1', data: { mode: 'replay', calls: { total: 18, replayed: 18, live: 0, blocked: 0, stubbed: 0 }, upstreamRequests: 0, checks: [check('issue_refund called 1 time', 'failed', 'called 0 times')], output: PY_TAIL } }, 19);
  const outcomes = Array.from({ length: 40 }, (_, i) => i % 10 > 2);
  const gate = gateResult({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 40 }, outcomes, { decision: 'fail' });
  add('email-gate', 'fork', { ok: false, failure: 'check', reason: `${TWICE} failed in 12 of 40 attempts`, data: { mode: 'fork', verdict: 'failed', upstreamRequests: 80, gate, attempts: { total: 40, passed: 28, required: null, runs: [] }, checks: [check(TWICE, 'failed', 'called 2 times'), check('output includes "refund"', 'passed')] } });
  store.finishTestSession(s.sessionId, { passed: 0, failed: 2, upstreamRequests: 80 });
  const view = testsView(store, goldens, { folder: 'goldens' });
  const reports = goldenReports(view, { store, goldens, normalizers: [], project: '/work/shop' });
  store.close();
  const runId = dash().runs.ticket as string;
  return { rows: view.rows, failures: view.failures, reports, attempts: outcomes.map((ok) => ({ runId, href: `#/run/${runId}`, outcome: ok ? 'passed' : 'failed', note: ok ? null : 'called 2 times' })) };
}

/**
 * Tests as the demo store can't draw it, for the sweeps: the demo's own answer with a golden that
 * passed decided by a gate (12 attempts, all passed), its evidence answered when its row opens; a
 * second golden diverged as the demo's one did, so the header offers Update goldens and its dialog
 * Add normalizer and update; and a crash and a failed gate with their reports (`reported`). The demo
 * has no gated golden, no crash and one divergence (scripts/demo-store.mjs), `diverged`, whose
 * report's Request part asks its replay's diff once the report opens.
 */
export async function routeTestsFixture(page: Page): Promise<{ gated: string; crash: string; gate: string; diverged: string }> {
  const { origin, token } = dash();
  const real = (await (await page.request.get(`${origin}/api/tests`, { headers: { 'x-shadowlap-token': token } })).json()) as TestsAnswer;
  const d = real.divergences[0];
  const gated = real.rows.find((r) => r.last.verdict === 'passed' && r.path !== d?.golden);
  const other = real.rows.find((r) => r.path !== gated?.path && r.path !== d?.golden);
  if (!d || !gated || !other) throw new Error('the demo store has no divergence, or not two other goldens');
  const decided = gateResult({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 }, Array<boolean>(12).fill(true));
  const gate = { ...decided, tally: '12 of 12 passed', perAttempt: null, more: null, words: evidenceWords(decided, null) };
  const twin: DivergenceView = { ...d, golden: other.path, name: other.name, newRules: [rule('request_id')] };
  const more = reported();
  const view: TestsAnswer = {
    ...real,
    rows: [...real.rows.map((r) => (r.path === gated.path ? { ...r, last: { ...r.last, gate } } : r)), ...more.rows],
    divergences: [{ ...d, newRules: [rule('idempotency_key')] }, twin, ...real.divergences.slice(1)],
    diverged: [...new Set([...real.diverged, d.golden, other.path])],
    failures: [...real.failures, ...more.failures],
    reports: { ...real.reports, ...more.reports },
  };
  const runId = d.runId ?? (dash().runs.ticket as string);
  const evidence: TestEvidence = { attempts: Array.from({ length: 12 }, () => ({ runId, href: `#/run/${runId}`, outcome: 'passed', note: null })), carried: 0, gone: 0 };
  await page.route((url) => url.pathname === '/api/tests', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: view }) : route.continue()));
  await page.route((url) => url.pathname === '/api/tests/evidence', (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.get('golden') === 'goldens/email-gate' ? { ...evidence, attempts: more.attempts } : evidence }));
  return { gated: gated.name, crash: 'refund-crash', gate: 'email-gate', diverged: d.name };
}

/**
 * Opens a golden's report under its row on Tests, then each of its folds a person opens to read it
 * whole (Show traceback, Show as printed), each only while it is folded: a page drawn again keeps
 * its reports open, as the dashboard does. Tests first draws its table as bars, so the toggle is
 * waited for.
 */
export async function openReport(page: Page, name: string): Promise<void> {
  const toggle = page.locator(`main#view button.grptog[aria-controls="grp-${name}"]`);
  const report = page.locator(`main#view section[id="report-${name}"]`);
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(report).toBeVisible();
  for (const b of await report.locator('button.rptog').all()) if ((await b.getAttribute('aria-expanded')) === 'false') await b.click();
  await expect(report.locator('pre.report[role="log"]')).toBeVisible();
}
