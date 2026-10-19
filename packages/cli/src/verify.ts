import { attemptsToPass, decideVerify, footprintOf, gateResult, gateVerdict, outcomeOf, runVerdict, type SprtGate, type VerifiedRun, type VerifyReport, type VerifyRole } from '@shadowlap/engine';
import { type Interventions } from '@shadowlap/sidecar';
import { AttemptRunner, type AttemptSettings, type AttemptTarget } from './attempts.js';
import { describeAttempt } from './blame.js';
import { codeVersion } from './config.js';
import { type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';

/**
 * `shadowlap verify`: the gate a change passes before it ships. `decideVerify` in @shadowlap/engine says
 * what it accepts. Every run is replayed under the code as it is now, so a change is tested as it will
 * ship: a changed prompt forks at the first model call and runs live, and a harness fix that changes
 * no request replays in full, for free.
 */

export interface VerifySettings extends AttemptSettings {
  /** A fixed count: attempts per run, and how many must pass. Used when `gate` is null. */
  attempts: number;
  needed: number;
  /** The gate that decides each run after every attempt (stats.ts); null for the fixed count. */
  gate: SprtGate | null;
  /** Runs verified at once; a run's own attempts go one after another. */
  concurrency: number;
  /** Request fields the change sets from each run's first model call (`--model`, `--set`). */
  fields: Record<string, unknown>;
  /** Start nothing new once any run has failed. */
  failFast: boolean;
}

export interface VerifyInput {
  opts: GlobalOpts;
  runs: Array<AttemptTarget & { role: VerifyRole }>;
  settings: VerifySettings;
  log: (line: string) => void;
}

const ROLE: Record<VerifyRole, string> = { target: 'target', holdout: 'held-out', good: 'good' };

export async function runVerify(input: VerifyInput): Promise<VerifyReport> {
  const { settings: s, log } = input;
  const runner = await AttemptRunner.start(input.opts, s);
  const { store } = runner;
  try {
    const group = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const results: VerifiedRun[] = new Array(input.runs.length);
    let failed = false;

    const verifyOne = async (i: number): Promise<void> => {
      const { role, ...target } = input.runs[i]!;
      const { parent } = target;
      const parentCalls = store.getCalls(parent.runId);
      const recorded = { ...runner.judgeRecorded(parent, parentCalls), footprint: footprintOf(parentCalls, runner.costOf) };
      const firstModelCall = parentCalls.find((c) => c.kind === 'api')?.callNo;
      const interventions: Interventions | undefined = Object.keys(s.fields).length && firstModelCall !== undefined ? { set: { fromCall: firstModelCall, fields: s.fields } } : undefined;
      const result: VerifiedRun = { runId: parent.runId, role, attempts: [], passes: 0, deterministic: false, verdict: 'open', recorded };
      results[i] = result;
      const label = `${ROLE[role].padEnd(8)}  ${shortId(parent.runId)}`;
      // A gate decides after each attempt, up to its max; a fixed count runs until it is settled.
      const limit = s.gate ? s.gate.max : s.attempts;
      while (result.verdict === 'open' && result.decision !== 'inconclusive' && result.attempts.length < limit && !(s.failFast && failed) && runner.canStart()) {
        const marks = { repeat: { group: `${group}-${parent.runId}`, attempt: result.attempts.length + 1, of: limit }, verify: { role, passed: false } };
        const a = await runner.attempt(target, { ...(interventions ? { interventions } : {}), meta: marks });
        // Stopped by Ctrl-C part way: what it did is no evidence either way.
        if (runner.interrupted) break;
        const n = result.attempts.length + 1;
        // Clean means every call came from the recording, not that none reached Shadowlap.
        if (n === 1) result.deterministic = !a.summary.divergence && !a.bypassed;
        if (a.passed) result.passes++;
        result.attempts.push({
          runId: a.run.runId,
          passed: a.passed,
          exitCode: a.code,
          failures: a.failures,
          forkedAt: a.summary.divergence?.callNo ?? null,
          spent: a.summary.cost.spent,
          upstreamRequests: a.summary.upstreamRequests,
          footprint: footprintOf(a.calls, runner.costOf),
        });
        store.updateRunMeta(a.run.runId, { verify: { role, passed: a.passed }, ...(a.checks.length ? { checks: a.checks } : {}) });
        if (s.gate) Object.assign(result, gateVerdict(result.passes, n, s.gate, result.deterministic));
        else result.verdict = runVerdict(result.passes, n, s.attempts, s.needed, result.deterministic);
        log(`  ${label}  ${p.dim(`attempt ${n}`)}  ${describeAttempt(a)}${result.deterministic ? p.dim(' · clean replay, so it settles the run') : ''}`);
      }
      // What the gate made of the attempts: the rate's interval and the risk it decided at.
      if (s.gate && result.attempts.length) result.gate = gateResult(s.gate, result.attempts.map((x) => x.passed), { clean: result.deterministic, decision: result.decision ?? 'continue' });
      if (result.verdict === 'fail') failed = true;
      const o = outcomeOf(result);
      const said = result.gate && !result.deterministic && result.decision !== 'continue' ? p.dim(` · ${result.gate.sentence}`) : '';
      log(`  ${label}  ${!result.attempts.length ? p.yellow('not started') : o === 'fixed' || o === 'kept' ? p.green(o) : o === 'unsettled' || o === 'inconclusive' ? p.yellow(o) : p.red(o)}${said}`);
    };

    let next = 0;
    const worker = async () => {
      while (next < input.runs.length) await verifyOne(next++);
    };
    await Promise.all(Array.from({ length: Math.min(s.concurrency, input.runs.length) }, worker));

    // A run that never started (interrupted, out of budget, --fail-fast) is still in the report, unsettled.
    const runs = results;
    const stopReason = s.failFast && failed && !runner.stopReason ? 'a run failed (--fail-fast)' : runner.stopReason;
    return {
      ...decideVerify(runs, stopReason),
      runs,
      attemptsPerRun: s.gate ? s.gate.max : s.attempts,
      needed: s.gate ? attemptsToPass(s.gate) : s.needed,
      gate: s.gate,
      oracle: runner.oracle(),
      fields: s.fields,
      codeVersion: codeVersion(process.cwd()),
      attempts: runner.attempts,
      spent: runner.spent,
      upstreamRequests: runner.upstreamRequests,
      unknownModels: [...runner.unknownModels],
      stopReason,
      replayWarnings: [...runner.warnings],
    };
  } finally {
    await runner.close();
  }
}
