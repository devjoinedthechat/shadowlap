import type { Block } from './deltas.js';
import { fisherGreater } from './exact-tests.js';
import { antitonic } from './isotonic.js';
import { KEPT_MAX, decidePairedAround, pairedWorstCase, type BaselineRule, type PairCounts } from './noninferiority.js';
import { formatUsd } from './prices.js';
import { atLeast, atMost, attemptsToPass, BLAME_DEFAULTS, confidenceSequence, countOdds, gateOdds, rateBound, riskPercent, type GateDecision, type GateResult, type SprtGate } from './stats.js';
import type { Palette } from './report.js';
import { plain } from './report.js';
import { safeLine } from './text.js';

/**
 * Where a failed run was lost. A run can go wrong long before it visibly fails: the model picks the
 * wrong tool at call 11, and everything after that follows from it. Blame finds that call by asking,
 * at a model call k, "if the model had answered k differently, could the run still have passed?"
 *
 * A probe answers it: replay the calls before k from the recording, which costs nothing, force k
 * live, let the rest of the run go live with writes fenced, and judge the outcome. Several attempts,
 * because one lucky sample proves nothing. A probe's gate tells a re-asked call that passes `good`
 * of the time or more (60% by default) from one that passes `bad` or less (10%): a rescue claims the
 * call passes more than `bad` of the time, a loss that it passes less than `good` of the time, and
 * each claim is wrong at most the probe's risk of the time (stats.ts). Between the two rates a probe
 * may say either, or run out of attempts inconclusive, which claims nothing.
 *
 * Rescue gets harder the later it starts: resampling from call 1 re-runs almost the whole agent,
 * resampling the last call can only change the ending. So the rescue rate r_k of call k falls as k
 * grows, and the run was lost where it falls from rescuable to lost: the boundary, the calls from
 * the last whose rate is `good` or more to the one before the first whose rate is `bad` or less. A
 * sharp drop makes it one call; a gradual one, several.
 *
 * The search is a binary search for it, so a run with 30 model calls needs about six probes, not
 * thirty, plus a scan of a few calls past it. Its risk is spent across the probes: each probe's gate
 * runs at the search's risk divided by the most probes it makes (`maxProbes`), so every claim of
 * every probe holds together, but for that risk. Then the run was lost between the last call that
 * rescued it and the call before the first lost after it (`range`), which holds a call of the
 * boundary whenever every claim does: the rescued call's rate is above `bad`, so it comes before the
 * first call at `bad` or less; the lost call's rate is below `good`, so it comes after the last call
 * at `good` or more. A range of one call is pinned once its check says so (`PinCheck`): the claims
 * alone hold as well for two calls in the middle of a gradual decay as for a sharp drop. Its
 * `errorBound` is the sum of the risks of the probes that claimed something, each computed exactly at
 * the gate's two rates (`probeRisk`), and of the check's, and the confidence is read from it: high
 * when it is within the search's risk.
 *
 * Nothing guarantees rescue falls monotonely: a run can be rescuable at 10, not at 12, and again at
 * 14. The scan past the boundary sees a rise just after it; a rescue there moves the search on,
 * which costs probes beyond the budget and so lowers the confidence. The probes' rates are fitted
 * non-increasing (isotonic regression by pool-adjacent-violators, `fit`), which pools a rise with
 * the fall before it.
 */

export interface BlameAttempt {
  runId: string;
  passed: boolean;
  /**
   * How it came out: inconclusive when all it fell short on is a check that could not be decided (a
   * judge that could not answer, a condition it could not read), which says nothing of the answer
   * re-asked. Absent from reports made before attempts had one.
   */
  verdict?: 'passed' | 'failed' | 'inconclusive';
  exitCode: number;
  /** Why the attempt failed the oracle: failed checks, a non-zero exit, a timeout. Empty when it passed. */
  failures: string[];
  /** The provider cut it short after the model had answered (unavailable.ts): counted against either verdict, a failure toward a rescue and a pass toward a loss. Absent otherwise. */
  cutShort?: true;
  /** Approximate USD spent on the attempt's live model calls. */
  spent: number;
  upstreamRequests: number;
}

export interface BlameProbe {
  /** The failed run's model call that was forced live, by call number. */
  callNo: number;
  /** Its position among the run's model calls, from 1. */
  step: number;
  attempts: BlameAttempt[];
  passes: number;
  /** The re-asked call passes often enough: the gate passed, or the fixed count was met. */
  rescued: boolean;
  /**
   * A gate decided the probe: what it said, inconclusive included (`rescued` is false then). Absent
   * for a fixed count, unless an attempt could not be judged, which makes any probe inconclusive.
   */
  decision?: GateDecision;
  /** A gate decided the probe: its result, with the pass rate's interval and the risk (stats.ts). */
  gate?: GateResult | null;
  /**
   * Why an attempt of it could not be judged, when all that attempt fell short on was a check no
   * attempt could decide: the probe stopped there, inconclusive. Null or absent otherwise.
   */
  undecided?: string | null;
  /**
   * The most its claim may be wrong, exactly (`probeRisk`): the chance its rule rescues a call that
   * passes `bad` of the time, or loses one that passes `good`, whichever is larger. Absent from
   * reports made before probes had one.
   */
  risk?: number;
  /**
   * Attempts the provider was unavailable for (unavailable.ts): the agent failed while one of its
   * live model calls ended on an overload, a rate limit or a 5xx. Each was retried and none counted,
   * so they say nothing about the answer. Absent when there were none.
   */
  unavailable?: number;
  /** Attempts the provider cut short after the model had answered: among `attempts`, each counted against either verdict. Absent when there were none. */
  cutShort?: number;
}

export type ProbeVerdict = 'rescued' | 'lost' | 'open';

/**
 * What a probe claims: `rescued` (the call passes more than `bad` of the time), `lost` (less than
 * `good` of the time), or nothing, when it ran out of attempts between them or an attempt could not
 * be judged.
 */
export function probeClaim(p: Pick<BlameProbe, 'rescued' | 'decision'> & { undecided?: string | null | undefined }): 'rescued' | 'lost' | null {
  if (p.rescued) return 'rescued';
  if (p.undecided || p.decision === 'inconclusive' || p.decision === 'continue') return null;
  return 'lost';
}

/**
 * The most a probe's claim may be wrong, exactly, at the blame gate's two rates: under a gate, the
 * chance it passes a call at `bad` or fails one at `good`, every look counted (gateOdds); under a
 * fixed count, `needed` of `attempts` at the same two rates (by default the blame gate's). A
 * gate's error only shrinks as the rate moves past its two, so this bounds every rate beyond them.
 */
