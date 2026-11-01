import { describeBaselineRule, dimLines, dropBound, outcomeOf, probeFinding, probeGate, rescueRule, unavailableStop, type BlameReport, type FixStatus, type StoredFix, type VerdictStanding, type VerifyOutcome, type VerifyReport, type VerifyRole, whole } from '@shadowlap/engine';
import { AGENT_NODE_TOO_OLD } from '../agent-node.js';
import type { BlameError, BlameRun } from '../blame.js';
import { EXIT, interruptedStatus, stoppedBy } from '../exit-codes.js';
import { shortFixId } from '../fix-format.js';
import { palette as p, safe } from '../ui.js';

/** How blame, verify and repair report: their reports as `--json` prints them, the fix each reported to, and the status each ends with. */

/** A gate's result as `--json` prints it beside a run or a probe: its decision, the pass rate's interval and its sentence. */
const gateJson = (g: { decision: string; interval: unknown; sentence: string } | null | undefined) => (g ? { decision: g.decision, interval: g.interval, sentence: g.sentence } : null);

/** A good run kept against its baseline, as `--json` prints its verdict: the decision, the drop's interval and the sentence, rule included. */
function keptJson(x: VerifyReport['runs'][number], r: VerifyReport): { decision: string; drop: unknown; sentence: string } {
  const bound = x.drop ? dropBound(x.drop, x.decision) : null;
  const rule = r.kept ? ` · ${describeBaselineRule({ ...r.kept, revision: r.kept.label ?? r.kept.revision ?? null })}` : '';
  const tally = `${x.passes} of ${x.attempts.length} passed, baseline ${x.baseline!.passes} of ${x.baseline!.attempts}`;
  return { decision: x.decision ?? 'continue', drop: x.drop ?? null, sentence: `${outcomeOf(x)} · ${tally}${bound ? ` · ${bound}` : ''}${rule}` };
}

/** The report as `--json` prints it: stable field names for scripts and coding agents. */
export function blameJson(r: BlameReport & Partial<Pick<BlameRun, 'fix'>>): Record<string, unknown> {
  const probe = (x: NonNullable<BlameReport['blamed']>) => ({ callNo: x.callNo, step: x.step, passes: x.passes, attempts: x.attempts.length });
  return {
    runId: r.runId,
    fix: r.fix ? { fixId: r.fix.fixId, title: r.fix.title, status: r.fix.status, opened: r.fix.opened } : null,
    outcome: r.outcome,
    confidence: r.confidence,
    // The calls the run was lost between (one when pinned), and the most that, or a finding that no call
    // rescues it, may be wrong: the risks of the probes that decided, summed. Null when nothing bounds it.
    // Two calls, gradual, when the check of the call the probes pinned found no drop there beyond chance.
    range: r.range ? { from: r.range.from, to: r.range.to, ...(r.range.gradual ? { gradual: true } : {}) } : null,
    errorBound: r.errorBound ?? null,
    // That check: its verdict, the pairs it ran and what passed at each call, its rule and the most its verdict may be wrong.
    pin: r.pin ? { callNo: r.pin.callNo, next: r.pin.next, verdict: r.pin.verdict, pairs: r.pin.dropped + r.pin.rose + r.pin.same, passes: r.pin.passes, nextPasses: r.pin.nextPasses, dropped: r.pin.dropped, rose: r.pin.rose, rule: r.pin.rule, risk: r.pin.risk, undecided: r.pin.undecided ?? null, cutShort: r.pin.cutShort ?? 0, runs: r.pin.pairs } : null,
    blamed: r.blamed ? probe(r.blamed) : null,
    lost: r.lost ? probe(r.lost) : null,
    modelCalls: r.steps,
    attemptsPerProbe: r.attemptsPerProbe,
    passesNeeded: r.needed,
    gate: r.gate ?? null,
    // The search's risk is spent across up to probeBudget probes: each ran under probeGate, at its share.
    probeBudget: r.probeBudget ?? null,
    probeGate: r.gate && r.probeBudget ? probeGate(r.gate, r.probeBudget) : null,
    rescue: r.rescue,
    oracle: r.oracle,
    recordedFailures: r.recordedFailures,
    contrast: r.contrast,
    sameAnswer: r.sameAnswer ?? null,
    failedWrite: r.failedWrite ?? null,
    // A probe's sentence in blame's words, as its report says it: rescued or lost, the tally, the bound and the rule;
    // and the attempts the provider was unavailable for, retried and never counted.
    // and those it cut short after the model answered, which the gate counted against either verdict.
    probes: r.probes.map((x) => ({ ...probe(x), rescued: x.rescued, decision: x.decision ?? null, rate: x.gate && !x.undecided ? { ...gateJson(x.gate)!, sentence: `${probeFinding(x, r.gate ?? null)} · ${rescueRule(r)}` } : null, undecided: x.undecided ?? null, risk: x.risk ?? null, unavailable: x.unavailable ?? 0, cutShort: x.cutShort ?? 0, runs: x.attempts })),
    // The probes' rescue rates fitted non-increasing, in call order.
    fit: r.fit ?? [],
    nonMonotone: r.nonMonotone,
    // Attempts the provider was unavailable for over the search, retried and never counted, beside those that were.
    cost: { attempts: r.attempts, unavailable: r.unavailable ?? 0, spent: r.spent, upstreamRequests: r.upstreamRequests, unknownModels: r.unknownModels },
    // Judge checks' calls, apart from the agent's: what they sent upstream and spent. Null when no judge was asked live.
    judge: r.judge ?? null,
    stopReason: r.stopReason,
    warnings: r.warnings,
  };
}

