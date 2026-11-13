import type { Page } from '@playwright/test';
import { parseTraceback } from '@shadowlap/engine';
import type { FailureView, FixDetail, FoundCommit, GoldenReport, NextStep, TestsAnswer } from '../ui/types.js';
import { demoId, patched } from './dashboard.js';

/**
 * A crash whose first bad commit Find breaking commit named, on invented data routed over the demo’s
 * answers (the demo store has no crashed golden): a crash’s run page leading with its commit and
 * Revert, the crash’s fix with the commit and the exception on its Blame step, and Tests with the
 * crash leading the verdict, its report folded under its row. Revert’s tests and the accessibility
 * sweep both route it.
 */

export const REV = '9a3c5e0';
export const GOLDEN = 'goldens/refund-flow';
export const NAME = 'refund-flow';
const HUNK = '@@ -10,4 +10,4 @@ def refund(order):\n     total = order["amount"]\n-    limit = policy.limit(order)\n+    limit = policy.limit()\n     return min(total, limit)\n';
/** What the crashed agent printed last, as its result keeps it: its report and its fix's Blame step read the exception from it. */
const OUTPUT = 'Traceback (most recent call last):\n  File "agent/refund.py", line 12, in refund\nTypeError: limit() missing 1 required positional argument: \'order\'';
export const FOUND: FoundCommit = {
  rev: REV,
  subject: 'Read the refund limit once per session',
  author: '',
  date: '2026-10-30T10:00:00Z',
  why: 'the agent exited 1',
  untested: [],
  replays: 3,
  tokens: 0,
  at: Date.now() - 60_000,
  change: { file: 'agent/refund.py', files: ['agent/refund.py'], hunk: HUNK, line: 12, cut: false, merge: false, path: 'agent/refund.py', outside: 0 },
};
const FREE = { kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] };
const step = (runId: string) =>
  ({
    key: 'revert',
    label: 'Revert',
    golden: GOLDEN,
    rev: REV,
    merge: false,
    live: [],
    blame: { offer: { from: 'exit', expect: null, failed: [] }, sub: 'Whether an answer of the model’s lost the run', command: `shadowlap blame ${runId.slice(0, 10)}`, estimate: FREE },
    title: `Revert ${REV}`,
    sub: `${FOUND.subject}: undone in your working tree, then refund-flow replayed offline`,
    command: `git revert --no-commit ${REV} && shadowlap test ${GOLDEN}`,
    estimate: FREE,
  }) as unknown as NextStep;

/** Open in editor's form on this machine, and the job kinds with revert among them. */
async function routeMeta(page: Page): Promise<void> {
  await page.route(/\/api\/meta(\?.*)?$/, (route) => patched<{ jobKinds: string[] }>(route, (meta) => ({ ...meta, editor: 'code --goto <file>:<line>', jobKinds: [...new Set([...meta.jobKinds, 'revert'])] })));
}

/** A demo run as a crashed test replay whose golden's first bad commit stands: its step and its offers. */
export async function routeCrash(page: Page): Promise<string> {
  const run = demoId('ticket');
  await routeMeta(page);
  await page.route(new RegExp(`/api/runs/${run}/offers(\\?.*)?$`), (route) => patched<object>(route, (offers) => ({ ...offers, commit: FOUND })));
  await page.route(new RegExp(`/api/runs/${run}(\\?.*)?$`), (route) => patched<object>(route, (detail) => ({ ...detail, next: step(run) })));
  return run;
}

/**
 * The demo's fix as a crash no model rescued, whose run's search named the commit: Revert leads it,
 * and its Blame step shows the commit. Its blame offers a stronger model, as one kept with its flags
 * does on a machine that names one, so its head has the most buttons a named crash's fix draws.
 */
export async function routeCrashFix(page: Page): Promise<string> {
  const fix = demoId('refundFix');
  const run = await routeCrash(page);
  await page.route(new RegExp(`/api/runs/${run}/next(\\?.*)?$`), (route) => route.fulfill({ json: { next: step(run) } }));
  await page.route(new RegExp(`/api/fixes/${fix}(\\?.*)?$`), (route) =>
    patched<FixDetail>(route, (d) => ({
      ...d,
      status: 'open',
      lead: { key: 'revert', label: 'Revert', command: `git revert --no-commit ${REV} && shadowlap test ${GOLDEN}`, use: 'writes', runId: run, step: step(run) },
      actions: { ...d.actions, blameAgain: null, blameStronger: { argv: ['blame', run], command: `shadowlap blame ${run} --model <model>`, attempts: 8, spent: 0, pulled: null, left: [] } },
      blame: d.blame && { ...d.blame, outcome: 'unrescuable', answers: null, crash: { commit: FOUND, offline: true, stronger: false, error: { error: parseTraceback(OUTPUT)!, file: 'agent/refund.py', lines: OUTPUT.split('\n') } } },
    })),
  );
  return fix;
}

/** Tests with the demo's first golden crashed at the commit, its failure leading the verdict and its report under its row. */
export async function routeTests(page: Page): Promise<void> {
  await routeMeta(page);
  const run = demoId('ticket');
  await page.route(
    (url) => url.pathname === '/api/tests',
    (route) => (route.request().method() !== 'GET' ? route.continue() : patched<TestsAnswer>(route, (real) => {
      const row = real.rows.find((r) => r.path !== real.divergences[0]?.golden) ?? real.rows[0]!;
      const crash: FailureView = {
        golden: GOLDEN,
        name: NAME,
        runId: run,
        failure: 'exit',
        reason: 'the agent exited with code 1',
        checks: null,
        blocked: null,
        bisect: null,
        found: FOUND,
        missed: null,
        revisions: [],
        unreadable: null,
      } as unknown as FailureView;
      // Its report as GET /api/tests builds it for such a crash (golden-report.ts): its exception, then its first bad commit.
      const report: GoldenReport = {
        golden: GOLDEN,
        name: NAME,
        verdict: 'failed',
        head: ['The agent exited with code 1 after its last call'],
        sub: [],
        parts: [{ kind: 'error', error: parseTraceback(OUTPUT)!, file: 'agent/refund.py', lines: OUTPUT.split('\n') }, { kind: 'commit', found: FOUND }],
        open: { label: 'Open run', href: `#/run/${run}` },
        failedRuns: null,
        hint: { key: 'crash' },
        printed: [{ text: `✗ ${NAME}: ${crash.reason}`, tone: 'no' }, ...OUTPUT.split('\n').map((text) => ({ text: `    │ ${text}`, tone: 'dim' as const }))],
      };
      const view = {
        ...real,
        rows: real.rows.map((r) => (r.path === row.path ? { ...r, path: GOLDEN, name: NAME } : r)),
        failures: [crash, ...real.failures],
        verdict: real.verdict ? { ...real.verdict, state: 'failing', first: { golden: GOLDEN, name: NAME, reason: crash.reason, runId: run } } : real.verdict,
        steps: { ...(real.steps ?? {}), [GOLDEN]: step(run) },
        reports: { ...Object.fromEntries(Object.entries(real.reports ?? {}).filter(([golden]) => golden !== row.path)), [GOLDEN]: report },
      } as TestsAnswer;
      return view;
    })),
  );
}