export function probeRisk(rule: { gate: SprtGate } | { attempts: number; needed: number; good?: number; bad?: number }): number {
  if ('gate' in rule) return Math.max(gateOdds(rule.gate, rule.gate.bad).pass, gateOdds(rule.gate, rule.gate.good).fail);
  const good = rule.good ?? BLAME_DEFAULTS.good;
  const bad = rule.bad ?? BLAME_DEFAULTS.bad;
  return Math.max(countOdds(rule.attempts, rule.needed, bad).pass, countOdds(rule.attempts, rule.needed, good).fail);
}

/**
 * The gate each probe runs under when a search of up to `probes` probes spends `gate.risk` across
 * them: the same rates, at the search's risk divided by `probes`. A gate's error at its two rates is
 * never above its risk (stats.ts `sprtBounds`), so the probes' risks add up to the search's at most.
 * A smaller risk asks for more evidence, ln(1 / risk) where the gate asked ln(1 / its risk), so its
 * `max` grows by that ratio: the cap stays as far into the evidence as the gate's, and a call at
 * either rate is left inconclusive about as rarely (20 attempts at 5% become 31 to 36 at the shares
 * of 5 to 10 probes). A probe always gets the attempts a rescue needs.
 */
export function probeGate(gate: SprtGate, probes: number): SprtGate {
  const each: SprtGate = { ...gate, risk: gate.risk / Math.max(1, probes) };
  const deeper = Math.log(1 / each.risk) / Math.log(1 / gate.risk);
  return { ...each, max: Math.max(Math.ceil(gate.max * deeper - 1e-9), attemptsToPass(each)) };
}

/**
 * The check of a pinned call. The search pins the run to call k when k rescued it and k + 1 was found
 * lost; but those claims only say that k passes more than `bad` of the time and k + 1 less than
 * `good`, which two calls in the middle of a gradual decay meet as well as a sharp drop does: two
 * calls that both pass 40% of the time meet both. So before the run is said to be lost at k, fresh
 * pairs of attempts, one at k and one at k + 1 in each, ask whether rescue drops there. The paired
 * test of noninferiority.ts, on the outcome at k + 1 less the one at k, tells "rescue is lower at k +
 * 1 than at k" (pinned: its broken e-process, at no drop) from "it is less than the gate's two rates
 * apart lower" (gradual: its kept e-process, at that margin); each verdict is wrong at most the
 * check's risk, a probe's share, over every way the pairs can come (Ville's inequality). The pairs are
 * fresh because the probes' own tallies are what chose k: read off them, a pass and a loss look apart
 * by selection alone. Pinned keeps the run lost at k; gradual, or neither after `max` pairs, gives the
 * two calls as the range: the run was lost gradually around them.
 */
export interface PinCheck {
  /** The call the search pinned, and the next one, by call number. */
  callNo: number;
  next: number;
  /**
   * `pinned`: rescue drops from the call to the next beyond chance. `gradual`: it falls by less than
   * the gate's two rates are apart. `inconclusive`: neither, after `rule.max` pairs, or an attempt that
   * could not be judged (`undecided`).
   */
  verdict: 'pinned' | 'gradual' | 'inconclusive';
  /** The pairs it decided on: `dropped` passed at the call and failed at the next, `rose` the other way round, `same` the rest. */
  dropped: number;
  rose: number;
  same: number;
  /** Over the same pairs, the passes at the call and at the next. */
  passes: number;
  nextPasses: number;
  /** Each pair's two attempts, in order: at the call, and at the next. */
  pairs: Array<{ at: BlameAttempt; next: BlameAttempt }>;
  /** The drop it tells from none (`margin`, the gate's good − bad), at a probe's share of the risk, up to `max` pairs (`pinRule`). */
  rule: BaselineRule;
  /** The most its verdict can be wrong, exactly, over every way the pairs can come (`pinRisk`); 0 when it claimed nothing. */
  risk: number;
  /** Why an attempt of it could not be judged, when one stopped it. */
  undecided?: string | null;
  /** Attempts the provider cut short after the model had answered: counted against either verdict. Absent when there were none. */
  cutShort?: number;
}

/**
 * The rule a pinned call's check runs by: the drop it tells from none is the gate's two rates apart
 * (0.5 at the defaults), at a probe's share of the risk (`each`, or the default gate's share for a
 * fixed count), up to twice a probe's attempts in pairs.
 */
export function pinRule(each: SprtGate | null, budget: number): BaselineRule {
  const g = each ?? probeGate({ kind: 'sprt', ...BLAME_DEFAULTS }, budget);
  return { margin: g.good - g.bad, risk: g.risk, max: Math.min(KEPT_MAX, 2 * g.max) };
}

/**
 * What a check says after its pairs, `kept` and `broken` the two tallies of decidePairedAround (the
 * next call's attempt as the change's, the pinned call's as the baseline's): pinned once rescue is
 * shown lower at the next call, gradual once it is shown less than `margin` lower, inconclusive at
 * `max` pairs with neither.
 */
export function decidePin(kept: Pick<PairCounts, 'better' | 'worse' | 'same'>, broken: Pick<PairCounts, 'better' | 'worse' | 'same'>, rule: BaselineRule): PinCheck['verdict'] | 'continue' {
  const d = decidePairedAround(kept, broken, rule);
  return d === 'broken' ? 'pinned' : d === 'kept' ? 'gradual' : d;
}

const pinRisks = new Map<string, number>();

/** The most a check's verdict can be wrong, exactly, over every law of the pairs its null allows (pairedWorstCase); 0 for inconclusive, which claims nothing. */
export function pinRisk(rule: BaselineRule, verdict: PinCheck['verdict']): number {
  if (verdict === 'inconclusive') return 0;
  const key = `${rule.margin} ${rule.risk} ${rule.max} ${verdict}`;
  let r = pinRisks.get(key);
  if (r === undefined) pinRisks.set(key, (r = pairedWorstCase(rule, verdict === 'pinned' ? 'broken' : 'kept')));
  return r;
}

/** A check's finding in a sentence: its pairs, and what they show. */
export function pinWords(c: PinCheck): string {
  const n = c.dropped + c.rose + c.same;
  const counts = `${n} fresh pair${n === 1 ? '' : 's'}: #${c.callNo} rescued ${c.passes} of ${n}, #${c.next} ${c.nextPasses} of ${n}`;
  if (c.verdict === 'pinned') return `Checked with ${counts}; rescue drops at #${c.callNo} beyond chance.`;
  if (c.verdict === 'gradual') return `Checked with ${counts}; rescue falls by less than ${Math.round(100 * c.rule.margin)} points from one to the next, so no one call lost the run.`;
  return `Checked with ${counts}; ${c.undecided ? `an attempt could not be judged (${safeLine(c.undecided)}), so` : 'not enough to tell'} whether rescue drops at #${c.callNo} alone${c.undecided ? ' is not settled' : ''}.`;
}