/** The report as `verify --json` prints it, with the verdict's id and the fixes it was kept with. */
export function verifyJson(r: VerifyReport, kept?: { verifyId: string; fixes: Array<{ fix: Pick<StoredFix, 'fixId' | 'title' | 'status'>; standing: VerdictStanding | null }> } | null): Record<string, unknown> {
  const count = (role: VerifyRole) => {
    const of = r.runs.filter((x) => x.role === role);
    // A run that is inconclusive (its gate ran out between its bounds, or an attempt could not be judged) is counted apart, never as one that failed.
    return { passed: of.filter((x) => x.verdict === 'pass').length, inconclusive: of.filter((x) => outcomeOf(x) === 'inconclusive').length, total: of.length };
  };
  return {
    verdict: r.verdict,
    verifyId: kept?.verifyId ?? null,
    fixes: keptFixes(kept?.fixes ?? []),
    reasons: r.reasons,
    warnings: [...r.warnings, ...r.replayWarnings],
    codeVersion: r.codeVersion,
    oracle: r.oracle,
    attemptsPerRun: r.attemptsPerRun,
    passesNeeded: r.needed,
    gate: r.gate ?? null,
    change: { fields: r.fields },
    summary: { targets: count('target'), holdout: count('holdout'), good: count('good') },
    runs: r.runs.map((x) => ({
      runId: x.runId,
      role: x.role,
      outcome: outcomeOf(x).replace(' ', '-'),
      passes: x.passes,
      attempts: x.attempts.length,
      decision: x.decision ?? null,
      rate: x.undecided ? null : x.baseline ? keptJson(x, r) : gateJson(x.gate),
      deterministic: x.deterministic,
      recorded: x.recorded,
      undecided: x.undecided ?? null,
      // A good run decided against its own baseline: the baseline's tally and where it came from, the
      // margin, the bound on the drop, and the baseline's attempts; why there was none, when none.
      ...(x.baseline ? { baseline: x.baseline, margin: x.margin ?? null, drop: x.drop ?? null } : {}),
      ...(x.baselineRuns ? { baselineRuns: x.baselineRuns } : {}),
      ...(x.noBaseline ? { noBaseline: x.noBaseline } : {}),
      // Attempts the provider was unavailable for, the change's and the baseline's: retried, never counted;
      // and those it cut short after the model answered, counted against either verdict.
      unavailable: x.unavailable ?? 0,
      cutShort: x.cutShort ?? 0,
      runs: x.attempts,
    })),
    // The rule good runs were kept by: against what, the margin, the risk and the most pairs or attempts.
    kept: r.kept ?? null,
    // Attempts the provider was unavailable for, both arms', retried and never counted, beside those that were.
    cost: { attempts: r.attempts, unavailable: r.unavailable ?? 0, spent: r.spent, upstreamRequests: r.upstreamRequests, unknownModels: r.unknownModels },
    // Judge checks' calls, apart from the agent's: what they sent upstream and spent. Null when no judge was asked live.
    judge: r.judge ?? null,
    stopReason: r.stopReason,
  };
}

