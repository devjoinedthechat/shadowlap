import type { ChildProcess } from 'node:child_process';
import { checkStatus, estimateCost, formatDuration, formatUsd, type CallRecord, type ReadPolicy, type ReplayOptions, type RunMeta, type RunRecord, type RunStatus, type Store } from '@shadowlap/engine';
import { Sidecar, type Interventions } from '@shadowlap/sidecar';
import { stampAuthor } from './activity.js';
import { spawnAgent } from './agent-registry.js';
import { evaluateChecks, LABEL_INPUT, readsOutput, storedCheckInput, withoutOutput, type CheckResult, type EvaluateOptions, type TestSpec } from './checks.js';
import { killTree } from './kill-tree.js';
import { codeVersion, loadConfig, upstreamOverrides, type ShadowlapConfig } from './config.js';
import { agentEnv, recordsInput, type GuardMode } from './run-agent.js';
import { openStore, telemetry, usageOf, type GlobalOpts } from './shared.js';
import { pushIfQueued, teamEnv } from './team.js';
import { palette as p } from './ui.js';

/**
 * Replays of recorded runs under one sidecar, each judged by an oracle: the probes of `shadowlap blame`
 * and the attempts of `shadowlap verify`. Every attempt is a replay run in the store; after its fork the
 * rest runs live with writes fenced, and the oracle (the agent exits 0, plus the checks of `--expect`)
 * decides whether it passed. The runner keeps the tally a report owes its reader: attempts, upstream
 * requests, what they cost, and models with no price.
 */

export const EXIT_LABEL = 'the agent exits 0';

/** A budget as the round number someone chose (`$0.50`), not a measurement with sub-cent digits. */
export const formatBudget = (usd: number): string => (usd < 0.01 ? formatUsd(usd) : `$${usd.toFixed(2)}`);

export interface AttemptSettings {
  /** What write tools do after the fork. Never `allow`: nothing here may act on the world. */
  writes: 'block' | 'stub';
  reads: ReadPolicy;
  /** Tools whose first call runs live instead of from the recording: a fixed tool keeps its call key, so it must be forced. */
  liveTools: string[];
  /** Checks a passing run must meet, besides exiting 0. */
  spec: TestSpec | null;
  /** The `--expect` those checks came from, as given: what Fixes groups failures by and shows in commands. */
  expect?: unknown;
  /** Start no attempt once this many USD are spent. */
  budget: number | null;
  /** Stop an attempt after this long, and count it as a failure. */
  timeoutMs: number | null;
  guard: GuardMode;
  /** Upstreams that replace the environment's for some providers, such as a model under test's (tasks score). */
  upstreams?: Record<string, string>;
}

/** A recorded run to replay, and the command that replays it. */
export interface AttemptTarget {
  parent: RunRecord;
  argv: string[];
  /** The command came from an imported pack; recorded on the replay so later replays ask again. */
  commandFromImport: boolean;
}

export interface Attempt {
  run: RunRecord;
  code: number;
  summary: ReturnType<Sidecar['endRun']>['summary'];
  calls: CallRecord[];
  checks: CheckResult[];
  /** Why it failed the oracle: a non-zero exit, a timeout, failed checks. Empty when it passed. */
  failures: string[];
  passed: boolean;
  /**
   * The recording has model calls and the replay made none through Shadowlap: the agent reached its
   * model some other way, such as a local server Shadowlap was not told about. What it did is
   * unrecorded, so it is no evidence, and it must never pass for a clean replay.
   */
  bypassed: boolean;
  ms: number;
}

/** Why a replay that made no calls through Shadowlap is no evidence, and what usually causes it. */
export const BYPASSED =
  'the replay made no calls through Shadowlap, so the agent reached its model some other way: point its client at Shadowlap in this environment (a local model server needs SHADOWLAP_UPSTREAM_OPENAI or the like, as when it was recorded)';