/** A probe's verdict in a word: rescued, lost, or inconclusive. */
export const probeWord = (x: Pick<BlameProbe, 'rescued' | 'decision'> & { undecided?: string | null | undefined }): 'rescued' | 'lost' | 'inconclusive' => (x.rescued ? 'rescued' : x.decision === 'inconclusive' || x.undecided ? 'inconclusive' : 'lost');

/** The attempts of a probe that could not be judged: neither passed nor failed. One the provider cut short was counted. */
const unjudged = (x: Pick<BlameProbe, 'attempts'>): number => x.attempts.filter((a) => a.verdict === 'inconclusive' && !a.cutShort).length;

/**
 * A probe's tally: how many of the attempts it judged passed, then `unit` (`2 of 4`, `2 of 4
 * passed`). An attempt that could not be judged neither passed nor failed, so it is left out and
 * counted apart: `1 of 1 passed, an attempt not judged`, or, when no attempt was judged, `an
 * attempt not judged`. Only the attempt that stopped a probe, or one that ended after the probe
 * had decided, can be one.
 */
export function probeTally(x: Pick<BlameProbe, 'passes' | 'attempts'>, unit = ''): string {
  const n = unjudged(x);
  const judged = x.attempts.length - n;
  const tally = `${x.passes} of ${judged}${unit}`;
  if (!n) return tally;
  const apart = `${n === 1 ? 'an attempt' : `${n} attempts`} not judged`;
  return judged ? `${tally}, ${apart}` : apart;
}

/** The attempts a gated probe decided on: with attempts running at once, some may have ended after it decided. */
function decidedOn(x: Pick<BlameProbe, 'passes' | 'attempts'> & { gate?: Pick<GateResult, 'passes' | 'attempts'> | null | undefined }): { passes: number; attempts: number; late: number } {
  const on = x.gate && Number.isInteger(x.gate.attempts) && Number.isInteger(x.gate.passes) && x.gate.attempts < x.attempts.length ? x.gate : null;
  return on ? { passes: on.passes, attempts: on.attempts, late: x.attempts.length - on.attempts } : { passes: x.passes, attempts: x.attempts.length, late: 0 };
}

/**
 * A gated probe's bound, on the attempts it decided on, at its gate's confidence: `rate >= 0.15 (95%)`.
 * It is the interval its gate result holds (stats.ts `gateInterval`), exact under the gate's own
 * stopping when the probe stopped by it. A result kept before bounds were exact (it has no `bound`),
 * or one whose tally isn't the attempts it decided on, gets a confidence sequence instead, which
 * holds however the attempts stopped.
 */
export function probeBound(x: Pick<BlameProbe, 'passes' | 'attempts' | 'decision'> & { gate?: (Pick<GateResult, 'passes' | 'attempts'> & Partial<Pick<GateResult, 'interval' | 'bound'>>) | null | undefined; undecided?: string | null | undefined }, gate: Pick<SprtGate, 'risk'> | null | undefined): string | null {
  // A probe an attempt that could not be judged stopped was decided by no gate.
  if (!gate || !x.decision || x.undecided) return null;
  const on = decidedOn(x);
  // At the probe's own confidence: its gate ran at its share of the search's risk.
  const own = x.gate && 'risk' in x.gate ? (x.gate as { risk?: unknown }).risk : undefined;
  const confidence = 1 - (typeof own === 'number' ? own : gate.risk);
  // A report copied from elsewhere could carry counts that don't add up: no bound then.
  if (!Number.isInteger(on.passes) || on.passes < 0 || on.passes > on.attempts || !(confidence > 0 && confidence < 1)) return null;
  const kept = x.gate?.bound && x.gate.interval && x.gate.passes === on.passes && x.gate.attempts === on.attempts ? x.gate.interval : null;
  const exact = kept && [kept.lo, kept.hi, kept.confidence].every(Number.isFinite) ? kept : null;
  return rateBound({ attempts: on.attempts, interval: exact ?? { ...confidenceSequence(on.passes, on.attempts, confidence), confidence }, decision: x.decision });
}

/**
 * What a probe found: its verdict word, its tally and, under a gate, the bound on the attempts it
 * decided on (`probeBound`), `rescued · 2 of 2 · rate >= 0.15 (95%)`, `lost · 0 of 4 · rate <= 0.61
 * (95%)`. The rule it was decided by is said once, apart (`rescueRule`). A probe a fixed count
 * decided says its tally.
 */
export function probeFinding(x: Pick<BlameProbe, 'rescued' | 'decision' | 'passes' | 'attempts'> & { gate?: Pick<GateResult, 'passes' | 'attempts'> | null | undefined; undecided?: string | null | undefined }, gate: Pick<SprtGate, 'risk'> | null | undefined): string {
  // An attempt that could not be judged stopped it: inconclusive, the attempt counted apart, no bound.
  if (x.undecided) return `inconclusive · ${probeTally(x, ' passed')}`;
  if (!gate || !x.decision) return `${x.rescued ? 'rescued' : 'lost'} · ${probeTally(x)}`;
  const on = decidedOn(x);
  const late = on.late ? ` (and ${on.late} more that ended after it decided)` : '';
  return [probeWord(x), `${on.passes} of ${on.attempts}${late}`, probeBound(x, gate)].filter(Boolean).join(' · ');
}

/**
 * How a probe decides, in a line: `gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 32 attempts`,
 * the risk the search's and the attempts a probe's (`probeGate`), or a fixed count's `a rescue needs 2
 * of 5 attempts to pass`.
 */
export function rescueRule(r: Pick<BlameReport, 'needed' | 'attemptsPerProbe'> & { gate?: SprtGate | null | undefined; probeBudget?: number | null | undefined }): string {
  if (!r.gate) return `a rescue needs ${r.needed} of ${r.attemptsPerProbe} attempts to pass`;
  const max = r.probeBudget ? probeGate(r.gate, r.probeBudget).max : r.gate.max;
  return `gate: rescue at ${atLeast(r.gate.good)}, lost at ${atMost(r.gate.bad)}, <= ${riskPercent(r.gate.risk)} risk, up to ${max} attempts`;
}

/**
 * A probe's verdict after `done` of `attempts` attempts, `passes` of which passed. It is settled as
 * soon as the attempts still to run cannot change it, so a probe stops early without ever deciding
 * differently from one that ran every attempt.
 */
export function probeVerdict(passes: number, done: number, attempts: number, needed: number): ProbeVerdict {
  if (passes >= needed) return 'rescued';
  if (passes + (attempts - done) < needed) return 'lost';
  return 'open';
}

