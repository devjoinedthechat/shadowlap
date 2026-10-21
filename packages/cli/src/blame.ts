import { agentCallsOf, attemptsToPass, canonicalize, checkStatus, decide, decideCount, endedEarlyCount, formatDivergence, formatDuration, formatUsd, gateResult, normalizeResponse, probeFinding, probeTally, searchBlame, type BlameAttempt, type BlameProbe, type BlameReport, type Block, type CallRecord, type FixStatus, type GateDecision, type RunRecord, type SprtGate, type Store, type StoredCheck } from '@shadowlap/engine';
import { type Interventions } from '@shadowlap/sidecar';
import { AttemptRunner, BYPASSED, type Attempt, type AttemptSettings } from './attempts.js';
import { recordBlameFix } from './fixes.js';
import { type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';

/**
 * `shadowlap blame`: runs the probes the engine's search asks for (`searchBlame` in @shadowlap/engine
 * says what they mean). Each attempt replays the failed run up to the probed model call, forces that
 * call live, and runs the rest live with writes fenced; the oracle then judges what came out. A write
 * the recording made, with the same arguments, gets what it got then, an error included: a stub never
 * fails, so a run that failed on a write's error would pass every probe for no reason of the model's.
 */

export interface BlameSettings extends AttemptSettings {
  /** A fixed count: attempts per probe, and how many must pass for the probe to rescue the run. Used when `gate` is null. */
  attempts: number;
  needed: number;
  /** The gate that decides each probe after every attempt: rescued at `good`, lost at `bad` (stats.ts); null for the fixed count. */
  gate: SprtGate | null;
  /** Attempts of one probe running at once. */
  concurrency: number;
  /** Model calls past the boundary to probe as well. */
  scan: number;
  /** Request fields set from the probed call on (`--model`, `--set`); empty to resample as recorded. */
  fields: Record<string, unknown>;
  /** Probe only model calls made in this scope (or one nested in it): the agent's, not a simulated user's. */
  scope?: string | null;
}

/** Whether a call was made in `scope`, or in a scope nested in it (`agent/planner` is in `agent`). */
export function inScope(callScope: unknown, scope: string | null | undefined): boolean {
  if (!scope) return true;
  return typeof callScope === 'string' && (callScope === scope || callScope.startsWith(`${scope}/`));
}

export interface BlameInput {
  opts: GlobalOpts;
  parent: RunRecord;
  argv: string[];
  commandFromImport: boolean;
  settings: BlameSettings;
  /** The blame as it was typed, kept with its fix; made from the settings when not given (a blame a repair ran). */
  command?: string;
  /** Progress, a line at a time. */
  log: (line: string) => void;
}

/** Blame could not start or could not trust what it saw; the message says why and what to do. */
export class BlameError extends Error {
  /**
   * What judge checks' calls sent upstream and spent before it stopped, or null when none was asked
   * live: a replay as recorded is free for the agent, but not for a judge its recording held no
   * verdict for.
   */
  judge: { spent: number; upstreamRequests: number } | null = null;

  constructor(
    message: string,
    readonly reason: 'no-model-calls' | 'diverged' | 'bypassed' | 'passes' | 'unpriced' | 'inconclusive' | 'prefix' | 'interrupted',
  ) {
    super(message);
    this.name = 'BlameError';
  }
}

/** A blame's report, and the fix it opened or joined: null when the store refused to keep it. */
export interface BlameRun extends BlameReport {
  fix: { fixId: string; title: string; status: FixStatus; opened: boolean; blameId: string } | null;
}

/**
 * A probe's attempts as its gate reads them. With --concurrency, attempts end in any order, and how
 * long one takes can depend on how it comes out (one that fails may run to a timeout), so the gate
 * reads them in the order they started, as one after another would, each once all those started
 * before it have ended. Its first answer other than continue is kept: attempts still running then
 * are evidence, but nothing decides again, so a verdict once reached never reopens, and the caller
 * starts no attempt after it. An attempt that could not be judged (null) decides the probe
 * inconclusive when its turn comes, on the attempts before it: no attempt after it would say more.
 */
export class ProbeTally {
  private readonly outcomes: Array<boolean | null | undefined> = [];
  private seen = 0;
  private passes = 0;
  /** The first answer other than continue, and after how many attempts (by the order they started); null until then. */
  decided: { decision: GateDecision; at: number } | null = null;

  constructor(private readonly settle: (passes: number, attempts: number) => GateDecision) {}

  /** Attempt `n` (the nth to start, from 1) ended, and passed or not, or (null) could not be judged. */
  add(n: number, passed: boolean | null): void {
    this.outcomes[n - 1] = passed;
    while (!this.decided && this.seen < this.outcomes.length && this.outcomes[this.seen] !== undefined) {
      if (this.outcomes[this.seen] === null) {
        this.decided = { decision: 'inconclusive', at: this.seen };
        break;
      }
      if (this.outcomes[this.seen]) this.passes++;
      this.seen++;
      const d = this.settle(this.passes, this.seen);
      if (d !== 'continue') this.decided = { decision: d, at: this.seen };
    }
  }

  /** The attempts the decision rests on, in the order they started. */
  decidedOn(): boolean[] {
    return this.decided ? (this.outcomes.slice(0, this.decided.at) as boolean[]) : [];
  }
}

export async function runBlame(input: BlameInput): Promise<BlameRun> {
  const { parent, settings: s, log } = input;
  const target = { parent, argv: input.argv, commandFromImport: input.commandFromImport };
  const runner = await AttemptRunner.start(input.opts, s);
  const { store } = runner;
  try {
    // The agent's model calls: a judge check's are none of its answers, so never a step to blame.
    const parentCalls = agentCallsOf(store.getCalls(parent.runId));
    const steps = parentCalls.filter((c) => c.kind === 'api' && c.end && inScope(c.meta.scope, s.scope)).map((c) => c.callNo);
    if (!steps.length) {
      if (s.scope) {
        const scopes = [...new Set(parentCalls.filter((c) => c.kind === 'api' && typeof c.meta.scope === 'string').map((c) => String(c.meta.scope)))];
        throw new BlameError(`${shortId(parent.runId)} made no model calls in scope ${s.scope}${scopes.length ? ` (its scopes: ${scopes.join(', ')})` : ' (it used no scopes)'}`, 'no-model-calls');
      }
      throw new BlameError(`${shortId(parent.runId)} made no model calls, so no answer of the model's can be blamed`, 'no-model-calls');
    }

    // The recording, replayed as it is: free, and it must fail the way it did, or the probes that
    // follow would be judging something the recording doesn't show.
    log(p.dim(`  replaying ${shortId(parent.runId)} as recorded, to see it fail…`));
    const group = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const baseline = await runner.attempt(target, { meta: { repeat: { group: `${group}-as-recorded`, attempt: 1, of: 1 } } }, false);
    store.deleteRun(baseline.run.runId);
    if (runner.interrupted) throw new BlameError('interrupted before the first probe', 'interrupted');
    if (baseline.bypassed) throw new BlameError(`${shortId(parent.runId)} did not replay through Shadowlap: ${BYPASSED}`, 'bypassed');
    if (baseline.summary.divergence) {
      throw new BlameError(
        `${shortId(parent.runId)} does not replay as recorded, so a probe could not tell a changed answer from a changed prefix:\n\n${formatDivergence(baseline.summary.divergence)}\n\nMake the replay clean first: shadowlap calibrate ${shortId(parent.runId)}`,
        'diverged',
      );
    }
    const oracle = runner.oracle();
    if (baseline.passed) {
      throw new BlameError(`${shortId(parent.runId)} passes its oracle when replayed (${oracle.join('; ')}), so there is no failure to blame. Say what it should have done with --expect.`, 'passes');
    }
    // A cost check fails on a model with no price whatever the model answers: no probe could rescue
    // the run, and searching would spend money to say it is not the answer, which says nothing.
    const unpriced = unpricedOnly(baseline);
    if (unpriced) {
      throw new BlameError(`${shortId(parent.runId)} fails only because ${unpriced.join(', ')} ${unpriced.length === 1 ? 'has' : 'have'} no price, so the cost check can't be judged whatever the model answers. Add ${unpriced.length === 1 ? 'it' : 'them'} under "prices" in shadowlap.config.json, and blame again if it still fails.`, 'unpriced');
    }
    // A check that can't be decided on the recording (a judge with no verdict, a condition it can't
    // read) can't be on a probe either, and a probe passes only when every check does: none could,
    // whatever the model answers, so searching would spend money to say nothing.
    const undecided = inconclusiveChecks(baseline);
    if (undecided.length) {
      const one = undecided.length === 1;
      throw new BlameError(
        `${shortId(parent.runId)} has ${one ? 'a check' : `${undecided.length} checks`} that can't be decided as recorded, so no probe could pass whatever the model answers: ${undecided.map((c) => `${c.label} (${c.detail ?? 'inconclusive'})`).join('; ')}. Give ${one ? 'it what it needs' : 'them what they need'} (a verdict for a judge, a value a condition can read), or leave ${one ? 'it' : 'them'} out of --expect, and blame again.`,
        'inconclusive',
      );
    }
    log(`  ${p.green('✓')} replays as recorded and fails: ${baseline.failures.join('; ')}`);

    // A probe is decided after each attempt: by the gate, rescued at `good` and lost at `bad`, or by the fixed count.
    const limit = s.gate ? s.gate.max : s.attempts;
    const settle = (passes: number, done: number): GateDecision => (s.gate ? decide(passes, done, s.gate) : decideCount(passes, done, s.attempts, s.needed));
    const probe = async (callNo: number, step: number): Promise<BlameProbe | null> => {
      if (!runner.canStart()) return null;
      log(`  ${p.bold(`model call #${callNo}`)} ${p.dim(`(${step} of ${steps.length})`)}`);
      const done: Array<BlameAttempt | undefined> = [];
      const tally = new ProbeTally(settle);
      let launched = 0;
      let prefixBroken: string | null = null;
      const interventions: Interventions | undefined = Object.keys(s.fields).length ? { set: { fromCall: callNo, fields: s.fields } } : undefined;
      const worker = async () => {
        while (!prefixBroken && !tally.decided && launched < limit && runner.canStart()) {
          const n = ++launched;
          const marks = { repeat: { group: `${group}-${callNo}`, attempt: n, of: limit }, probe: { of: parent.runId, callNo, passed: false } };
          const a = await runner.attempt(target, { divergeAt: callNo, recordedWrites: true, ...(interventions ? { interventions } : {}), meta: marks });
          // Stopped by Ctrl-C part way: what it did is no evidence either way.
          if (runner.interrupted) break;
          const d = a.summary.divergence;
          // Every attempt must fork exactly at the probed model call. One that forked elsewhere ran a
          // prefix the recording doesn't hold, and its outcome says nothing about call #callNo.
          if (!d || d.type !== 'forced' || d.callNo !== callNo || d.kind !== 'api') {
            prefixBroken = d?.type === 'ended_early'
              ? `An attempt at model call #${callNo} never reached it: the agent stopped first, after ${endedEarlyCount(d)}. The calls before #${callNo} don't replay the same way twice, so no probe can be trusted. Make replays clean first: shadowlap calibrate ${shortId(parent.runId)}`
              : d
              ? `An attempt at model call #${callNo} forked at call ${d.callNo} instead:\n\n${formatDivergence(d)}\n\nThe calls before #${callNo} don't replay the same way twice, so no probe can be trusted. Make replays clean first: shadowlap calibrate ${shortId(parent.runId)}`
              : `An attempt at model call #${callNo} never reached it: the agent took another path through calls the recording holds. Make replays clean first: shadowlap calibrate ${shortId(parent.runId)}`;
          }
          store.updateRunMeta(a.run.runId, { probe: { ...marks.probe, passed: a.passed, verdict: a.verdict }, ...(a.checks.length ? { checks: a.checks } : {}) });
          done[n - 1] = { runId: a.run.runId, passed: a.passed, verdict: a.verdict, exitCode: a.code, failures: a.failures, spent: a.summary.cost.spent, upstreamRequests: a.summary.upstreamRequests };
          const late = tally.decided !== null;
          // An attempt that all it fell short on is a check that could not be decided says nothing of the answer re-asked.
          tally.add(n, a.verdict === 'inconclusive' ? null : a.passed);
          log(`    ${p.dim(`attempt ${n}`)}  ${describeAttempt(a)}${late ? p.dim(' · ended after the probe decided') : ''}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(s.concurrency, limit) }, worker));
      if (prefixBroken) throw new BlameError(prefixBroken, 'prefix');
      const attempts = done.filter((a): a is BlameAttempt => a !== undefined);
      // Interrupted or out of budget with the verdict still open: this probe proves nothing.
      const decided = tally.decided;
      if (!decided) return null;
      const decision = decided.decision;
      const passes = attempts.filter((a) => a.passed).length;
      const rescued = decision === 'pass';
      // An attempt that could not be judged stopped the probe, inconclusive, whatever decides it: with
      // why. One that ended after a gate or a count had decided it is only a late attempt.
      const stopper = attempts.find((a) => a.verdict === 'inconclusive');
      const undecided = decision === 'inconclusive' ? (stopper?.failures[0] ?? null) : null;
      // The gate's result rests on the attempts it decided on: the first to start, up to the one that settled it.
      const found: BlameProbe = { callNo, step, attempts, passes, rescued, ...(s.gate ? { decision, gate: gateResult(s.gate, tally.decidedOn(), { decision: undecided ? 'continue' : decision }) } : undecided ? { decision } : {}), ...(undecided ? { undecided } : {}) };
      // Under a gate, its verdict word, tally and Wilson bound; the rule was said once, above.
      const words = s.gate || undecided ? probeFinding(found, s.gate) : `${rescued ? 'rescued' : 'lost'}: ${probeTally(found, ' passed')}`;
      log(`    ${rescued ? p.green(words) : decision === 'inconclusive' ? p.yellow(words) : p.red(words)}`);
      return found;
    };

    const searched = await searchBlame({ steps, probe, scan: s.scan });

    // The fork that rescued the run, and what the model answered there: an attempt that passed and
    // answered the blamed call otherwise than the recording, and that no stub carried past a write
    // that failed when the run was recorded, when one did. One that answered as the recording did is
    // no evidence against that answer: something after it made the difference.
    let result = searched;
    let contrast: BlameReport['contrast'] = null;
    let same: NonNullable<BlameReport['sameAnswer']> | null = null;
    let failedWrite: NonNullable<BlameReport['failedWrite']> | null = null;
    const warnings: string[] = [];
    const failed = failedWrites(parentCalls);
    if (searched.blamed) {
      const at = searched.blamed.callNo;
      const recorded = responseBlocks(store, parentCalls.find((c) => c.callNo === at));
      const passing = searched.blamed.attempts
        .filter((a) => a.passed)
        .map((a) => {
          const calls = store.getCalls(a.runId);
          return { runId: a.runId, answer: responseBlocks(store, calls.find((c) => c.callNo === at)), stubbed: stubbedPastFailure(calls, failed) };
        });
      const answered = passing.filter((x) => !sameAnswer(x.answer, recorded));
      const rescued = answered.find((x) => !x.stubbed.length) ?? answered[0];
      if (rescued) {
        contrast = { callNo: at, recorded, rescued: rescued.answer, rescuedRunId: rescued.runId };
        const w = rescued.stubbed[0];
        if (w) warnings.push(`${w.name} failed when the run was recorded (${w.message}), and the fork that rescued it had ${w.name} stubbed: a stub never fails, so the rescue may be the stub's, not the answer's`);
      } else if (passing[0] && searched.outcome === 'blamed') {
        const w = passing.flatMap((x) => x.stubbed)[0];
        const why = w
          ? `Every attempt that passed at #${at} answered it as the recording did. They passed because ${w.name} was stubbed after the fork, and the recording failed on ${w.name}'s error: ${w.message}.`
          : `Every attempt that passed at #${at} answered it as the recording did, so what made them pass came after that answer: a read that ran live, or a write that was stubbed.`;
        same = { callNo: at, runId: passing[0].runId, why };
        result = { ...searched, outcome: 'unrescuable', blamed: null, lost: null };
      }
    } else if (searched.outcome === 'unrescuable' && failed.size) {
      // No probe rescued the run: when every attempt from the first model call made a write that
      // failed when the run was recorded, the same call again, and met its error, that is likely why.
      const first = searched.probes[0];
      const met = first?.attempts.map((a) => metFailedWrite(store.getCalls(a.runId), first.callNo, failed));
      const name = met?.[0]?.name;
      if (first && name && met.every((m) => m?.name === name)) failedWrite = { name, message: failed.get(name)!, callNo: first.callNo };
    }

    const report: BlameReport = {
      ...result,
      runId: parent.runId,
      steps: steps.length,
      attemptsPerProbe: limit,
      needed: s.gate ? attemptsToPass(s.gate) : s.needed,
      gate: s.gate,
      rescue: { fields: s.fields },
      oracle,
      recordedFailures: baseline.failures,
      contrast,
      sameAnswer: same,
      failedWrite,
      attempts: runner.attempts,
      spent: runner.spent,
      upstreamRequests: runner.upstreamRequests,
      // Judge checks' calls, apart from the agent's.
      ...(runner.judgeRequests || runner.judgeSpent ? { judge: { spent: runner.judgeSpent, upstreamRequests: runner.judgeRequests } } : {}),
      unknownModels: [...runner.unknownModels],
      stopReason: result.outcome === 'stopped' ? runner.stopReason : null,
      warnings: [...runner.warnings, ...warnings],
    };
    store.updateRunMeta(parent.runId, {
      blame: {
        at: Date.now(),
        outcome: report.outcome,
        callNo: report.blamed?.callNo ?? null,
        confidence: report.confidence,
        rescuedRunId: contrast?.rescuedRunId ?? null,
        fields: s.fields,
        ...(s.scope ? { scope: s.scope } : {}),
        oracle,
        probes: report.probes.map((x) => ({ callNo: x.callNo, passes: x.passes, attempts: x.attempts.length, rescued: x.rescued })),
        spent: runner.spent,
      },
    });
    // Kept whole, with the fix it opens or joins: the blame on the run is only the latest one.
    // The command after `--`, when it replaced the recorded one, is part of blaming the run the same way again.
    const override = input.argv.length === parent.command.argv.length && input.argv.every((a, i) => a === parent.command.argv[i]) ? null : input.argv;
    const kept = recordBlameFix(store, { runId: parent.runId, report, settings: { ...s, argv: override }, recording: { checks: baseline.checks, failures: baseline.failures }, command: input.command });
    return { ...report, fix: kept ? { fixId: kept.fix.fixId, title: kept.fix.title, status: kept.fix.status, opened: kept.created, blameId: kept.blame.blameId } : null };
  } catch (err) {
    // What its judges cost is said even when blame stops short of a report.
    if (err instanceof BlameError && (runner.judgeRequests || runner.judgeSpent)) err.judge = { spent: runner.judgeSpent, upstreamRequests: runner.judgeRequests };
    throw err;
  } finally {
    await runner.close();
  }
}

/** What a cost check says when a model it counts has no price (checks.ts). */
const NO_PRICE = /^no price for (.+?); add it under "prices"/;

/**
 * The models with no price, when they are the only reason an attempt failed: every failure is a
 * cost check that could not be judged for want of a price. Null when anything else failed too.
 */
export function unpricedOnly(a: { checks: readonly StoredCheck[]; failures: readonly string[] }): string[] | null {
  const failed = a.checks.filter((c) => !c.ok);
  if (!failed.length || failed.length !== a.failures.length) return null;
  const models = failed.map((c) => NO_PRICE.exec(c.detail ?? '')?.[1]);
  if (!models.every((m): m is string => !!m)) return null;
  return [...new Set(models.flatMap((m) => m.split(', ')))];
}

/** The checks of an attempt that could not be decided (inconclusive): no attempt like it can pass while they stay so. */
export function inconclusiveChecks(a: { checks: readonly StoredCheck[] }): StoredCheck[] {
  return a.checks.filter((c) => checkStatus(c) === 'inconclusive');
}

/** One attempt in a line: its verdict (one only an undecided check held back is inconclusive, never failed), what ran live, what it cost, how long it took and its run. */
export function describeAttempt(a: Pick<Attempt, 'passed' | 'verdict' | 'failures' | 'summary' | 'ms' | 'run'>): string {
  const cost = a.summary.cost.spent ? ` · ≈${formatUsd(a.summary.cost.spent)}` : '';
  const mark = a.verdict === 'inconclusive' ? p.yellow('?') : p.red('✗');
  const verdict = a.passed ? p.green('✓ passed') : `${mark} ${a.failures[0] ?? a.verdict}${a.failures.length > 1 ? p.dim(` (+${a.failures.length - 1} more)`) : ''}`;
  return `${verdict}${p.dim(` · ${a.summary.byOrigin.live} live${cost} · ${formatDuration(a.ms)} · ${shortId(a.run.runId)}`)}`;
}

/**
 * Whether two model answers say and do the same: the same text and the same tool calls with the same
 * arguments, in order. Reasoning and tool call ids are left out: they differ between samples of one
 * answer.
 */
export function sameAnswer(a: readonly Block[], b: readonly Block[]): boolean {
  const said = (blocks: readonly Block[]) => blocks.flatMap((x) => (x.type === 'text' ? (x.text.trim() ? [`text ${x.text.trim()}`] : []) : x.type === 'tool_call' ? [`tool ${x.name} ${canonicalize(x.input ?? null)}`] : []));
  const [x, y] = [said(a), said(b)];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The write tools whose call failed when the run was recorded, each with its first failure's message. */
export function failedWrites(calls: readonly CallRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of calls) {
    if (c.kind !== 'tool' || c.effect !== 'write' || c.end?.outcome !== 'error' || out.has(c.name)) continue;
    const error = c.end.meta.error as { name?: unknown; message?: unknown } | undefined;
    out.set(c.name, typeof error?.message === 'string' && error.message ? error.message : 'an error');
  }
  return out;
}

/**
 * The writes an attempt got past only by a stub: calls to a tool whose recorded call failed, stubbed
 * here. A stub never fails, so whether the write would have failed again is not known.
 */
export function stubbedPastFailure(calls: readonly CallRecord[], failed: ReadonlyMap<string, string>): Array<{ name: string; message: string }> {
  return calls.filter((c) => c.kind === 'tool' && c.origin === 'stubbed' && failed.has(c.name)).map((c) => ({ name: c.name, message: failed.get(c.name)! }));
}

/**
 * The first write after the fork at `forkedAt` that was answered from the recording with the error
 * it got then: the same call the recording failed on, made again.
 */
export function metFailedWrite(calls: readonly CallRecord[], forkedAt: number, failed: ReadonlyMap<string, string>): { name: string } | null {
  const c = calls.find((x) => x.callNo > forkedAt && x.kind === 'tool' && x.effect === 'write' && x.origin === 'replayed' && x.end?.outcome === 'error' && failed.has(x.name));
  return c ? { name: c.name } : null;
}

/** A model call's response as blocks (text, tool calls, reasoning), whatever the provider. */
export function responseBlocks(store: Store, call: CallRecord | undefined): Block[] {
  const end = call?.end;
  if (!end?.responseRef) return [];
  try {
    const provider = end.meta.provider ?? call!.meta.provider;
    return normalizeResponse(store.getBlob(end.responseRef), end.meta.headers?.['content-type'], end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined).blocks;
  } catch {
    return [];
  }
}