/**
 * Each attempt's agent gets a process group of its own where there are groups, as `test`'s replays
 * do: stopping it (at the time limit, on Ctrl-C) stops what it started too (`npm start` runs node,
 * `sh -c` its command), and whatever it leaves running in the group goes once it exits. It no
 * longer hears the terminal's Ctrl-C itself, so the signal is passed on. Windows has no groups: there
 * the agent's whole process tree is ended while it runs (killTree).
 */
const GROUP = process.platform !== 'win32';

export class AttemptRunner {
  /** Attempts run and tallied, and what they sent upstream and cost. */
  attempts = 0;
  spent = 0;
  upstreamRequests = 0;
  readonly unknownModels = new Set<string>();
  /** What the replays warned about, once each: a tool that changed since its recording, a connection that bypassed Shadowlap. */
  readonly warnings = new Set<string>();
  /** Ctrl-C: an attempt it cut short is no evidence either way. */
  interrupted = false;
  /** Why no more attempts may start, once one of them can't. */
  stopReason: string | null = null;

  private readonly running = new Set<ChildProcess>();
  private readonly onSignal = (sig: NodeJS.Signals) => {
    // A second signal doesn't wait for the agents to wind down, and nor does the first for long: an
    // agent that ignores it is killed before whoever sent it (a dashboard stopping its job, 5 s
    // later) kills this process, which would leave the agent's group running with nobody to end it.
    const now = this.interrupted ? 'SIGKILL' : sig;
    if (!this.interrupted) {
      const agents = [...this.running];
      // Only those still running: one that has exited took its group with it (attempt), and its id may be another's by now.
      setTimeout(() => agents.filter((child) => this.running.has(child)).forEach((child) => killTree(child, 'SIGKILL', { group: GROUP })), 3_000).unref();
    }
    this.interrupted = true;
    this.stopReason = 'interrupted';
    for (const child of this.running) killTree(child, now, { group: GROUP });
  };

  private constructor(
    readonly store: Store,
    private readonly sidecar: Sidecar,
    readonly config: ShadowlapConfig,
    private readonly settings: AttemptSettings,
    private readonly upstreams: Record<string, string>,
  ) {
    process.on('SIGINT', this.onSignal);
    process.on('SIGTERM', this.onSignal);
  }

  static async start(opts: GlobalOpts, settings: AttemptSettings): Promise<AttemptRunner> {
    const store = openStore(opts);
    const config = loadConfig(process.cwd());
    const upstreams = { ...upstreamOverrides(process.env), ...settings.upstreams };
    try {
      const sidecar = await Sidecar.start({
        store,
        normalizers: config.normalize,
        upstreams,
        ...(config.prices ? { prices: config.prices } : {}),
        ...(config.clock ? { clock: config.clock } : {}),
        ...(config.http ? { http: config.http } : {}),
        ...(opts.verbose ? { log: (line: string) => void process.stderr.write(p.dim(`[shadowlap] ${line}\n`)) } : {}),
      });
      const runner = new AttemptRunner(store, sidecar, config, settings, upstreams);
      runner.db = opts.db;
      return runner;
    } catch (err) {
      store.close();
      throw err;
    }
  }

  /** A model call's estimated cost under the configured prices, or null without one. */
  costOf = (c: CallRecord): number | null => estimateCost(c.end?.meta.model ?? c.meta.model, c.end?.meta.usage, this.config.prices);

  /** Whether another attempt may start: nothing interrupted, and budget left. Says why not in `stopReason`. */
  canStart(): boolean {
    if (this.stopReason) return false;
    const { budget } = this.settings;
    if (budget !== null && this.spent >= budget) {
      this.stopReason = `the budget of ${formatBudget(budget)} is spent`;
      return false;
    }
    return true;
  }