/** The most probes a search makes on a run with `steps` model calls when rescue is monotone. */
export function maxProbes(steps: number, scan: number): number {
  if (steps <= 0) return 0;
  return 1 + Math.ceil(Math.log2(steps)) + Math.min(scan, Math.max(0, steps - 1));
}

export interface BlameSearchOptions {
  /** The failed run's model calls, by call number, in order. */
  steps: readonly number[];
  /** Runs the probe at a model call. Resolves null when the search has to stop (a budget, an interrupt). */
  probe: (callNo: number, step: number) => Promise<BlameProbe | null>;
  /** Model calls past the boundary to probe as well, in case rescue works again after it. */
  scan: number;
  /** The most the reported range may be wrong for a high confidence: the gate's risk (blame's default 5%). */
  risk?: number;
  /**
   * Checks a pinned call against the next (`PinCheck`). Resolves null when the check has to stop (a
   * budget, an interrupt), which stops the search. Without it a range of one call is pinned on the
   * probes' claims alone.
   */
  pin?: (at: BlameProbe, next: BlameProbe) => Promise<PinCheck | null>;
}

export type BlameOutcome = 'blamed' | 'unrescuable' | 'stopped';
export type Confidence = 'high' | 'medium' | 'low';

export interface BlameSearchResult {
  outcome: BlameOutcome;
  /** The last model call whose resampling rescued the run: the one whose recorded answer lost it, or the first of the range it was lost in. */
  blamed: BlameProbe | null;
  /** The next model call, where rescue no longer worked, when it was probed. Null when the blamed call is the run's last. */
  lost: BlameProbe | null;
  /** Every probe made, in call order. */
  probes: BlameProbe[];
  /** Rescue that worked again after a call where it was lost, as the pair of call numbers. */
  nonMonotone: Array<{ lost: number; rescued: number }>;
  confidence: Confidence;
  /**
   * The calls the run was lost between, by call number: from the last call that rescued it to the
   * call before the first one found lost after it (the run's last model call when none was). One call
   * (`from` = `to`) when the boundary is pinned. Two calls, `gradual`, when the check of a pinned call
   * found no drop there beyond chance: the call and the next, which was found lost, the run lost
   * gradually around them. Null when no call rescued the run. Absent from reports made before ranges.
   */
  range?: { from: number; to: number; fromStep?: number; toStep?: number; gradual?: true } | null;
  /**
   * The most the range (or, for a run no call rescued, that finding) may be wrong: the sum of the
   * risks of the probes that claimed something (`probeRisk`), under the premise that rescue never
   * rises as calls go on. Null when nothing bounds it: the search stopped, its first probe could not
   * tell, or a probe has no risk. Absent from reports made before it.
   */
  errorBound?: number | null;
  /** The probes' rescue rates fitted non-increasing (isotonic regression), in call order: null for a probe with no attempt judged. */
  fit?: Array<{ callNo: number; rate: number | null }>;
  /** The check of the call the probes pinned, when they pinned one and the next was found lost. Absent otherwise, and from reports made before checks. */
  pin?: PinCheck | null;
}

export async function searchBlame(o: BlameSearchOptions): Promise<BlameSearchResult> {
  const steps = o.steps;
  const n = steps.length;
  if (n === 0) throw new Error('the run made no model calls, so there is nothing to blame');
  const risk = o.risk ?? BLAME_DEFAULTS.risk;
  const probed = new Map<number, BlameProbe>();
  const nonMonotone: BlameSearchResult['nonMonotone'] = [];
  // The check of the call the probes pinned, once it has run.
  let check: PinCheck | null = null;
  const at = async (i: number): Promise<BlameProbe | null> => {
    const known = probed.get(i);
    if (known) return known;
    const p = await o.probe(steps[i]!, i + 1);
    if (p) probed.set(i, p);
    return p;
  };
  const finish = (outcome: BlameOutcome): BlameSearchResult => {
    const probes = [...probed.entries()].sort((a, b) => a[0] - b[0]);
    // The last call that rescued the run, and the first after it found lost (indexes into steps).
    const rescued = probes.filter(([, p]) => probeClaim(p) === 'rescued').map(([i]) => i);
    const last = rescued.length ? rescued[rescued.length - 1]! : null;
    const closing = last === null ? null : (probes.find(([i, p]) => i > last && probeClaim(p) === 'lost')?.[0] ?? null);
    const toIndex = closing === null ? n - 1 : closing - 1;
    // A pinned call its check found no drop at: the call and the next, the run lost gradually around them.
    const around = check && check.verdict !== 'pinned' && last !== null && closing === last + 1;
    const range = outcome === 'unrescuable' || last === null ? null : around ? { from: steps[last]!, to: steps[closing]!, fromStep: last + 1, toStep: closing + 1, gradual: true as const } : { from: steps[last]!, to: steps[toIndex]!, fromStep: last + 1, toStep: toIndex + 1 };
    const first = probed.get(0);
    // Every claim made adds its risk; one with none leaves the bound unknown. So does a rise in rescue
    // more than chance explains: the bound rests on rescue never rising as the calls go on.
    const claims = [...probes.filter(([, p]) => probeClaim(p) !== null).map(([, p]) => p.risk), ...(check && check.verdict !== 'inconclusive' ? [check.risk] : [])];
    const unsettled = outcome === 'unrescuable' && (!first || probeClaim(first) !== 'lost');
    const errorBound = outcome === 'stopped' || unsettled || roseBeyondChance(nonMonotone, probed, steps, risk) || claims.some((r) => r === undefined || !Number.isFinite(r)) ? null : Math.min(1, claims.reduce<number>((s, r) => s + r!, 0));
    const blamed = outcome === 'unrescuable' || last === null ? null : probed.get(last)!;
    const lost = outcome === 'unrescuable' ? (first ?? null) : last === null ? null : last + 1 < n ? (probed.get(last + 1) ?? null) : null;
    const fitted = antitonic(
      probes.map(([, p]) => judgedRate(p).rate),
      probes.map(([, p]) => judgedRate(p).weight),
    );
    return {
      outcome,
      blamed,
      lost,
      probes: probes.map(([, p]) => p),
      nonMonotone,
      confidence: confidenceOf(errorBound, risk),
      range,
      errorBound,
      fit: probes.map(([, p], k) => ({ callNo: p.callNo, rate: fitted.values[k] ?? null })),
      ...(check ? { pin: check } : {}),
    };
  };

  const first = await at(0);
  if (!first) return finish('stopped');
  if (!first.rescued) return finish('unrescuable');

  // Invariant: the probe at lo rescued, and nothing from hi on did (as far as the search knows: an
  // inconclusive probe is taken as not rescued, and leaves the range open past it). `n` stands for
  // the recording itself, which kept every recorded answer and failed.
  let lo = 0;
  let hi = n;
  for (;;) {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const p = await at(mid);
      if (!p) return finish('stopped');
      if (p.rescued) lo = mid;
      else hi = mid;
    }
    let again = -1;
    for (let j = hi + 1; j < n && j <= hi + o.scan; j++) {
      const p = await at(j);
      if (!p) return finish('stopped');
      if (p.rescued) {
        again = j;
        break;
      }
    }
    if (again < 0) {
      const found = finish('blamed');
      // Pinned on the probes' claims: checked against the next call before the run is said to be lost there.
      if (!o.pin || !found.blamed || !found.lost || !found.range || found.range.from !== found.range.to || probeClaim(found.lost) !== 'lost') return found;
      check = await o.pin(found.blamed, found.lost);
      return finish(check ? 'blamed' : 'stopped');
    }
    // A rescue past a call found lost: rescue rose again. Past one that couldn't tell, it only moves on.
    const before = probed.get(hi);
    if (before && probeClaim(before) === 'lost') nonMonotone.push({ lost: steps[hi]!, rescued: steps[again]! });
    lo = again;
    hi = n;
  }
}

