import { isAttempt } from '../../../engine/src/run-roles.js';
import type { BlameOffer, BlameView, CheckView, FixView, RunDetail, RunOffers } from '../types.js';
import { isFailed, runType } from '../runs.js';
import { blameOf, checksOf, runLikeOf } from './model.js';
import { blameOfferFor } from './offers.js';
import type { PresetAttempt } from './preset.js';

/**
 * The step the run page leads with, worked out once from how the run stands, as the design's
 * nextStep() orders it: an attempt is read against the run it came from; a failure a fix covers
 * opens that fix; a failure nobody blamed is blamed, a fork's too; a fork is compared with its
 * parent; and a run where nothing needs doing is replayed. It is the header's one lime button, and
 * the banner doesn't offer it again. A test replay that diverged, or a replay that left its recording
 * on a value a normalizer masks, leads from its banner (Add normalizer, Update golden), so the header
 * leads with nothing of its own. No DOM here: the tests import it.
 */
export type NextStep =
  | { key: 'replay' }
  | { key: 'fix'; fix: FixView }
  | { key: 'blame'; offer: BlameOffer }
  | { key: 'compare'; parent: string }
  | { key: 'banner' }
  | { key: 'none' };

export interface NextStepContext {
  offers: Pick<RunOffers, 'blame'> | null;
  /** An exported copy: nothing runs, and its Fixes aren't part of it. */
  exported: boolean;
  /** An error-path preset's attempt, which its record alone doesn't say. */
  preset?: PresetAttempt | null;
  /** The run is the fork blame rescued a run with: a fork of its own, though blame made it as a probe. */
  rescued?: boolean;
  /** What the page read of the run already (`blameOf`, `checksOf`), when it has. */
  blame?: BlameView | null;
  checks?: readonly CheckView[];
}

/**
 * Run blame for a failed run never blamed, as the page offers it: what the server offers, or, from a
 * server that offers nothing, the same worked out from the run. Null where it doesn't apply: a run
 * blamed already, or an exported copy.
 */
export function runBlameOffer(run: RunDetail, c: Pick<NextStepContext, 'offers' | 'exported' | 'blame' | 'checks'>): BlameOffer | null {
  const blamed = !!(c.blame === undefined ? blameOf(run) : c.blame);
  if (blamed || c.exported) return null;
  const r = run.run;
  return blameOfferFor(c.offers, {
    blamed,
    capture: !!run.source,
    argv: r.command.argv,
    status: r.status,
    failed: (c.checks ?? checksOf(run)).filter((x) => !x.ok).map((x) => x.label),
    fixExpect: run.blameExpect,
    ownExpect: r.meta?.expect,
    modelCalls: run.summary.byKind.api,
  });
}

export function nextStepOf(run: RunDetail, c: NextStepContext): NextStep {
  const r = run.run;
  if (r.status === 'running') return { key: 'replay' };
  const like = runLikeOf(run);
  const type = runType(like);
  const failed = isFailed(like);
  // A test whose golden diverged: its banner's Add normalizer or Update golden is the step.
  if (type === 'test' && failed && r.divergence && (!like.outcome || like.outcome.kind === 'diverged')) return { key: 'banner' };
  // An attempt is read against the run it came from, by the engine's one rule (run-roles.ts): a blame
  // probe's, a verify's, a `--repeat`'s (an injection test's and a model's scoring among them), an
  // error-path preset's, a golden's repeated test replay. Its failure counts towards what made it.
  if (r.parentRunId && isAttempt(r, { rescued: c.rescued === true })) return { key: 'compare', parent: r.parentRunId };
  if (failed && run.fix && !c.exported) return { key: 'fix', fix: run.fix };
  if (failed) {
    const offer = runBlameOffer(run, c);
    if (offer) return { key: 'blame', offer };
  }
  // A replay that left its recording on a value made anew on every run: the banner's Add normalizer is the step.
  if (type === 'fork' && !c.exported && r.divergence?.hints?.some((h) => h.normalizer) && run.actions.some((a) => a.key === 'n')) return { key: 'banner' };
  if (type === 'fork' && r.parentRunId) return { key: 'compare', parent: r.parentRunId };
  return c.exported ? { key: 'none' } : { key: 'replay' };
}

/**
 * A fix's status as the run page's Open the fix says it on hover and its banner beside it: open
 * until a change is verified, then verified, then applied.
 */
export function fixStatusWords(status: string): { tone: 'warn' | 'ok'; text: string; why: string } {
  if (status === 'open') return { tone: 'warn', text: 'fix open', why: 'open: no change has been verified for it yet' };
  if (status === 'applied') return { tone: 'ok', text: 'fix applied', why: 'applied: its change is in your working tree' };
  return { tone: 'ok', text: `fix ${status}`, why: `${status}: a change fixed its failing runs, ready to apply` };
}
