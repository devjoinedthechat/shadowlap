import { formatDivergence, formatDuration, formatUsd, normalizeResponse, probeVerdict, searchBlame, type BlameAttempt, type BlameProbe, type BlameReport, type Block, type CallRecord, type FixStatus, type RunRecord, type Store } from '@shadowlap/engine';
import { type Interventions } from '@shadowlap/sidecar';
import { AttemptRunner, BYPASSED, type Attempt, type AttemptSettings } from './attempts.js';
import { recordBlameFix } from './fixes.js';
import { type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';

/**
 * `shadowlap blame`: runs the probes the engine's search asks for (`searchBlame` in @shadowlap/engine
 * says what they mean). Each attempt replays the failed run up to the probed model call, forces that
 * call live, and runs the rest live with writes fenced; the oracle then judges what came out.
 */

export interface BlameSettings extends AttemptSettings {
  /** Attempts per probe, and how many must pass for the probe to rescue the run. */
  attempts: number;
  needed: number;
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
  constructor(
    message: string,
    readonly reason: 'no-model-calls' | 'diverged' | 'bypassed' | 'passes' | 'prefix' | 'interrupted',
  ) {
    super(message);
    this.name = 'BlameError';
  }
}

/** A blame's report, and the fix it opened or joined: null when the store refused to keep it. */
export interface BlameRun extends BlameReport {
  fix: { fixId: string; title: string; status: FixStatus; opened: boolean; blameId: string } | null;
}

export async function runBlame(input: BlameInput): Promise<BlameRun> {
  const { parent, settings: s, log } = input;
  const target = { parent, argv: input.argv, commandFromImport: input.commandFromImport };
  const runner = await AttemptRunner.start(input.opts, s);
  const { store } = runner;
  try {
    const parentCalls = store.getCalls(parent.runId);
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
    const baseline = await runner.attempt(target, {}, false);
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
    log(`  ${p.green('✓')} replays as recorded and fails: ${baseline.failures.join('; ')}`);

    const group = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const probe = async (callNo: number, step: number): Promise<BlameProbe | null> => {
      if (!runner.canStart()) return null;
      log(`  ${p.bold(`model call #${callNo}`)} ${p.dim(`(${step} of ${steps.length})`)}`);
      const attempts: BlameAttempt[] = [];
      let launched = 0;
      let passes = 0;
      let prefixBroken: string | null = null;
      const interventions: Interventions | undefined = Object.keys(s.fields).length ? { set: { fromCall: callNo, fields: s.fields } } : undefined;
      const worker = async () => {
        while (!prefixBroken && launched < s.attempts && probeVerdict(passes, attempts.length, s.attempts, s.needed) === 'open' && runner.canStart()) {
          const n = ++launched;
          const a = await runner.attempt(target, { divergeAt: callNo, ...(interventions ? { interventions } : {}) });
          // Stopped by Ctrl-C part way: what it did is no evidence either way.
          if (runner.interrupted) break;
          const d = a.summary.divergence;
          // Every attempt must fork exactly at the probed model call. One that forked elsewhere ran a
          // prefix the recording doesn't hold, and its outcome says nothing about call #callNo.
          if (!d || d.type !== 'forced' || d.callNo !== callNo || d.kind !== 'api') {
            prefixBroken = d
              ? `An attempt at model call #${callNo} forked at call ${d.callNo} instead:\n\n${formatDivergence(d)}\n\nThe calls before #${callNo} don't replay the same way twice, so no probe can be trusted. Make replays clean first: shadowlap calibrate ${shortId(parent.runId)}`
              : `An attempt at model call #${callNo} never reached it: the agent took another path through calls the recording holds. Make replays clean first: shadowlap calibrate ${shortId(parent.runId)}`;
          }
          store.updateRunMeta(a.run.runId, { repeat: { group: `${group}-${callNo}`, attempt: n, of: s.attempts }, probe: { of: parent.runId, callNo, passed: a.passed }, ...(a.checks.length ? { checks: a.checks } : {}) });
          if (a.passed) passes++;
          attempts.push({ runId: a.run.runId, passed: a.passed, exitCode: a.code, failures: a.failures, spent: a.summary.cost.spent, upstreamRequests: a.summary.upstreamRequests });
          log(`    ${p.dim(`attempt ${n}`)}  ${describeAttempt(a)}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(s.concurrency, s.attempts) }, worker));
      if (prefixBroken) throw new BlameError(prefixBroken, 'prefix');
      // Interrupted or out of budget with the verdict still open: this probe proves nothing.
      if (probeVerdict(passes, attempts.length, s.attempts, s.needed) === 'open') return null;
      const rescued = passes >= s.needed;
      log(`    ${rescued ? p.green(`rescued: ${passes} of ${attempts.length} passed`) : p.red(`lost: ${passes} of ${attempts.length} passed`)}`);
      return { callNo, step, attempts, passes, rescued };
    };

    const result = await searchBlame({ steps, probe, scan: s.scan });

    let contrast: BlameReport['contrast'] = null;
    if (result.blamed) {
      const at = result.blamed.callNo;
      const rescuedRun = result.blamed.attempts.find((a) => a.passed);
      if (rescuedRun) {
        const recorded = responseBlocks(store, parentCalls.find((c) => c.callNo === at));
        const rescued = responseBlocks(store, store.getCalls(rescuedRun.runId).find((c) => c.callNo === at));
        contrast = { callNo: at, recorded, rescued, rescuedRunId: rescuedRun.runId };
      }
    }

    const report: BlameReport = {
      ...result,
      runId: parent.runId,
      steps: steps.length,
      attemptsPerProbe: s.attempts,
      needed: s.needed,
      rescue: { fields: s.fields },
      oracle,
      recordedFailures: baseline.failures,
      contrast,
      attempts: runner.attempts,
      spent: runner.spent,
      upstreamRequests: runner.upstreamRequests,
      unknownModels: [...runner.unknownModels],
      stopReason: result.outcome === 'stopped' ? runner.stopReason : null,
      warnings: [...runner.warnings],
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
  } finally {
    await runner.close();
  }
}

/** One attempt in a line: its verdict, what ran live, what it cost, how long it took and its run. */
export function describeAttempt(a: Attempt): string {
  const cost = a.summary.cost.spent ? ` · ≈${formatUsd(a.summary.cost.spent)}` : '';
  const verdict = a.passed ? p.green('✓ passed') : `${p.red('✗')} ${a.failures[0] ?? 'failed'}${a.failures.length > 1 ? p.dim(` (+${a.failures.length - 1} more)`) : ''}`;
  return `${verdict}${p.dim(` · ${a.summary.byOrigin.live} live${cost} · ${formatDuration(a.ms)} · ${shortId(a.run.runId)}`)}`;
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