/**
 * Whether rescue rose, after a call found lost, at a later one found rescued, by more than chance
 * explains: Fisher's exact test, one-sided, of the later call's passes against the earlier one's, at
 * the search's risk. Both claims hold together when both calls sit between the gate's two rates, so a
 * rise alone breaks nothing; one this large means rescue does not fall as the calls go on here.
 */
function roseBeyondChance(rises: BlameSearchResult['nonMonotone'], probed: ReadonlyMap<number, BlameProbe>, steps: readonly number[], risk: number): boolean {
  const at = (callNo: number) => probed.get(steps.indexOf(callNo));
  return rises.some((x) => {
    const lost = at(x.lost);
    const rescued = at(x.rescued);
    if (!lost || !rescued) return false;
    const a = judgedRate(rescued);
    const b = judgedRate(lost);
    return fisherGreater(rescued.passes, a.weight, Math.min(lost.passes, b.weight), b.weight) <= risk;
  });
}

/** A probe's judged attempts and how many passed: what the fit weighs it by. One the provider cut short is no rate's evidence, and is left out. */
function judgedRate(p: Pick<BlameProbe, 'passes' | 'attempts'>): { rate: number; weight: number } {
  const judged = p.attempts.filter((a) => a.verdict !== 'inconclusive').length;
  return { rate: judged ? Math.min(1, p.passes / judged) : 0, weight: judged };
}

/**
 * The confidence a search's error bound earns: high when the reported range is wrong at most `risk`
 * of the time (the gate's, 5% by default), medium when at most twice that or 20%, whichever is more,
 * and low beyond, or when nothing bounds it.
 */
export function confidenceOf(errorBound: number | null | undefined, risk: number = BLAME_DEFAULTS.risk): Confidence {
  if (errorBound === null || errorBound === undefined) return 'low';
  if (errorBound <= risk + 1e-12) return 'high';
  return errorBound <= Math.max(2 * risk, 0.2) ? 'medium' : 'low';
}

/** A model response in one line: its tool calls with their arguments, and the start of its text. */
export function describeBlocks(blocks: readonly Block[], width = 100): string {
  const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);
  const parts = blocks.flatMap((b) => {
    if (b.type === 'tool_call') return [`${b.name}(${cut(JSON.stringify(b.input ?? {}), Math.max(20, width - b.name.length - 2))})`];
    if (b.type === 'text' && b.text.trim()) return [`"${cut(b.text.trim().replace(/\s+/g, ' '), width)}"`];
    return [];
  });
  return parts.length ? parts.join(', ') : '(no text or tool calls)';
}

export interface BlameContrast {
  callNo: number;
  /** What the model answered at the blamed call in the failed run. */
  recorded: Block[];
  /** What it answered there in a rescued fork. */
  rescued: Block[];
  rescuedRunId: string;
}

export interface BlameReport extends BlameSearchResult {
  runId: string;
  /** Model calls in the run. */
  steps: number;
  /** The most attempts a probe takes: the gate's `max`, or the fixed count. */
  attemptsPerProbe: number;
  /** Passing attempts that make a probe a rescue: the fixed count's, or with a gate the fewest that can (2 at 0.6, 0.1, 0.05). */
  needed: number;
  /**
   * The search's gate: its rates and attempts are each probe's, its risk the search's, spent across
   * `probeBudget` probes (`probeGate`). Null when a fixed count decided. Absent in reports made before gates.
   */
  gate?: SprtGate | null;
  /** The most probes the search's risk was split across: each probe's gate ran at its share. Absent before risk was split. */
  probeBudget?: number | null;
  /** How a probe re-asked the model: resampled as it was, or with request fields changed from that call on. */
  rescue: { fields: Record<string, unknown> };
  /** The oracle, as the labels of what a passing run must do. */
  oracle: string[];
  /** How the recording itself fails the oracle. */
  recordedFailures: string[];
  contrast: BlameContrast | null;
  /**
   * Probes rescued the run, yet every attempt that passed at the call the search ended on answered
   * it as the recording did: no answer of the model's made the difference, so no call is blamed and
   * the outcome is `unrescuable`. The call, an attempt that passed, and why it passed, in a sentence
   * or two. Absent from reports made before blame looked.
   */
  sameAnswer?: { callNo: number; runId: string; why: string } | null;
  /**
   * No probe rescued the run, and every attempt from the first model call (`callNo`) made a write
   * that failed when the run was recorded, the same call again, and met its error: the likely cause.
   * The tool and the recorded error's message. Absent from reports made before blame looked.
   */
  failedWrite?: { name: string; message: string; callNo: number } | null;
  /** Every attempt run, including those of a probe the search stopped before it settled. */
  attempts: number;
  /**
   * Attempts the provider was unavailable for, over the whole search: retried, never counted. When
   * it was unavailable for several in a row the search stops there, `stopped`, with `stopReason`
   * saying so (`unavailableStop`). Absent when there were none.
   */
  unavailable?: number;
  spent: number;
  upstreamRequests: number;
  /** What its judge checks' calls cost, apart from `spent` and `upstreamRequests`: only when a judge was asked. */
  judge?: { spent: number; upstreamRequests: number };
  /** Models with no price, whose cost is missing from `spent`. */
  unknownModels: string[];
  /** Why the search stopped early, for the `stopped` outcome. */
  stopReason: string | null;
  /** What the replays warned about, such as a connection that bypassed Shadowlap. */
  warnings: string[];
}

const short = (id: string) => id.slice(0, 10);

