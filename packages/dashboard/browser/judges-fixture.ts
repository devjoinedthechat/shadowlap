import type { Page } from '@playwright/test';
import { JUDGE_ASKED_IN_NONE, JUDGE_NOT_ASKED, Store, type JudgeSummary, type StoredCheck, type TestResultData } from '@shadowlap/engine';
import { goldenReports, type TestsAnswer } from '../src/golden-report.js';
import { prCommentPreview } from '../src/pr-comment-preview.js';
import { withJudgeAsks } from '../src/tests-checks.js';
import type { TestEvidence } from '../src/tests-evidence.js';
import { testsView, type GoldenSource } from '../src/tests.js';
import { dash, RESET_RETRY } from './dashboard.js';

/** The judge both goldens' entries ask, as the CLI labels it. */
export const JUDGE = 'judge "explains-escalation" answers yes';
const QUESTION = 'Does it say why it escalated instead of refunding?';
const MODEL = 'claude-haiku-4-5';
const REFUNDS = 'issue_refund called 0 times';
/** A golden whose every attempt failed its other check, so that none asked its judge. */
export const UNASKED = 'judge-unasked';
/** A golden whose shown attempt, the first that failed, didn't ask its judge, while the four that passed their other check did. */
export const SOME = 'judge-some';

const outcome = (verdict: 'yes' | null): NonNullable<StoredCheck['judge']> => ({ name: 'explains-escalation', model: MODEL, of: 'answer', verdict, source: verdict ? 'live' : null, cost: verdict ? 0.0004 : null, redactions: 0, cut: 0 });
const refunds = (ok: boolean): StoredCheck => (ok ? { ok, status: 'passed', label: REFUNDS, detail: null } : { ok, status: 'failed', label: REFUNDS, detail: 'called 1 time (1 blocked)' });
const asked = (n: number): StoredCheck => ({ ok: true, status: 'passed', label: JUDGE, detail: null, reason: `It says the order is over the limit, so it escalates (${n}).`, source: 'live', judge: outcome('yes') });
const notAsked = (detail: string): StoredCheck => ({ ok: true, status: 'not-applicable', label: JUDGE, detail, judge: outcome(null) });
/** The judge summary of a session whose attempts asked the judge `n` times live. */
const judgeSummary = (n: number): JudgeSummary => ({ calls: n, replayed: 0, live: n, notAsked: 0, upstreamRequests: n, spent: (4 * n) / 10_000, saved: 0, unknownModels: [] });

interface Judged {
  answer: Pick<TestsAnswer, 'rows' | 'failures' | 'reports'>;
  evidence: Record<string, TestEvidence>;
  comment: ReturnType<typeof prCommentPreview>;
}

/**
 * The two goldens, which may fork, in one session of a store of their own, as the CLI keeps them
 * since a golden that may fork asks its judges only in the attempts that pass its other checks
 * (port/judges-e34): Tests' rows and reports as GET /api/tests answers them, each golden's attempts
 * as its evidence, and the pull request comment the Action would post for the session. The demo has
 * no judge check (scripts/demo-store.mjs).
 */
function judged(): Judged {
  const store = Store.open(':memory:');
  try {
    const at = Date.UTC(2026, 10, 12, 10, 0);
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', actor: 'ci', startedAt: at });
    const command = { argv: ['node', 'agent.mjs'], cwd: '/work/shop' };
    const ticket = dash().runs.ticket as string;
    const goldens: GoldenSource[] = [];
    const evidence: Record<string, TestEvidence> = {};
    const add = (name: string, attempts: StoredCheck[][], shown?: StoredCheck[]) => {
      const golden = `goldens/${name}`;
      const recording = store.createRun({ mode: 'record', command });
      const runs = attempts.map((checks) => store.createRun({ mode: 'replay', command, meta: { checks, test: { golden, session: s.sessionId } } }).runId);
      const first = attempts.findIndex((checks) => checks.some((c) => !c.ok));
      const passed = attempts.filter((checks) => checks.every((c) => c.ok)).length;
      const asks = attempts.flat().filter((c) => c.judge?.verdict).length;
      const data: TestResultData = { mode: 'fork', verdict: 'failed', upstreamRequests: attempts.length * 6, checks: shown ?? attempts[first]!, attempts: { total: attempts.length, passed, required: attempts.length, runs }, ...(asks ? { judge: judgeSummary(asks) } : {}) };
      store.addTestResult({ sessionId: s.sessionId, golden, ok: false, failure: 'check', reason: `${passed} of ${attempts.length} attempts passed`, runId: runs[first]!, revision: 'd2e8a1f', at: at + 1, data });
      goldens.push({ path: golden, runId: recording.runId, packedAt: at - 86_400_000, mode: 'fork', repeat: attempts.length, passes: attempts.length, checks: [REFUNDS, JUDGE] });
      const tried = attempts.map((checks) => checks.every((c) => c.ok));
      evidence[golden] = { attempts: tried.map((ok) => ({ runId: ticket, href: `#/run/${ticket}`, outcome: ok ? 'passed' : 'failed', note: ok ? null : 'called 1 time (1 blocked)' })), carried: 0, gone: 0 };
    };
    // Each attempt refunded, so none asked the judge: the CLI keeps the golden's words for the shown attempt's.
    add(UNASKED, Array.from({ length: 5 }, () => [refunds(false), notAsked(JUDGE_NOT_ASKED)]), [refunds(false), notAsked(JUDGE_ASKED_IN_NONE)]);
    add(SOME, Array.from({ length: 8 }, (_, i) => (i % 2 ? [refunds(false), notAsked(JUDGE_NOT_ASKED)] : [refunds(true), asked(i + 1)])));
    store.finishTestSession(s.sessionId, { passed: 0, failed: 2, upstreamRequests: 78, endedAt: at + 100 });
    const view = withJudgeAsks(testsView(store, goldens, { folder: 'goldens' }), () => ({ judge: [{ name: 'explains-escalation', question: QUESTION, model: MODEL }] }));
    const reports = goldenReports(view, { store, goldens, normalizers: [], project: '/work/shop' });
    return { answer: { rows: view.rows, failures: view.failures, reports }, evidence, comment: prCommentPreview(store, goldens, { step: null }) };
  } finally {
    store.close();
  }
}

/**
 * Tests and Settings → CI as the demo store can't draw them, for the sweeps: the demo's own Tests
 * with the two goldens (`judged`) after its rows, their reports, and their attempts answered as a
 * report opens; and the pull request comment's preview made for their session alone.
 */
export async function routeJudgesFixture(page: Page): Promise<void> {
  const { origin, token } = dash();
  const real = (await (await page.request.get(`${origin}/api/tests`, { headers: { 'x-shadowlap-token': token }, ...RESET_RETRY })).json()) as TestsAnswer;
  const { answer, evidence, comment } = judged();
  const view: TestsAnswer = { ...real, rows: [...real.rows, ...answer.rows], failures: [...real.failures, ...answer.failures], reports: { ...real.reports, ...answer.reports } };
  await page.route((url) => url.pathname === '/api/tests', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: view }) : route.fallback()));
  await page.route(
    (url) => url.pathname === '/api/tests/evidence',
    (route) => {
      const kept = evidence[new URL(route.request().url()).searchParams.get('golden') ?? ''];
      return kept ? route.fulfill({ json: kept }) : route.fallback();
    },
  );
  await page.route((url) => url.pathname === '/api/ci/comment', (route) => route.fulfill({ json: comment }));
}