/**
 * The fix a command reported to, in a dim line after its report: `fix fx-01K… · title · opened`,
 * fit to a terminal `columns` wide with the command to show it in one piece; whole with none.
 */
export function fixLine(fix: { fixId: string; title: string }, what: string, columns?: number | null): string {
  return `${dimLines(p, '  ', `fix ${shortFixId(fix.fixId)} · ${safe(fix.title)} · ${what} · ${whole(`shadowlap fix show ${shortFixId(fix.fixId)}`)}`, columns).join('\n')}\n`;
}

/** What a verdict did to a fix, in a few words: `verified`, `rejected verdict kept`, or why it doesn't count. */
export function standingWords(verdict: VerifyOutcome, standing: VerdictStanding, status: FixStatus): string {
  if (standing.counts) return verdict === 'accepted' ? status : `${verdict} verdict kept`;
  const why = standing.why === 'another-check' ? 'checked under another check' : standing.why === 'already-passing' ? 'its runs already passed as recorded' : 'none of its runs fails here';
  return `${verdict} verdict kept, not counted (${why}); still ${status}`;
}

/** The fixes a verdict was kept with, as `--json` prints them. */
export const keptFixes = (fixes: Array<{ fix: Pick<StoredFix, 'fixId' | 'title' | 'status'>; standing: VerdictStanding | null }>) =>
  fixes.map(({ fix, standing }) => ({ fixId: fix.fixId, title: fix.title, status: fix.status, counts: standing?.counts ?? null, why: standing && !standing.counts ? standing.why : null }));

/** Every attempt a verify made, each run's and each good run's baseline's. */
export function verifyAttempts(r: VerifyReport): VerifyReport['runs'][number]['attempts'] {
  return r.runs.flatMap((x) => [...x.attempts, ...(x.baselineRuns ?? [])]);
}

/**
 * The status of a blame, verify or repair that stopped before its verdict, by why: a stop signal's
 * own; 3 for a budget spent or a provider that stayed unavailable; 2 for an agent whose Node is too
 * old for the guard; 1 otherwise.
 */
export function stoppedStatus(reason: string | null): number {
  if (stoppedBy() || reason === 'interrupted') return interruptedStatus();
  if (reason?.includes('budget')) return EXIT.inconclusive;
  // The provider never answered: nothing was decided about the agent, so inconclusive, never failed.
  if (unavailableStop(reason)) return EXIT.inconclusive;
  if (reason === AGENT_NODE_TOO_OLD) return EXIT.usage;
  return EXIT.failed;
}

/**
 * Why blame could not start or could not trust what it saw, as a status: the run has no model call
 * to probe, or a budget was given for a model with no price, 2; what it saw could not be decided, 3;
 * cut short by a signal, its status; the run passes, or does not replay as recorded, 1.
 */
export function blameErrorStatus(reason: BlameError['reason']): number {
  if (reason === 'interrupted' || stoppedBy()) return interruptedStatus();
  if (reason === 'no-model-calls' || reason === 'unpriced') return EXIT.usage;
  if (reason === 'inconclusive') return EXIT.inconclusive;
  return EXIT.failed;
}