export function describeRescue(fields: Record<string, unknown>): string {
  const entries = rescueFields(fields);
  if (!entries.length) return 'resample the probed call';
  return `resample from the probed call on with ${entries.join(', ')}`;
}

const rescueFields = (fields: Record<string, unknown>): string[] => Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);

/** The columns the report is laid out for: an 80-column terminal. */
const COLUMNS = 80;
/** `  Probes ` and the continuation lines under it, which line up with its parenthesis. */
const PROBES = '  Probes ';
const UNDER = ' '.repeat(PROBES.length + 1);

/**
 * The Probes line: the rule, and what each probe changes under it, in parentheses. On one line when
 * that fits; else the rule on a line of its own and the change under it, its fields broken after a
 * comma onto further lines when they don't fit either. `head` follows `Probes`; each of `under` is
 * a line of its own, indented under the parenthesis.
 */
export function probesLines(rule: string, fields: Record<string, unknown>): { head: string; under: string[] } {
  const rescue = describeRescue(fields);
  if (`${PROBES}(${rule}; ${rescue})`.length <= COLUMNS) return { head: `(${rule}; ${rescue})`, under: [] };
  if (`${UNDER}${rescue})`.length <= COLUMNS) return { head: `(${rule};`, under: [`${rescue})`] };
  const under = ['resample from the probed call on with'];
  const parts = rescueFields(fields);
  let line = '';
  for (const [i, part] of parts.entries()) {
    const piece = `${part}${i === parts.length - 1 ? ')' : ','}`;
    if (line && `${UNDER}${line} ${piece}`.length > COLUMNS) {
      under.push(line);
      line = piece;
    } else line = line ? `${line} ${piece}` : piece;
  }
  under.push(line);
  return { head: `(${rule};`, under };
}

/**
 * A blame that placed the failure on no call only because its first probe couldn't tell: resampled
 * from the first model call, the run passed some of the time, between the gate's two rates. That is
 * no finding that the failure isn't one unlucky answer, so it reads apart, with low confidence.
 */
export function unsettledFirst(r: Pick<BlameReport, 'outcome' | 'probes' | 'sameAnswer' | 'failedWrite'>): boolean {
  return r.outcome === 'unrescuable' && !r.sameAnswer && !r.failedWrite && r.probes[0]?.decision === 'inconclusive';
}

/**
 * A blame that placed the failure on no call, in a few words, as a run's page, Needs a look and
 * `shadowlap show` say it: not settled when its first probe couldn't tell (`unsettledFirst`), else
 * not rescued from any model call.
 */
export const unrescuedWords = (unsettled: boolean): string => (unsettled ? 'not settled from the first model call' : 'not rescued from any model call');

/**
 * Why a blame placed the failure on no call (`unrescuable`), as its report and the dashboard's Blame
 * step say it: the evidence, then where to look. Passing attempts that answered as the recording did,
 * or a write's recorded error every attempt met again, mean no answer of the model's lost the run. A
 * first probe that couldn't tell says so, and how to settle it.
 */
export function unrescuedWhy(r: Pick<BlameReport, 'probes' | 'needed' | 'sameAnswer' | 'failedWrite'> & { gate?: SprtGate | null | undefined }): { evidence: string | null; look: string } {
  const notTheAnswer = "No answer of the model's lost this run: look at the tools, the harness or the command.";
  if (r.sameAnswer) return { evidence: r.sameAnswer.why, look: notTheAnswer };
  const first = r.probes[0];
  if (r.failedWrite) return { evidence: `Every attempt from the first model call, #${r.failedWrite.callNo}, made ${r.failedWrite.name}'s recorded call again and failed on its error, as the recording did: ${r.failedWrite.message}.`, look: notTheAnswer };
  // An attempt the oracle could not judge: no failure of the answer, and no probe says more until it can.
  if (first?.undecided) {
    return {
      evidence: `Resampled from the first model call, #${first.callNo}: an attempt could not be judged: ${first.undecided}.`,
      look: 'Not settled: a check could not be decided on an attempt, so no probe can say whether resampling rescues the run. Give it what decides it (a judge that can answer, a value its condition can read), and blame again.',
    };
  }
  const gated = !!first?.decision && !!r.gate;
  if (gated && first.decision === 'inconclusive') {
    const g = r.gate!;
    const lower = Math.max(0.05, +(g.good - 0.2).toFixed(2));
    return {
      evidence: `Resampled from the first model call, #${first.callNo}: ${probeFinding(first, g)}.`,
      look: `Not settled: resampled from #${first.callNo}, the run passes some of the time, too often to call it lost and too rarely to call it rescued, so it may still be an answer the model gets right only sometimes. More attempts or a lower bar settle it: --gate '{"good":${lower > g.bad ? lower : g.good},"max":${Math.min(1000, g.max * 2)}}'.`,
    };
  }
  // What "not rescued" means here: no resample of any call reaches the gate's rescue rate, since
  // the first call's rate bounds every later one's. A call the model gets right less often than that
  // can still be where the run was lost: a lower bar finds it.
  const lower = gated && r.gate!.good > 0.3 ? `--gate '{"good":0.3,"bad":${Math.min(r.gate!.bad, 0.05)}}'` : null;
  // Passes from the first call: it rescues the run now and then, below the bar, so the answer there
  // may still be what lost it, at a lower bar.
  if (gated && first && first.passes > 0) {
    return {
      evidence: `Resampled from the first model call, #${first.callNo}: ${probeFinding(first, r.gate)}.`,
      look: `No resample rescues it ${atLeast(r.gate!.good)} of the time, from any call, yet some attempts passed: an answer the model gets right only sometimes may still be what lost it.${lower ? ` A lower bar finds where: ${lower}.` : ''} Or rescue with a stronger model (--model).`,
    };
  }
  return {
    evidence: !first
      ? null
      : gated
        ? `Resampled from the first model call, #${first.callNo}: ${probeFinding(first, r.gate)}.`
        : `Resampling from the first model call, #${first.callNo}, passed ${probeTally(first, ' attempts')}, fewer than the ${r.needed} a rescue needs.`,
    look: `${gated ? `No resample rescues it ${atLeast(r.gate!.good)} of the time, from any call: the` : 'The'} failure is not one unlucky answer. Look at the prompt, the tools or the harness, or rescue with a stronger model (--model)${lower ? `; for an agent that rarely gets it right, a lower bar finds where it was lost: ${lower}` : ''}.`,
  };
}

/**
 * What blame found that says no answer of the model's lost a run it placed on no call, as a clause
 * for a repair's reason (`every attempt failed on post_digest's recorded error (channel_not_found:
 * #refunds)`), or null when it found nothing that says so: then the cause may still be the prompt.
 */
