import { divergenceButtons, findCommitButton, type DivergenceButtons } from '../goldens.js';
import type { DivergenceView, FailureView, InconclusiveView, MoreAttempts, NextStep, TestsView } from '../types.js';

/**
 * The verdict's step: what the golden that leads it (its first failure, else its first inconclusive
 * one) leads with, as the server works it out for that golden's replay (next-step.ts `goldenSteps`,
 * the run page's own rule), mapped by its key onto what the golden's report presses. None while a
 * whole session runs, for a key Tests has no button for (a replay, a comparison, a pack), or for a
 * job the server doesn't run: then Run tests is the page's lime button. No DOM here: the tests import it.
 */
export type Lead =
  | { kind: 'normalize'; label: string; d: DivergenceView; n: NonNullable<DivergenceButtons['normalize']> }
  | { kind: 'update'; label: string; golden: string; judge: readonly string[] | null }
  | { kind: 'bisect'; label: string; f: DivergenceView | FailureView }
  | { kind: 'revert'; label: string; step: Extract<NextStep, { key: 'revert' }>; f: FailureView }
  | { kind: 'more'; label: string; v: InconclusiveView; more: MoreAttempts }
  | { kind: 'rerun'; label: string; golden: string; /** The server's words for its hover, and what it runs. */ sub: string | null; command: string | null }
  | { kind: 'fix'; label: string; href: string; title: string | null; check: string }
  | { kind: 'blame'; runId: string; step: Extract<NextStep, { key: 'blame' }> };

/** The golden whose step leads, and that step as the server sent it; null without one. */
export function leadingStep(view: Pick<TestsView, 'verdict' | 'steps'>): NextStep | null {
  const golden = view.verdict?.first?.golden;
  return (golden && view.steps?.[golden]) || null;
}

type StepView = Pick<TestsView, 'steps' | 'divergences' | 'failures' | 'inconclusive'>;

/** The lead step as Tests draws it; `whole` while a session that runs every golden is running. */
export function leadStep(view: StepView & Pick<TestsView, 'verdict'>, has: (kind: string) => boolean, whole = false): Lead | null {
  const first = view.verdict?.first;
  return whole || !first?.golden ? null : stepFor(view, first.golden, has, first.runId ?? null);
}

/**
 * Any golden's step, as its report draws it (plain) and the verdict draws the leading one's (lime):
 * the server's step for that golden mapped onto what Tests presses. `runId`: its last result's run,
 * which a Run blame step blames.
 */
export function stepFor(view: StepView, golden: string, has: (kind: string) => boolean, runId: string | null): Lead | null {
  const step = view.steps?.[golden];
  if (!step) return null;
  if (step.key === 'fix') return step.href ? { kind: 'fix', label: step.label, href: step.href, title: step.title ?? null, check: step.check } : null;
  if (step.key === 'blame') return runId && has('blame') ? { kind: 'blame', runId, step } : null;
  return 'golden' in step ? goldenLead(view, step, has) : null;
}

/** A step that runs one of the golden's jobs, as its report runs it: none where its report has no such button. */
function goldenLead(view: StepView, step: Extract<NextStep, { golden: string }>, has: (kind: string) => boolean): Lead | null {
  const { golden, label } = step;
  const d = view.divergences.find((x) => x.golden === golden);
  const v = view.inconclusive.find((x) => x.golden === golden);
  switch (step.key) {
    case 'normalizer':
    case 'rerun-test': {
      const n = d ? divergenceButtons(d, has).normalize : null;
      return d && n ? { kind: 'normalize', label, d, n } : null;
    }
    // An injection gate that showed too little to say: its test again, which plants the same payloads.
    case 'gate-again':
      return has('test') ? { kind: 'rerun', label, golden, sub: step.sub ?? null, command: step.command ?? null } : null;
    case 'update-golden':
      return has('test-update') ? { kind: 'update', label, golden, judge: v?.judge?.update ?? null } : null;
    case 'bisect': {
      const report = d ?? view.failures.find((x) => x.golden === golden);
      return report && findCommitButton(report, has) ? { kind: 'bisect', label, f: report } : null;
    }
    // A crash, its first bad commit named: only a failure crashes (its agent exited with an error).
    case 'revert': {
      const f = view.failures.find((x) => x.golden === golden);
      return f && has('revert') ? { kind: 'revert', label, step, f } : null;
    }
    case 'more-attempts':
      return v?.gate?.more && has('test') ? { kind: 'more', label, v, more: v.gate.more } : null;
    default:
      return null;
  }
}

/**
 * Whether a golden's report draws Find breaking commit, as its step or beside it: where the page's
 * helper offers it (findCommitButton), and for a divergence never beside Update golden's lead, which
 * no commit explains. Its hint names Find breaking commit only then.
 */
export function drawsFindCommit(view: StepView, golden: string, has: (kind: string) => boolean): boolean {
  const d = view.divergences.find((x) => x.golden === golden);
  const f = d ?? view.failures.find((x) => x.golden === golden);
  if (!f || !findCommitButton(f, has)) return false;
  return !d || view.steps?.[golden]?.key !== 'update-golden';
}