  /**
   * Replays a recorded run once, as `extra` says (a call forced live, request fields patched), and
   * judges what came out. `tally: false` leaves it out of the counts, for a replay that only confirms
   * what the recording holds. `extra.meta` marks the run before its agent starts (`probe`, `verify`,
   * `repeat`), so run lists bundle it as an attempt while it runs, not only once it is done.
   * `extra.recordedWrites` answers a write the recording made with what it got then (see `ReplayOptions`).
   */
  async attempt(target: AttemptTarget, extra: { divergeAt?: number; interventions?: Interventions; meta?: Partial<RunMeta>; recordedWrites?: boolean } = {}, tally = true): Promise<Attempt> {
    const s = this.settings;
    const cwd = process.cwd();
    const { parent, argv } = target;
    const started = Date.now();
    const replay: Partial<ReplayOptions> = {
      writes: s.writes,
      reads: s.reads,
      liveTools: new Set(s.liveTools),
      // A partial recording (an import that only saw the network) declares what it covers; everything else runs live.
      ...(parent.meta?.covers?.length ? { kinds: new Set(parent.meta.covers) } : {}),
      ...(extra.divergeAt !== undefined ? { divergeAt: extra.divergeAt } : {}),
      ...(extra.recordedWrites ? { recordedWrites: true } : {}),
    };
    const run = this.sidecar.startRun({
      mode: 'replay',
      parentRunId: parent.runId,
      command: { argv, cwd },
      codeVersion: codeVersion(cwd),
      replay,
      ...(extra.interventions ? { interventions: extra.interventions } : {}),
      ...(target.commandFromImport ? { commandFromImport: true } : {}),
    });
    if (extra.meta) this.store.updateRunMeta(run.runId, extra.meta);
    // Who ran it, as every other run says: a blame's probes and the fork that rescued the run, verify's attempts.
    stampAuthor(this.store, run.runId);
    recordsInput(this.store, run.runId);
    const child = spawnAgent(argv[0]!, argv.slice(1), { cwd, env: agentEnv(this.sidecar, run.runId, s.guard, this.upstreams), stdio: ['ignore', 'pipe', 'pipe'], detached: GROUP }, { url: this.sidecar.url, runId: run.runId });
    this.running.add(child);
    let output = '';
    child.stdout!.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (output += d.toString()));
    let timedOut = false;
    const timer =
      s.timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            // Its group, or on Windows its whole process tree, which a signal there can't reach.
            killTree(child, 'SIGTERM', { group: GROUP });
            setTimeout(() => killTree(child, 'SIGKILL', { group: GROUP }), 5_000).unref();
          }, s.timeoutMs);
    const code = await new Promise<number>((resolveCode) => {
      child.on('error', (err) => {
        output += `failed to start ${argv[0]}: ${err.message}\n`;
        resolveCode(127);
      });
      child.on('exit', (c, signal) => resolveCode(c ?? (signal ? 128 : 1)));
    });
    if (timer) clearTimeout(timer);
    this.running.delete(child);
    // Whatever the agent left running in its group goes with it.
    if (GROUP) killTree(child, 'SIGKILL', { group: true });
    const status: Exclude<RunStatus, 'running'> = timedOut || this.interrupted ? 'crashed' : code === 0 ? 'completed' : 'failed';
    const ended = this.sidecar.endRun(run.runId, status);
    telemetry().record({ type: 'replay', ...usageOf(ended, Date.now() - run.startedAt, code) });

    const calls = this.store.getCalls(run.runId);
    const bypassed = !calls.some((c) => c.kind === 'api') && this.recordedModelCalls(parent.runId) > 0;
    if (bypassed) this.warnings.add(BYPASSED);
    const checks = this.check(calls, output);
    const failures = [...(bypassed ? [BYPASSED] : []), ...(timedOut ? [`timed out after ${formatDuration(s.timeoutMs!)}`] : code !== 0 ? [`the agent exited with code ${code}`] : []), ...failed(checks)];
    if (tally && !this.interrupted) {
      this.attempts++;
      this.spent += ended.summary.cost.spent;
      this.upstreamRequests += ended.summary.upstreamRequests;
      for (const m of ended.summary.cost.unknownModels) this.unknownModels.add(m);
    }
    for (const w of ended.summary.warnings) this.warnings.add(w);
    return { run, code, summary: ended.summary, calls, checks, failures, passed: failures.length === 0, bypassed, ms: Date.now() - started };
  }

  private readonly modelCalls = new Map<string, number>();
  private recordedModelCalls(runId: string): number {
    let n = this.modelCalls.get(runId);
    if (n === undefined) {
      n = this.store.getCalls(runId).filter((c) => c.kind === 'api').length;
      this.modelCalls.set(runId, n);
    }
    return n;
  }

  /** The oracle, as the labels of what a passing run must do. */
  oracle(): string[] {
    return oracleLabels(this.settings.spec);
  }

  judgeRecorded(run: RunRecord, calls: CallRecord[]): { passed: boolean | null; failures: string[] } {
    const { passed, failures } = judgeRecording(this.store, run, calls, this.settings.spec, this.config.prices);
    return { passed, failures };
  }

  /** The store's path as given (`--db`), for what runs after the attempts. */
  private db: string | undefined;

  async close(): Promise<void> {
    process.off('SIGINT', this.onSignal);
    process.off('SIGTERM', this.onSignal);
    await this.sidecar.close();
    this.store.close();
    // Team store: attempts someone pushed while they were recording go to the store now that they have ended.
    await pushIfQueued(teamEnv(this.db));
    await telemetry().flush();
  }

  private check(calls: CallRecord[], output: string, spec = this.settings.spec): CheckResult[] {
    if (!spec) return [];
    return evaluateChecks(spec, { ...storedCheckInput(this.store, calls, output, this.config.prices), costOf: this.costOf });
  }
}