export function notTheAnswer(r: Pick<BlameReport, 'sameAnswer' | 'failedWrite'>): string | null {
  if (r.sameAnswer) return `every attempt that passed at #${r.sameAnswer.callNo} answered it as the recording did`;
  if (r.failedWrite) return `every attempt failed on ${r.failedWrite.name}'s recorded error (${r.failedWrite.message})`;
  return null;
}

/**
 * The probes the non-increasing fit pooled because their rates rose as the calls went on: each group
 * with the rate it was read as. Empty when the rates already fall, and for a report made before fits.
 */
export function pooledRates(r: Pick<BlameReport, 'probes'> & { fit?: BlameSearchResult['fit'] }): Array<{ calls: number[]; rate: number }> {
  if (!r.fit?.length) return [];
  // Consecutive probes read as the same rate: the fit's pooled blocks.
  const groups: Array<{ calls: number[]; rate: number }> = [];
  for (const f of r.fit) {
    if (f.rate === null || !r.probes.some((x) => x.callNo === f.callNo)) continue;
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.rate - f.rate) < 1e-12) last.calls.push(f.callNo);
    else groups.push({ calls: [f.callNo], rate: f.rate });
  }
  // A group is pooled when its probes' own rates differ from the rate they were read as.
  return groups.filter((g) => g.calls.length > 1 && g.calls.some((c) => Math.abs(judgedRate(r.probes.find((x) => x.callNo === c)!).rate - g.rate) > 1e-9));
}

/** An error bound as a percentage, to a tenth of a point and rounded up, so it never reads as less than it is; below 0.1% it says so rather than round to 0%. */
const share = (x: number): string => (x > 0 && x < 0.001 ? '<0.1%' : `${+(Math.ceil(+(x * 1000).toPrecision(12)) / 10).toFixed(1)}%`);

/**
 * The range a blame reports, as its calls: where it ends (null when pinned to one call), the probe
 * that closes it (the first call after it found lost; for a gradual range, the next call, found lost
 * itself), and the probes inside it, which claimed nothing. Null when it blamed no call, and for a
 * report made before ranges.
 */
export function blameSpan(r: Pick<BlameReport, 'blamed' | 'probes'> & { range?: BlameSearchResult['range'] }): { end: { callNo: number; step: number } | null; closing: BlameProbe | null; between: BlameProbe[] } | null {
  const range = r.range;
  if (!r.blamed || !range) return null;
  const toStep = range.toStep ?? r.probes.find((x) => x.callNo === range.to)?.step ?? null;
  if (range.gradual && toStep !== null) return { end: { callNo: range.to, step: toStep }, closing: r.probes.find((x) => x.callNo === range.to) ?? null, between: [] };
  const closing = toStep === null ? null : (r.probes.find((x) => x.step === toStep + 1 && probeClaim(x) === 'lost') ?? null);
  if (range.to === range.from || toStep === null) return { end: null, closing, between: [] };
  return { end: { callNo: range.to, step: toStep }, closing, between: r.probes.filter((x) => x.callNo > range.from && x.callNo <= range.to) };
}

/**
 * The first line of a blame that placed the failure on no call. "Not rescued from any model call"
 * only when the bound supports it: the first probe found the run lost there, with its error within
 * the search's risk (or, for a report made before bounds, as blame said it then). A rule that may be
 * wrong more often than that says only what it saw: not rescued from the first model call. A first
 * probe that couldn't tell is not settled.
 */
export function unrescuedHead(r: Pick<BlameReport, 'outcome' | 'probes' | 'sameAnswer' | 'failedWrite' | 'confidence'> & { errorBound?: number | null }, p: Palette = plain): string {
  if (unsettledFirst(r)) return `${p.yellow('?')} ${p.bold('Not settled from the first model call')}`;
  const supported = r.sameAnswer || r.failedWrite || r.errorBound === undefined || r.confidence === 'high';
  return `${p.red('✗')} ${p.bold(supported ? 'Not rescued from any model call' : 'Not rescued from the first model call')}`;
}

/**
 * What a blame's confidence rests on, in a few words: the most its range (or its finding that no call
 * rescues the run) is wrong, the probes that decided and what each may get wrong; or why nothing
 * bounds it.
 */
export function confidenceWhy(r: Pick<BlameReport, 'outcome' | 'probes' | 'nonMonotone'> & { errorBound?: number | null; range?: BlameSearchResult['range']; pin?: PinCheck | null }): string {
  if (r.outcome === 'stopped') return 'the search did not finish';
  const first = r.probes[0];
  // A report made before blame bounded its error keeps the label it had.
  if (r.errorBound === undefined) return 'as blame read it before it bounded its error';
  if (r.errorBound === null) {
    if (r.outcome === 'unrescuable' && first && probeClaim(first) === null) return `#${first.callNo} was inconclusive`;
    if (r.nonMonotone.length) return `rescue rose again at ${r.nonMonotone.map((x) => `#${x.rescued} after #${x.lost} was lost`).join(', ')}, more than chance explains: the boundary is not clean`;
    return 'nothing bounds its error: a probe has no risk of its own';
  }
  const claims = r.probes.filter((x) => probeClaim(x) !== null);
  const each = claims.length > 1 && claims.every((x) => x.risk === claims[0]!.risk) ? `, at <= ${share(claims[0]!.risk!)} risk each` : '';
  const what = r.outcome === 'unrescuable' ? 'this' : r.range && r.range.to !== r.range.from ? 'the range' : 'the call';
  const rose = r.nonMonotone.length ? `; rescue rose again at ${r.nonMonotone.map((x) => `#${x.rescued} after #${x.lost} was lost`).join(', ')}` : '';
  const checked = r.pin && r.pin.verdict !== 'inconclusive' ? `, and the check of #${r.pin.callNo}, at <= ${share(r.pin.risk)}` : '';
  return `<= ${share(r.errorBound)} risk that ${what} is wrong: ${claims.length} probe${claims.length === 1 ? '' : 's'} decided${each}${checked}${rose}`;
}

