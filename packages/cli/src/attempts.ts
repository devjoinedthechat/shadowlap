import type { ChildProcess } from 'node:child_process';
import { checkStatus, estimateCost, formatDuration, formatUsd, isJudgeCall, judgeTarget, type CallRecord, type ReadPolicy, type ReplayOptions, type RunMeta, type RunRecord, type RunStatus, type Store } from '@shadowlap/engine';
import { Sidecar, type Interventions } from '@shadowlap/sidecar';
import { stampAuthor } from './activity.js';
import { AGENT_NODE_TOO_OLD, refusedPreload } from './agent-node.js';
import { spawnAgent } from './agent-registry.js';
import { AgentStop, exitStatus, GROUPS, trackAgent } from './agent-signals.js';
import { evaluateChecks, judgeChecksOf, judgeLabel, LABEL_INPUT, readsOutput, storedCheckInput, withoutOutput, type CheckResult, type EvaluateOptions, type JudgeCheck, type TestSpec } from './checks.js';
import { killTree } from './kill-tree.js';
import { codeVersion, loadConfig, upstreamOverrides, type ShadowlapConfig } from './config.js';
import { judgedOptions, judgesOf, liveJudge, recordedVerdicts, type Judged } from './judge.js';
import { stampKeyEnv } from './placeholder-keys.js';
import { agentEnv, judgeAttempt, outputDrained, recordsInput, type GuardMode } from './run-agent.js';
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
  /** Where the agent runs (`test --cwd`); the current folder by default. */
  cwd?: string;
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
   * How it came out: inconclusive when all it fell short on is a check that could not be decided (a
   * judge that could not answer, a condition it could not read): no failure of the agent's, and no
   * pass either.
   */
  verdict: 'passed' | 'failed' | 'inconclusive';
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
 * longer hears the terminal's Ctrl-C itself, so the signal is passed on, once (AgentStop). Windows
 * has no groups: there the agent's whole process tree is ended while it runs (killTree).
 */
const GROUP = GROUPS;

export class AttemptRunner {
  /** Attempts run and tallied, and what they sent upstream and cost: the agent's, and apart, its judge checks'. */
  attempts = 0;
  spent = 0;
  upstreamRequests = 0;
  judgeSpent = 0;
  judgeRequests = 0;
  readonly unknownModels = new Set<string>();
  /** What the replays warned about, once each: a tool that changed since its recording, a connection that bypassed Shadowlap. */
  readonly warnings = new Set<string>();
  /** Ctrl-C: an attempt it cut short is no evidence either way. */
  interrupted = false;
  /** Why no more attempts may start, once one of them can't. */
  stopReason: string | null = null;

  private readonly running = new Set<ChildProcess>();
  /** Runs whose agent has exited and whose judge checks are being asked: still open. */
  private readonly judging = new Set<string>();
  /**
   * SIGINT, SIGTERM and SIGHUP, for as long as the runner is open: the first is passed on to every
   * agent running, which has a moment to end before it is killed, so whoever sent the signal (a
   * dashboard stopping its job, 5 s later) never kills this process first and leaves an agent's group
   * running with nobody to end it; a second kills them at once. With no agent left, a second ends the
   * runs whose judge is being asked as interrupted, and this process with them.
   */
  private readonly stopSignals = new AgentStop({
    group: GROUP,
    onSignal: () => {
      this.interrupted = true;
      this.stopReason = 'interrupted';
    },
    abandon: () => {
      for (const runId of this.judging) this.sidecar.endRun(runId, 'crashed');
      this.judging.clear();
    },
  });

  private constructor(
    readonly store: Store,
    private readonly sidecar: Sidecar,
    readonly config: ShadowlapConfig,
    private readonly settings: AttemptSettings,
    private readonly upstreams: Record<string, string>,
  ) {
    this.stopSignals.start();
  }

