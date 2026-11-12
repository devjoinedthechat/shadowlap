import { ACTIONS } from '@shadowlap/engine';
import { commandLine } from '../fix-shared.js';
import { links } from '../links.js';
import { gateAgainSub, type NextStep } from '../next-step.js';
import { type FailingTest, gateResultView } from '../tests.js';
import { goldenName, type LookSource, type LookStep, type LookWork, type NeedsLookRow, plural } from './row.js';

/*
 * Needs a look's rows about goldens: each that fails, as its gate says it, its step what its run's
 * page leads with (unless an open fix holds it: the fix's row names it), and each that is
 * inconclusive, with what settles it. A golden whose checks changed since its last test leads with
 * Run tests, as its run's page does, and its line says so (` · checks changed since`); one whose own
 * recording fails a check added since, with Edit check.
 */

/** A run's step as a row's: a link where it is one (Open fix, Open passing run, Open proof), else the step itself. */
export function runLookStep(runId: string, step: NextStep | null | undefined): LookStep | null {
  if (!step) return null;
  if (step.capture) return { of: 'link', label: step.label, href: links.run(runId) };
  if (step.href) return { of: 'link', label: step.label, href: step.href, ...(step.title ? { title: step.title } : {}), ...(step.key === 'injection-proof' || step.key === 'preset-proof' ? { attempt: true as const } : {}) };
  return { of: 'run', runId, step };
}

const held = (w: LookWork, t: FailingTest) => !!t.fixId && (w.held.get(t.fixId) ?? []).some((h) => h.golden === t.golden);

/** Whether a row's step is Run tests, its golden's checks changed since its last test. */
const runsTests = (step: LookStep | null): boolean => step?.of === 'run' && step.step.key === 'run-tests';

const golden = (t: FailingTest, step: LookStep | null): Pick<NeedsLookRow, 'title' | 'name' | 'detail' | 'step' | 'href' | 'runId' | 'at' | 'report' | 'rule'> => ({
  title: t.title,
  name: goldenName(t.golden),
  detail: runsTests(step) ? `${t.line} · checks changed since` : t.line,
  step,
  // Tests, at the golden's report.
  href: links.tests(),
  runId: t.runId,
  at: t.at,
  report: `report-${goldenName(t.golden)}`,
  ...(t.rule ? { rule: t.rule } : {}),
});

export const failedGoldens: LookSource = {
  id: 'failedGoldens',
  group: 'failing',
  order: 20,
  rows: (w) => w.failing.filter((t) => t.verdict === 'failed' && !held(w, t)).map((t) => ({ key: `attn:failed:${t.golden}`, group: 'failing', kind: 'test', icon: 'fail', fixId: t.fixId, ...golden(t, t.runId ? runLookStep(t.runId, w.steps.get(t.golden)) : null) })),
  rest: (n) => ({ icon: 'fail', title: `${plural(n, 'more golden')} failed`, detail: 'each on Tests', href: links.tests() }),
};

/**
 * Run tests where its checks changed since its last test, its run's step; Run more attempts where its
 * gate ran out of them, Update golden where a judge check had no verdict offline, Re-run test where
 * its injection gate showed too little to say (its card saying why, as its run's page does); else
 * the row opens Tests.
 */
export const inconclusiveGoldens: LookSource = {
  id: 'inconclusiveGoldens',
  group: 'tests',
  order: 10,
  rows: (w) => {
    const unsure = w.failing.filter((t) => t.verdict === 'inconclusive');
    const latest = unsure.some((t) => t.next === 'run-more' || t.next === 'run-again') ? new Map(w.store.latestTestResults().map((r) => [r.golden, r])) : null;
    return unsure.map((t) => {
      const r = latest?.get(t.golden);
      const more = t.next === 'run-more' && r ? (gateResultView(r, r.golden)?.more ?? null) : null;
      // Its checks changed since its last test: its run's step, Run tests.
      const stale = t.next === 'run-tests' && t.runId ? runLookStep(t.runId, w.steps.get(t.golden)) : null;
      const step: LookStep | null =
        stale ??
        (more
          ? { of: 'more', golden: t.golden, label: ACTIONS.runMoreAttempts.label, more }
          : t.next === 'update'
            ? { of: 'update', golden: t.golden, label: ACTIONS.updateGolden.label, command: commandLine(['test', t.golden, '--update']) }
            : t.next === 'run-again'
              ? { of: 'rerun', golden: t.golden, label: ACTIONS.rerunTest.label, sub: gateAgainSub(r?.data?.injection?.reason), command: commandLine(['test', t.golden]) }
              : null);
      return { key: `attn:inconclusive:${t.golden}`, group: 'tests', kind: 'test', icon: 'warn', fixId: null, ...golden(t, step) };
    });
  },
  rest: (n) => ({ icon: 'warn', title: `${plural(n, 'more golden')} inconclusive`, detail: 'each on Tests', href: links.tests() }),
};