export function formatBlame(r: BlameReport, p: Palette = plain): string {
  const lines: string[] = [];
  const call = (x: { callNo: number }) => `#${x.callNo}`;
  const where = (x: BlameProbe) => `model call ${call(x)} (${x.step} of ${r.steps})`;

  const span = blameSpan(r);
  if (r.outcome === 'blamed' && r.blamed) {
    const b = r.blamed;
    const end = span?.end ?? null;
    const gradual = r.range?.gradual === true;
    lines.push(`${p.yellow('⑂')} ${p.bold(end ? `The run was lost ${gradual ? 'gradually, around' : 'between'} model calls ${call(b)} and ${call(end)} (${b.step} to ${end.step} of ${r.steps})` : `The run was lost at ${where(b)}`)}`);
    // What closes the range: the next model call when it was probed, else the first call after it found lost.
    const closing = span ? span.closing : r.lost;
    const tail = (finding: (x: BlameProbe) => string) =>
      !end
        ? r.lost
          ? `${call(r.lost)}, the next model call: ${finding(r.lost)}.`
          : 'it is the last model call, and the recording, which kept its answer, fails.'
        : closing
          ? `${call(closing)}, ${gradual ? 'the next model call' : 'the first call after it found lost'}: ${finding(closing)}.`
          : 'no call after it was found lost, and the recording, which kept every answer, fails.';
    if (r.gate && b.decision) {
      // Decided by a gate: each side's verdict and tally; the rule is said once, over the probes.
      lines.push(`  The re-asked call ${call(b)}: ${probeFinding(b, r.gate)}; ${tail((x) => probeFinding(x, r.gate))}`);
    } else {
      const counted = (x: BlameProbe) => (x.undecided ? `inconclusive, ${probeTally(x, ' passed')}` : `rescued ${probeTally(x)}`);
      const after = !end && r.lost?.undecided ? `${call(r.lost)}, the next model call, was inconclusive: ${probeTally(r.lost, ' passed')}.` : !end && r.lost ? `resampling ${call(r.lost)}, the next model call, rescued ${probeTally(r.lost)}.` : tail(counted);
      lines.push(`  Resampling ${call(b)} rescued ${probeTally(b, ' attempts')}; ${after}`);
    }
    if (span?.between.length) lines.push(`  ${span.between.map(call).join(', ')} between them ${span.between.length === 1 ? 'was' : 'were'} inconclusive: the run may have been lost at any call from ${call(b)} to ${call(end ?? b)}.`);
    if (r.pin) lines.push(`  ${safeLine(pinWords(r.pin))}`);
  } else if (r.outcome === 'unrescuable') {
    const why = unrescuedWhy(r);
    lines.push(unrescuedHead(r, p));
    if (why.evidence) lines.push(`  ${safeLine(why.evidence)}`);
    lines.push(`  ${why.look}`);
  } else {
    lines.push(`${p.yellow('!')} ${p.bold('Stopped before the search finished')}${r.stopReason ? `: ${r.stopReason}` : ''}`);
    // The probe past the last rescue lost the run there, or could not tell, which is no loss.
    const after = r.lost ? (probeWord(r.lost) === 'inconclusive' ? `, inconclusive at ${call(r.lost)}` : `, lost from ${call(r.lost)}`) : '';
    lines.push(r.blamed ? `  So far: rescued up to ${call(r.blamed)}${after}.` : '  So far no probe had settled.');
  }
  if (!r.sameAnswer) lines.push(`  Confidence: ${r.confidence === 'high' ? p.green('high') : r.confidence === 'medium' ? p.yellow('medium') : p.red('low')} ${p.dim(`(${confidenceWhy(r)})`)}`);

  if (r.contrast) {
    const label = `At #${r.contrast.callNo}`;
    const pad = ' '.repeat(label.length);
    lines.push('', `  ${label}  ${p.dim('the recording ')}  ${safeLine(describeBlocks(r.contrast.recorded))}`);
    lines.push(`  ${pad}  ${p.dim('a rescued fork')}  ${safeLine(describeBlocks(r.contrast.rescued))}`);
  }

  if (r.probes.length) {
    // The rule and what each probe changes under it, each line within an 80-column terminal.
    const { head, under } = probesLines(rescueRule(r), r.rescue.fields);
    lines.push('', `  ${p.bold('Probes')} ${p.dim(head)}`, ...under.map((u) => `${UNDER}${p.dim(u)}`));
    const w = Math.max(...r.probes.map((x) => String(x.callNo).length)) + 1;
    // Each probe's tally, and under a gate the bound on the attempts it decided on (probeBound).
    const tallies = r.probes.map((x) => [probeTally(x, ' passed'), probeBound(x, r.gate)].filter(Boolean).join(' · '));
    const tw = Math.max(14, ...tallies.map((t) => t.length));
    for (const [i, x] of r.probes.entries()) {
      const blamed = r.blamed?.callNo === x.callNo;
      const word = probeWord(x);
      const verdict = word === 'rescued' ? p.green(word) : word === 'inconclusive' ? p.yellow(word) : p.red(word);
      const mark = blamed ? p.yellow('  ◂ blamed') : '';
      lines.push(`    ${`#${x.callNo}`.padEnd(w)}  ${`${x.step} of ${r.steps}`.padEnd(String(r.steps).length * 2 + 4)}  ${tallies[i]!.padEnd(tw)}  ${verdict}${mark}`);
    }
    // Where rescue rose as the calls went on, the fit reads the probes as one rate.
    for (const pooled of pooledRates(r)) lines.push(p.dim(`    ${pooled.calls.map((c) => `#${c}`).join(', ')} read as one rate, ${pooled.rate.toFixed(2)}: rescue rose after it fell`));
  }

  if (r.warnings.length) lines.push('', ...r.warnings.map((w) => `  ${p.yellow('!')} ${safeLine(w)}`));
  const attempts = r.attempts;
  const unpriced = r.unknownModels.length ? ` (no price for ${r.unknownModels.map(safeLine).join(', ')})` : '';
  const judged = r.judge ? ` · judge checks: ${r.judge.upstreamRequests} upstream request${r.judge.upstreamRequests === 1 ? '' : 's'}, ≈${formatUsd(r.judge.spent)}` : '';
  // Attempts the provider was unavailable for ran and were paid for, but never counted.
  const down = r.unavailable ? ` (and ${r.unavailable} the provider was unavailable for, not counted)` : '';
  lines.push('', p.dim(`  ${attempts} attempt${attempts === 1 ? '' : 's'}${down} · ${r.upstreamRequests} upstream requests · ≈${formatUsd(r.spent)} spent${unpriced}${judged} · every call before a probe replayed from the recording`));
  lines.push(p.dim(`  oracle: ${r.oracle.map(safeLine).join('; ')}`));
  if (r.contrast) lines.push(p.dim(`  rescued fork: shadowlap diff ${short(r.runId)} ${short(r.contrast.rescuedRunId)}    shadowlap ui ${short(r.contrast.rescuedRunId)} --call ${r.contrast.callNo}`));
  else if (r.outcome === 'unrescuable' && r.sameAnswer) lines.push(p.dim(`  an attempt that passed: shadowlap diff ${short(r.runId)} ${short(r.sameAnswer.runId)}    shadowlap ui ${short(r.sameAnswer.runId)} --call ${r.sameAnswer.callNo}`));
  return lines.join('\n');
}