/** Why the checks fail a run: each failed check, and each that could not be decided (an inconclusive check never passes). */
const failed = (checks: readonly CheckResult[]) => checks.filter((c) => !c.ok).map((c) => `${c.label}, but ${c.status === 'inconclusive' ? `it is inconclusive: ${c.detail}` : c.detail}`);

/** The oracle, as the labels of what a passing run must do. */
export function oracleLabels(spec: TestSpec | null): string[] {
  return [EXIT_LABEL, ...(spec ? evaluateChecks(spec, LABEL_INPUT).map((c) => c.label) : [])];
}

/**
 * How a recorded run fares against the oracle, from what the recording holds: its exit status and
 * every check but those on its output, which is not recorded; `calls` and `when` rules read the
 * recorded arguments and results, so they cost nothing. Null when that can't settle it, and
 * `unsettled` says why: a check on the output, a check that is inconclusive (a judge with no
 * verdict), a run still recording, or a partial recording that holds no tool calls. `checks` are
 * the results, the ones on the output left out.
 */
export function judgeRecording(
  store: Store,
  run: RunRecord,
  calls: CallRecord[],
  spec: TestSpec | null,
  prices?: ShadowlapConfig['prices'],
  options: EvaluateOptions = {},
): { passed: boolean | null; failures: string[]; checks: CheckResult[]; unsettled: string[] } {
  const failures: string[] = [];
  if (run.status === 'failed') failures.push('the agent exited with a non-zero code');
  else if (run.status === 'crashed') failures.push('the run was interrupted');
  const checks = spec ? evaluateChecks(withoutOutput(spec), storedCheckInput(store, calls, '', prices), options) : [];
  failures.push(...failed(checks.filter((c) => checkStatus(c) === 'failed')));
  const unsettled = [
    ...(run.status === 'running' ? ['it is still recording'] : []),
    ...(spec && readsOutput(spec) ? ["a check reads what the agent printed, which a recording doesn't keep"] : []),
    ...(run.meta?.covers?.length && !run.meta.covers.includes('tool') ? ['it is a partial recording that holds no tool calls'] : []),
    ...failed(checks.filter((c) => c.status === 'inconclusive')),
  ];
  return { passed: failures.length ? false : unsettled.length ? null : true, failures, checks, unsettled };
}