  /**
   * `given.store`: the attempts go into a store the caller has open and keeps (`shadowlap test`'s,
   * which `--db :memory:` makes the only one); the runner leaves it open when it closes.
   */
  static async start(opts: GlobalOpts, settings: AttemptSettings, given: { store?: Store } = {}): Promise<AttemptRunner> {
    const store = given.store ?? openStore(opts);
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
        ...(config.tools ? { trust: config.tools } : {}),
        ...(opts.verbose ? { log: (line: string) => void process.stderr.write(p.dim(`[shadowlap] ${line}\n`)) } : {}),
      });
      const runner = new AttemptRunner(store, sidecar, config, settings, upstreams);
      runner.db = opts.db;
      runner.ownsStore = !given.store;
      return runner;
    } catch (err) {
      if (!given.store) store.close();
      throw err;
    }
  }

  /** A model call's estimated cost under the configured prices, or null without one. */
  costOf = (c: CallRecord): number | null => estimateCost(c.end?.meta.model ?? c.meta.model, c.end?.meta.usage, this.config.prices);

  /** Whether another attempt may start: nothing interrupted, and budget left (the judge's spend counts). Says why not in `stopReason`. */
  canStart(): boolean {
    if (this.stopReason) return false;
    const { budget } = this.settings;
    if (budget !== null && this.spent + this.judgeSpent >= budget) {
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
  async attempt(target: AttemptTarget, extra: { divergeAt?: number; interventions?: Interventions; meta?: Partial<RunMeta>; recordedWrites?: boolean; plants?: ReadonlyMap<number, string>; overrides?: ReadonlyMap<number, unknown>; plantMarks?: ReplayOptions['plantMarks']; unrecordedReads?: ReplayOptions['unrecordedReads'] } = {}, tally = true): Promise<Attempt> {
    const s = this.settings;
    const cwd = s.cwd ?? process.cwd();
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
      // shadowlap injection: a payload planted in an untrusted read, or the read made neutral (--clean).
      ...(extra.plants?.size ? { plants: extra.plants } : {}),
      ...(extra.overrides?.size ? { overrides: extra.overrides } : {}),
      ...(extra.plantMarks?.texts.length ? { plantMarks: extra.plantMarks } : {}),
      // shadowlap injection: reads the recording doesn't hold fenced after the fork.
      ...(extra.unrecordedReads ? { unrecordedReads: extra.unrecordedReads } : {}),
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
    stampKeyEnv(this.store, run.runId);
    recordsInput(this.store, run.runId);
    const child = spawnAgent(argv[0]!, argv.slice(1), { cwd, env: agentEnv(this.sidecar, run.runId, s.guard, this.upstreams), stdio: ['ignore', 'pipe', 'pipe'], detached: GROUP }, { url: this.sidecar.url, runId: run.runId });
    this.running.add(child);
    trackAgent(child, GROUP);
    this.stopSignals.add(child);
    let output = '';
    // What a judge check reads as the output: stdout alone, which interleaving with stderr can't change.
    let stdout = '';
    child.stdout!.on('data', (d: Buffer) => {
      output += d.toString();
      stdout += d.toString();
    });
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
      child.on('exit', (c, signal) => resolveCode(exitStatus(c, signal)));
    });
    if (timer) clearTimeout(timer);
    this.running.delete(child);
    // Whatever the agent left running in its group goes with it.
    if (GROUP) killTree(child, 'SIGKILL', { group: true });
    // An agent on a Node before 18.18 never started: its Node refused the preload and exited 9, as it
    // would in every attempt. None is kept, counted or judged; the command stops and says why.
    if (code === 9 && !timedOut && !this.interrupted && this.store.countCalls(run.runId) === 0) {
      await outputDrained(child);
      if (refusedPreload(output)) {
        this.sidecar.endRun(run.runId, 'failed');
        this.store.deleteRun(run.runId);
        this.stopReason = AGENT_NODE_TOO_OLD;
        for (const other of this.running) killTree(other, 'SIGKILL', { group: GROUP });
        throw new Error(AGENT_NODE_TOO_OLD);
      }
    }
    // Judge checks once the agent has exited, while the run is open: an attempt is a fork, so its
    // judge runs live, through the judge's own upstream (never a model under test), and is recorded.
    if (s.spec && judgesOf(s.spec).length) await outputDrained(child);
    this.judging.add(run.runId);
    const judged = s.spec && judgesOf(s.spec).length ? await judgeAttempt(this.store, this.sidecar, run.runId, s.spec, { code, timedOut, interrupted: this.interrupted, stdout, upstreams: upstreamOverrides(process.env), redact: this.config.redact, normalize: this.config.normalize, clock: this.config.clock, prices: this.config.prices }) : null;
    this.judging.delete(run.runId);
    // A signal heard while the judge was asked interrupted the attempt too: it is read after the judge.
    const status: Exclude<RunStatus, 'running'> = timedOut || this.interrupted ? 'crashed' : code === 0 ? 'completed' : 'failed';
    const ended = this.sidecar.endRun(run.runId, status);
    telemetry().record({ type: 'replay', ...usageOf(ended, Date.now() - run.startedAt, code) });

    const calls = this.store.getCalls(run.runId);
    const bypassed = !calls.some((c) => c.kind === 'api' && !isJudgeCall(c)) && this.recordedModelCalls(parent.runId) > 0;
    if (bypassed) this.warnings.add(BYPASSED);
    const checks = this.check(calls, output, s.spec, judged);
    const failures = [...(bypassed ? [BYPASSED] : []), ...(timedOut ? [`timed out after ${formatDuration(s.timeoutMs!)}`] : code !== 0 ? [`the agent exited with code ${code}`] : []), ...failed(checks)];
    if (tally && !this.interrupted) {
      this.attempts++;
      this.spent += ended.summary.cost.spent;
      this.upstreamRequests += ended.summary.upstreamRequests;
      for (const m of ended.summary.cost.unknownModels) this.unknownModels.add(m);
    }
    // The judge's calls apart, in every attempt: a replay as recorded is free for the agent, but a
    // judge its recording held no verdict for was asked live. What they cost counts against the
    // budget, and is reported beside the agent's.
    this.judgeSpent += ended.summary.judge?.spent ?? 0;
    this.judgeRequests += ended.summary.judge?.upstreamRequests ?? 0;
    for (const m of ended.summary.judge?.unknownModels ?? []) this.unknownModels.add(m);
    for (const w of ended.summary.warnings) this.warnings.add(w);
    // The agent exited 0 in time, through Shadowlap, and failed no check: only an undecided check kept it from passing.
    const undecided = !bypassed && !timedOut && code === 0 && checks.some((c) => !c.ok) && checks.every((c) => c.ok || c.status === 'inconclusive');
    const verdict = failures.length === 0 ? 'passed' : undecided ? 'inconclusive' : 'failed';
    return { run, code, summary: ended.summary, calls, checks, failures, passed: failures.length === 0, verdict, bypassed, ms: Date.now() - started };
  }

  private readonly modelCalls = new Map<string, number>();
  private recordedModelCalls(runId: string): number {
    let n = this.modelCalls.get(runId);
    if (n === undefined) {
      n = this.store.getCalls(runId).filter((c) => c.kind === 'api' && !isJudgeCall(c)).length;
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
  /** False for a store the caller passed in, which it closes itself. */
  private ownsStore = true;

  async close(): Promise<void> {
    this.stopSignals.stop();
    await this.sidecar.close();
    if (this.ownsStore) this.store.close();
    // Team store: attempts someone pushed while they were recording go to the store now that they have ended.
    await pushIfQueued(teamEnv(this.db));
    await telemetry().flush();
  }

  private check(calls: CallRecord[], output: string, spec = this.settings.spec, judged: Judged | null = null): CheckResult[] {
    if (!spec) return [];
    return evaluateChecks(spec, { ...storedCheckInput(this.store, calls, output, this.config.prices), costOf: this.costOf }, judgedOptions(judged));
  }
}

/** Why the checks fail a run: each failed check, and each that could not be decided (an inconclusive check never passes). */
const failed = (checks: readonly CheckResult[]) => checks.filter((c) => !c.ok).map((c) => `${c.label}, but ${c.status === 'inconclusive' ? `it is inconclusive: ${c.detail}` : c.detail}`);

/**
 * Why an attempt can't have a verdict for a judge check, or null when it can: an attempt is a fork,
 * so its judge is asked live, through the upstream the environment sets for its provider or with
 * the provider's key, as the attempt itself will ask it (judgeAttempt).
 */
export function attemptJudgeMissing(j: JudgeCheck, upstreams: Record<string, string> = upstreamOverrides(process.env), env: NodeJS.ProcessEnv = process.env): string | null {
  const target = judgeTarget(j.model);
  if (!target) return `Shadowlap can't tell which provider serves ${j.model}`;
  const live = liveJudge(target.provider, upstreams, env);
  return 'why' in live ? `an attempt is a fork, whose judge must be asked live: ${live.why}` : null;
}

/**
 * The checks of an oracle that no attempt can decide, each with why: a judge check no attempt can
 * have a verdict for. Every attempt would read inconclusive on it and none could pass, so blame,
 * verify and repair refuse such an oracle before they spend anything.
 */
export function undecidableChecks(spec: TestSpec | null, missing: (j: JudgeCheck) => string | null = (j) => attemptJudgeMissing(j)): Array<{ label: string; why: string }> {
  if (!spec) return [];
  return judgeChecksOf(spec).flatMap((j) => {
    const why = missing(j);
    return why ? [{ label: judgeLabel(j), why }] : [];
  });
}

/** The refusal of an oracle with checks no attempt can decide, for `command` (blame, verify, repair), or null when there are none. */
export function undecidableRefusal(spec: TestSpec | null, command: string): string | null {
  const undecided = undecidableChecks(spec);
  if (!undecided.length) return null;
  const one = undecided.length === 1;
  return `--expect has ${one ? 'a check' : `${undecided.length} checks`} no attempt can decide: ${undecided.map((u) => `${u.label} (${u.why})`).join('; ')}. Every attempt would read inconclusive, and none could pass, so ${command} would spend attempts to say nothing. Leave ${one ? 'it' : 'them'} out of --expect; shadowlap check judges recordings by ${one ? 'it' : 'them'}, from what they recorded.`;
}

/** The oracle, as the labels of what a passing run must do. */
export function oracleLabels(spec: TestSpec | null): string[] {
  return [EXIT_LABEL, ...(spec ? evaluateChecks(spec, LABEL_INPUT).map((c) => c.label) : [])];
}

/**
 * How a recorded run fares against the oracle, from what the recording holds: its exit status and
 * every check but those on its output, which is not recorded; `calls` and `when` rules read the
 * recorded arguments and results, so they cost nothing. A judge check takes the verdict the run holds
 * for it (its own judge call), and is no evidence either way without one. Null when that can't
 * settle it, and `unsettled` says why: a check on the output, a check that is inconclusive (a judge
 * with no recorded verdict), a run still recording, or a partial recording that holds no tool calls.
 * `checks` are the results, the ones on the output left out.
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
  // A judge check takes the verdict the run already holds for it: the call its judge made, answered.
  const judges = spec ? judgeChecksOf(spec) : [];
  const held = judges.length && !options.judgeVerdicts ? judgedOptions(recordedVerdicts(store, calls, judges)) : {};
  const checks = spec ? evaluateChecks(withoutOutput(spec), storedCheckInput(store, calls, '', prices), { ...held, ...options }) : [];
  failures.push(...failed(checks.filter((c) => checkStatus(c) === 'failed')));
  const unsettled = [
    ...(run.status === 'running' ? ['it is still recording'] : []),
    ...(spec && readsOutput(spec) ? ["a check reads what the agent printed, which a recording doesn't keep"] : []),
    ...(run.meta?.covers?.length && !run.meta.covers.includes('tool') ? ['it is a partial recording that holds no tool calls'] : []),
    ...failed(checks.filter((c) => c.status === 'inconclusive')),
  ];
  return { passed: failures.length ? false : unsettled.length ? null : true, failures, checks, unsettled };
}
