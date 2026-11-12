import { divergenceButtons, findCommitButton, type DivergenceButtons } from '../goldens.js';
import type { DivergenceView, FailureView, InconclusiveView, MoreAttempts, NextStep, TestsView } from '../types.js';

/**
 * The verdict's step: what the golden that leads it (its first failure, else its first inconclusive
 * one) leads with, as the server works it out for that golden's replay (next-step.ts `goldenSteps`,
 * the run page's own rule), mapped by its key onto what the golden's report presses. None while a
 * whole session runs, for a key Tests has no button for (a replay, a comparison, a pack), for a job
 * the server doesn't run, for Edit check where the page has no builder, and for Run tests (a golden
 * whose checks changed since), which is the page's own button: then Run tests is the page's lime
 * button. No DOM here: the tests import it.
 */
export type Lead =
  | { kind: 'normalize'; label: string; d: DivergenceView; n: NonNullable<DivergenceButtons['normalize']> }
  | { kind: 'update'; label: string; golden: string; judge: readonly string[] | null }
  | { kind: 'bisect'; label: string; f: DivergenceView | FailureView }
  | { kind: 'revert'; label: string; step: Extract<NextStep, { key: 'revert' }>; f: FailureView }
  | { kind: 'more'; label: string; v: InconclusiveView; more: MoreAttempts }
  | { kind: 'fix'; label: string; href: string; title: string | null; check: string }
  | { kind: 'edit'; label: string; golden: string; check: string; sub: string }
  | { kind: 'proof'; label: string; href: string; title: string | null; sub: string | null }
  | { kind: 'again'; label: string; golden: string; name: string; sub: string | null }
  | { kind: 'blame'; runId: string; step: Extract<NextStep, { key: 'blame' }> };

/** The golden whose step leads, and that step as the server sent it; null without one. */
export function leadingStep(view: Pick<TestsView, 'verdict' | 'steps'>): NextStep | null {
  const golden = view.verdict?.first?.golden;
  return (golden && view.steps?.[golden]) || null;
}

/** The lead step as Tests draws it; `whole` while a session that runs every golden is running, `edits` where the page has the check builder. */
export function leadStep(view: Pick<TestsView, 'verdict' | 'steps' | 'divergences' | 'failures' | 'inconclusive'>, has: (kind: string) => boolean, whole = false, edits = false): Lead | null {
  const step = whole ? null : leadingStep(view);
  if (!step) return null;
  if (step.key === 'fix') return step.href ? { kind: 'fix', label: step.label, href: step.href, title: step.title ?? null, check: step.check } : null;
  // An injection gate that failed: the attempt that proves it, at the call that carried the canary.
  if (step.key === 'injection-proof') return step.href ? { kind: 'proof', label: step.label, href: step.href, title: step.title ?? null, sub: step.sub ?? null } : null;
  if (step.key === 'blame') {
    const runId = view.verdict?.first?.runId;
    return runId && has('blame') ? { kind: 'blame', runId, step } : null;
  }
  if (step.key === 'edit-check') return edits ? { kind: 'edit', label: step.label, golden: step.golden, check: step.check, sub: step.sub ?? '' } : null;
  return 'golden' in step ? goldenLead(view, step, has) : null;
}

/** Run tests' line on its card where the step that leads is Run tests (a golden whose checks changed since): the step's own. */
export function staleSub(view: Pick<TestsView, 'verdict' | 'steps'>, whole = false): string | undefined {
  const step = whole ? null : leadingStep(view);
  return step?.key === 'run-tests' ? step.sub : undefined;
}

/** A step that runs one of the golden's jobs, as its report runs it: none where its report has no such button. */
function goldenLead(view: Pick<TestsView, 'divergences' | 'failures' | 'inconclusive'>, step: Extract<NextStep, { golden: string }>, has: (kind: string) => boolean): Lead | null {
  const { golden, label } = step;
  const d = view.divergences.find((x) => x.golden === golden);
  const v = view.inconclusive.find((x) => x.golden === golden);
  switch (step.key) {
    case 'normalizer':
    case 'rerun-test': {
      const n = d ? divergenceButtons(d, has).normalize : null;
      return d && n ? { kind: 'normalize', label, d, n } : null;
    }
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
    // An injection gate that showed too little to say: its test again, which plants its payloads again.
    case 'gate-again':
      return has('test') ? { kind: 'again', label, golden, name: v?.name ?? golden, sub: step.sub ?? null } : null;
    default:
      return null;
  }
}
