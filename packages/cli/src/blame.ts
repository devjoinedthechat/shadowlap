import { addPair, agentCallsOf, attemptsToPass, BLAME_DEFAULTS, canonicalize, checkStatus, decideCountUnavailable, decideUnavailable, endedEarlyCount, formatDivergence, formatDuration, formatUsd, gateResult, maxProbes, NO_PAIRS, normalizeResponse, pinRisk, pinRule, pinWords, probeFinding, probeGate, probeRisk, probeTally, searchBlame, unsettledFirst, decidePin, type BlameAttempt, type BlameProbe, type BlameReport, type PinCheck, type Block, type CallRecord, type FixStatus, type GateDecision, type RunRecord, type SprtGate, type Store, type StoredCheck } from '@shadowlap/engine';
import { type Interventions } from '@shadowlap/sidecar';
import { AttemptRunner, BYPASSED, type Attempt, type AttemptSettings } from './attempts.js';
import { recordBlameFix } from './fixes.js';
import { type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';
import { unrecordedNote } from './attempt-unrecorded.js';

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
 * starts no attempt after it (probeAttempts). An attempt that could not be judged (null) decides the
 * probe inconclusive when its turn comes, on the attempts before it: no attempt after it would say
 * more. One the provider cut short after the model answered (`cut`) is counted, against either
 * verdict, `settle` told how many of the attempts it reads were.
 */
export class ProbeTally {
  private readonly outcomes: Array<boolean | null | 'cut' | undefined> = [];
  private seen = 0;
  private passes = 0;
  private cut = 0;
  /** The first answer other than continue, and after how many attempts (by the order they started); null until then. */
  decided: { decision: GateDecision; at: number } | null = null;

  constructor(private readonly settle: (passes: number, attempts: number, cut: number) => GateDecision) {}

  /** How many attempts it has read: the first to start, each read once every one before it had ended. */
  get read(): number {
    return this.seen;
  }

  /** Attempt `n` (the nth to start, from 1) ended, and passed or not, or (null) could not be judged, or (`cut`) the provider cut it short after the model answered. */
  add(n: number, passed: boolean | null | 'cut'): void {
    this.outcomes[n - 1] = passed;
    while (!this.decided && this.seen < this.outcomes.length && this.outcomes[this.seen] !== undefined) {
      const x = this.outcomes[this.seen];
      if (x === null) {
        this.decided = { decision: 'inconclusive', at: this.seen };
        break;
      }
      if (x === 'cut') this.cut++;
      else if (x) this.passes++;
      this.seen++;
      const d = this.settle(this.passes, this.seen, this.cut);
      if (d !== 'continue') this.decided = { decision: d, at: this.seen };
    }
  }

  /** The attempts the decision rests on, in the order they started: one the provider cut short as a failure (`cutAt` says which). */
  decidedOn(): boolean[] {
    return this.decided ? this.outcomes.slice(0, this.decided.at).map((x) => x === true) : [];
  }

  /** Which of the attempts the decision rests on the provider cut short, by their place among them. */
  cutAt(): number[] {
    return this.decided ? this.outcomes.slice(0, this.decided.at).flatMap((x, i) => (x === 'cut' ? [i] : [])) : [];
  }
}

/**
 * Runs a probe's attempts, numbered from 1 in the order they start, up to `concurrency` at once and
 * `limit` in all, while `more()` lets another start. The tally reads them in that order, so attempt
 * n starts only while fewer than `concurrency` attempts have started that it has not read: once that
 * many have, the next waits for the earliest of them to end rather than start another fork it can't
 * read yet, each live and paid for, so at most `concurrency - 1` start after the one that decides. A
 * worker that waits is woken whenever an attempt ends, whatever ended it (the tally read more,
 * Ctrl-C, a prefix that broke, the budget spent), and it waits only while an attempt it waits for is
 * still running, so none waits forever.
 */
export async function probeAttempts(o: { concurrency: number; limit: number; tally: Pick<ProbeTally, 'read'>; more: () => boolean; attempt: (n: number) => Promise<void> }): Promise<void> {
  let started = 0;
  // An attempt that threw ends the probe: nothing more starts, and the error is the probe's.
  let threw = false;
  const waiting: Array<() => void> = [];
  const wake = () => {
    for (const w of waiting.splice(0)) w();
  };
  const open = () => !threw && started < o.limit && o.more();
  const worker = async () => {
    for (;;) {
      while (open() && started - o.tally.read >= o.concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
      if (!open()) return;
      const n = ++started;
      try {
        await o.attempt(n);
      } catch (err) {
        threw = true;
        throw err;
      } finally {
        wake();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, o.limit) }, worker));
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

    // A probe is decided after each attempt: by the gate, rescued at `good` and lost at `bad`, or by the
    // fixed count. The gate's risk is the whole search's, spent across the most probes it makes: each
    // probe's gate runs at its share, so every claim of every probe holds together but for that risk.
    const budget = maxProbes(steps.length, s.scan);
    const each: SprtGate | null = s.gate ? probeGate(s.gate, budget) : null;
    const limit = each ? each.max : s.attempts;
    // A gate counts an attempt the provider cut short after the model answered against either verdict; a fixed count runs it again.
    const settle = (passes: number, done: number, cut: number): GateDecision => (each ? decideUnavailable(passes, done, cut, each) : decideCountUnavailable(passes, done, cut, s.attempts, s.needed));
    // The most a probe's claim can be wrong, exactly, at the gate's two rates (the blame gate's for a count).
    const risk = probeRisk(each ? { gate: each } : { attempts: s.attempts, needed: s.needed });
    // Every attempt must fork exactly at the model call it re-asks. One that forked elsewhere ran a
    // prefix the recording doesn't hold, and its outcome says nothing about that call.
    const forkProblem = (a: Attempt, callNo: number): string | null => {
      const d = a.summary.divergence;
      if (d && d.type === 'forced' && d.callNo === callNo && d.kind === 'api') return null;
      return d?.type === 'ended_early'
        ? `An attempt at model call #${callNo} never reached it: the agent stopped first, after ${endedEarlyCount(d)}. The calls before #${callNo} don't replay the same way twice, so no probe can be trusted. Make replays clean first: shadowlap calibrate ${shortId(parent.runId)}`
        : d
          ? `An attempt at model call #${callNo} forked at call ${d.callNo} instead:\n\n${formatDivergence(d)}\n\nThe calls before #${callNo} don't replay the same way twice, so no probe can be trusted. Make replays clean first: shadowlap calibrate ${shortId(parent.runId)}`
          : `An attempt at model call #${callNo} never reached it: the agent took another path through calls the recording holds. Make replays clean first: shadowlap calibrate ${shortId(parent.runId)}`;
    };
    const probe = async (callNo: number, step: number): Promise<BlameProbe | null> => {
      if (!runner.canStart()) return null;
      log(`  ${p.bold(`model call #${callNo}`)} ${p.dim(`(${step} of ${steps.length})`)}`);
      const done: Array<BlameAttempt | undefined> = [];
      const tally = new ProbeTally(settle);
      let prefixBroken: string | null = null;
      // Attempts the provider was unavailable for: retried by the runner, never counted. Once it stays
      // unavailable attempt after attempt the runner stops, and the probe decides nothing.
      let unavailable = 0;
      // Attempts the provider cut short after the model answered: counted by the gate, against either verdict.
      let cutShort = 0;
      let providerDown = false;
      const interventions: Interventions | undefined = Object.keys(s.fields).length ? { set: { fromCall: callNo, fields: s.fields } } : undefined;
      await probeAttempts({
        concurrency: s.concurrency,
        // A gate's max counts the attempts the provider didn't cut short (decideUnavailable): the tally
        // decides it at max of those, and up to twice it may start in all.
        limit: each ? 2 * limit : limit,
        tally,
        more: () => !prefixBroken && !tally.decided && runner.canStart(),
        attempt: async (n) => {
          const marks = { repeat: { group: `${group}-${callNo}`, attempt: n, of: limit }, probe: { of: parent.runId, callNo, passed: false } };
          const a = await runner.attempt(target, { divergeAt: callNo, recordedWrites: true, ...(interventions ? { interventions } : {}), meta: marks }, true, { late: 'count' });
          // Stopped by Ctrl-C part way: what it did is no evidence either way.
          if (runner.interrupted) return;
          prefixBroken ??= forkProblem(a, callNo);
          unavailable += (a.unavailableBefore ?? 0) + (a.unavailable && !a.cutShort ? 1 : 0);
          store.updateRunMeta(a.run.runId, { probe: { ...marks.probe, passed: a.passed, verdict: a.unavailable ? 'unavailable' : a.verdict }, ...(a.checks.length ? { checks: a.checks } : {}) });
          // The provider was unavailable for it and the attempts before it in a row: it says nothing
          // about the answer re-asked, and nothing after it is asked (the runner's stopReason says why).
          if (a.unavailable && !a.cutShort) {
            providerDown = true;
            log(`    ${p.dim(`attempt ${n}`)}  ${describeAttempt(a)}`);
            return;
          }
          if (a.cutShort) cutShort++;
          done[n - 1] = { runId: a.run.runId, passed: a.passed, verdict: a.verdict, ...(a.cutShort ? { cutShort: true as const } : {}), exitCode: a.code, failures: a.failures, spent: a.summary.cost.spent, upstreamRequests: a.summary.upstreamRequests, unrecordedTools: a.unrecorded };
          const late = tally.decided !== null;
          // An attempt that all it fell short on is a check that could not be decided says nothing of the
          // answer re-asked; one the provider cut short is counted, against either verdict.
          tally.add(n, a.cutShort ? 'cut' : a.verdict === 'inconclusive' ? null : a.passed);
          log(`    ${p.dim(`attempt ${n}`)}  ${describeAttempt(a)}${late ? p.dim(' · ended after the probe decided') : ''}`);
        },
      });
      if (prefixBroken) throw new BlameError(prefixBroken, 'prefix');
      const attempts = done.filter((a): a is BlameAttempt => a !== undefined);
      // Interrupted, out of budget, or the provider unavailable with the verdict still open: this probe
      // proves nothing, and the search stops, saying why. A provider that never answered is no reason
      // to call the run rescued, lost or unrescuable.
      const decided = tally.decided;
      if (!decided || providerDown) {
        if (providerDown) log(`    ${p.yellow(`stopped · the provider was unavailable for ${unavailable} attempt${unavailable === 1 ? '' : 's'}, none counted`)}`);
        return null;
      }
      const decision = decided.decision;
      const passes = attempts.filter((a) => a.passed).length;
      const rescued = decision === 'pass';
      // An attempt that could not be judged stopped the probe, inconclusive, whatever decides it: with
      // why. One that ended after a gate or a count had decided it is only a late attempt.
      const stopper = attempts.find((a) => a.verdict === 'inconclusive' && !a.cutShort);
      const undecided = decision === 'inconclusive' ? (stopper?.failures[0] ?? null) : null;
      // The gate's result rests on the attempts it decided on: the first to start, up to the one that settled it.
      const apart = unavailable ? { unavailable } : {};
      const cutAt = tally.cutAt();
      const found: BlameProbe = { callNo, step, attempts, passes, rescued, ...(each ? { decision, gate: gateResult(each, tally.decidedOn(), { decision: undecided ? 'continue' : decision, ...apart, ...(cutAt.length ? { unavailableAt: cutAt } : {}) }) } : undecided ? { decision } : {}), ...(undecided ? { undecided } : {}), risk, ...apart, ...(cutShort ? { cutShort } : {}) };
      // Under a gate, its verdict word, tally and bound; the rule was said once, above.
      const words = each || undecided ? probeFinding(found, each) : `${rescued ? 'rescued' : 'lost'}: ${probeTally(found, ' passed')}`;
      log(`    ${rescued ? p.green(words) : decision === 'inconclusive' ? p.yellow(words) : p.red(words)}`);
      return found;
    };

    // The check of a pinned call (PinCheck in the engine): fresh pairs, an attempt at the call and one
    // at the next in each, the two at once when --concurrency allows, decided after each pair. It
    // stops the search as a probe does: Ctrl-C, the budget, a provider that stays unavailable. An
    // attempt the provider cut short after the model answered is counted against either verdict.
    const rule = pinRule(each, budget);
    const pin = async (at: BlameProbe, next: BlameProbe): Promise<PinCheck | null> => {
      log(`  ${p.bold(`check of #${at.callNo}`)} ${p.dim(`(fresh pairs at #${at.callNo} and #${next.callNo}: does rescue drop at #${at.callNo}, or fall gradually?)`)}`);
      const pairs: PinCheck['pairs'] = [];
      // Two tallies of the same pairs: a cut-short attempt counted against gradual (kept), then against pinned (broken).
      let kept = NO_PAIRS;
      let broken = NO_PAIRS;
      let cutShort = 0;
      const one = async (callNo: number, n: number): Promise<BlameAttempt | null> => {
        const marks = { repeat: { group: `${group}-check-${at.callNo}-${callNo}`, attempt: n, of: rule.max }, probe: { of: parent.runId, callNo, passed: false, check: true as const } };
        const interventions: Interventions | undefined = Object.keys(s.fields).length ? { set: { fromCall: callNo, fields: s.fields } } : undefined;
        const a = await runner.attempt(target, { divergeAt: callNo, recordedWrites: true, ...(interventions ? { interventions } : {}), meta: marks }, true, { late: 'count' });
        if (runner.interrupted) return null;
        const broke = forkProblem(a, callNo);
        if (broke) throw new BlameError(broke, 'prefix');
        store.updateRunMeta(a.run.runId, { probe: { ...marks.probe, passed: a.passed, verdict: a.unavailable && !a.cutShort ? 'unavailable' : a.verdict }, ...(a.checks.length ? { checks: a.checks } : {}) });
        log(`    ${p.dim(`pair ${n}, #${callNo}`)}  ${describeAttempt(a)}`);
        // The provider stayed unavailable attempt after attempt: the runner stopped, and so does the check.
        if (a.unavailable && !a.cutShort) return null;
        return { runId: a.run.runId, passed: a.passed, verdict: a.verdict, ...(a.cutShort ? { cutShort: true as const } : {}), exitCode: a.code, failures: a.failures, spent: a.summary.cost.spent, upstreamRequests: a.summary.upstreamRequests };
      };
      const done = (verdict: PinCheck['verdict'], undecided?: string): PinCheck => {
        const check: PinCheck = {
          callNo: at.callNo,
          next: next.callNo,
          verdict,
          dropped: pairs.filter((x) => x.at.passed && !x.next.passed).length,
          rose: pairs.filter((x) => !x.at.passed && x.next.passed).length,
          same: pairs.filter((x) => x.at.passed === x.next.passed).length,
          passes: pairs.filter((x) => x.at.passed).length,
          nextPasses: pairs.filter((x) => x.next.passed).length,
          pairs,
          rule,
          risk: pinRisk(rule, verdict),
          ...(undecided ? { undecided } : {}),
          ...(cutShort ? { cutShort } : {}),
        };
        const words = pinWords(check);
        log(`    ${verdict === 'pinned' ? p.green(words) : p.yellow(words)}`);
        return check;
      };
      for (let n = 1; n <= rule.max; n++) {
        if (!runner.canStart()) return null;
        const [x, y] = s.concurrency >= 2 ? await Promise.all([one(at.callNo, n), one(next.callNo, n)]) : [await one(at.callNo, n), await one(next.callNo, n)];
        if (!x || !y) return null;
        pairs.push({ at: x, next: y });
        // An attempt that all it fell short on is a check that could not be decided says nothing of either call.
        const unjudged = [x, y].find((z) => z.verdict === 'inconclusive' && !z.cutShort);
        if (unjudged) return done('inconclusive', unjudged.failures[0] ?? 'a check could not be decided');
        cutShort += (x.cutShort ? 1 : 0) + (y.cutShort ? 1 : 0);
        // The next call's attempt is the change's, the pinned call's the baseline's (decidePin).
        kept = addPair(kept, y.cutShort ? false : y.passed, x.cutShort ? true : x.passed);
        broken = addPair(broken, y.cutShort ? true : y.passed, x.cutShort ? false : x.passed);
        const d = decidePin(kept, broken, rule);
        if (d !== 'continue') return done(d);
      }
      return done('inconclusive');
    };

    const searched = await searchBlame({ steps, probe, pin, scan: s.scan, risk: s.gate?.risk ?? BLAME_DEFAULTS.risk });

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
        result = { ...searched, outcome: 'unrescuable', blamed: null, lost: null, range: null };
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
      needed: each ? attemptsToPass(each) : s.needed,
      gate: s.gate,
      probeBudget: s.gate ? budget : null,
      rescue: { fields: s.fields },
      oracle,
      recordedFailures: baseline.failures,
      contrast,
      sameAnswer: same,
      failedWrite,
      attempts: runner.attempts,
      ...(runner.unavailable ? { unavailable: runner.unavailable } : {}),
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
        // Placed on no call only because its first probe couldn't tell: what reads this record says so.
        ...(unsettledFirst(report) ? { unsettled: true } : {}),
        callNo: report.blamed?.callNo ?? null,
        confidence: report.confidence,
        range: report.range ?? null,
        errorBound: report.errorBound ?? null,
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
export function describeAttempt(a: Pick<Attempt, 'passed' | 'verdict' | 'failures' | 'summary' | 'ms' | 'run'> & Partial<Pick<Attempt, 'unrecorded'>>): string {
  const cost = a.summary.cost.spent ? ` · ≈${formatUsd(a.summary.cost.spent)}` : '';
  const mark = a.verdict === 'inconclusive' ? p.yellow('?') : p.red('✗');
  const verdict = a.passed ? p.green('✓ passed') : `${mark} ${a.failures[0] ?? a.verdict}${a.failures.length > 1 ? p.dim(` (+${a.failures.length - 1} more)`) : ''}`;
  // A write the attempt's model called that nothing recorded ran for real, whatever the writes Shadowlap fences do.
  return `${verdict}${p.dim(` · ${a.summary.byOrigin.live} live${cost} · ${formatDuration(a.ms)} · ${shortId(a.run.runId)}`)}${unrecordedNote(a.unrecorded)}`;
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
