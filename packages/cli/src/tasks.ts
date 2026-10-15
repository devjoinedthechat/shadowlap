import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attemptScore,
  chatShapeOf,
  commandIsImported,
  describeTask,
  entryFor,
  errorMessage,
  estimateCost,
  formatDivergence,
  goldenPaths,
  isModelRequest,
  oneSided,
  parseTaskFields,
  projectPath,
  readGolden,
  unpackRun,
  untranslatable,
  type CallRecord,
  type Golden,
  type OneSided,
  type Price,
  type ReadPolicy,
  type RunRecord,
  type Store,
  type Task,
  type TaskCheck,
  type TaskFields,
  type TaskScoreRow,
} from '@shadowlap/engine';
import { providers } from '@shadowlap/sidecar';
import { AttemptRunner, BYPASSED, EXIT_LABEL, formatBudget } from './attempts.js';
import { evaluateChecks, parseTests, type CheckResult, type TestSpec } from './checks.js';
import { configPath, upstreamOverrides } from './config.js';
import { type GuardMode } from './run-agent.js';
import { type GlobalOpts } from './shared.js';
import { ANSWERED_BY, modelUnswitchable, startTakeover, takeoverMode, targetVia, type ModelTarget, type Takeover } from './takeover.js';

/**
 * `shadowlap tasks`: the project's goldens as tasks a model can be scored on, and the attempts that
 * score it. An attempt replays the golden up to the takeover call from the recording, for free; from
 * there the model under test answers, every write is stubbed, reads run live (or replay with
 * `--reads replay`), and the golden's checks score what came out: the share of them it passed.
 */

export interface LoadedTask extends Task {
  /** The golden's checks as `shadowlap test` reads them, or null without a tests entry. */
  spec: TestSpec | null;
  /** The golden's directory. */
  dir: string;
  pack: Golden | null;
}

export interface TaskList {
  tasks: LoadedTask[];
  oneSided: OneSided | null;
}

const CHECK_INPUT = { calls: [], output: '', answer: null, argsOf: () => undefined, costOf: () => 0 };

/** Budgets cap what a run spends, not what it does: a task is scored on everything else. */
export function scoringSpec(spec: TestSpec): TestSpec {
  const { inputTokens: _i, outputTokens: _o, cost: _c, ...rest } = spec;
  return rest;
}

/** A tests entry's checks as labels, the budgets marked. */
export function taskChecks(spec: TestSpec | null): TaskCheck[] {
  if (!spec) return [];
  const outcome = evaluateChecks(scoringSpec(spec), CHECK_INPUT).map((c) => ({ label: c.label, cap: false }));
  const caps = evaluateChecks({ fork: spec.fork, repeat: spec.repeat, passes: spec.passes, tools: [], ...(spec.inputTokens ? { inputTokens: spec.inputTokens } : {}), ...(spec.outputTokens ? { outputTokens: spec.outputTokens } : {}), ...(spec.cost ? { cost: spec.cost } : {}) }, CHECK_INPUT).map((c) => ({ label: c.label, cap: true }));
  return [...outcome, ...caps];
}

/**
 * The newest finished `shadowlap test` run of each golden kept in the store (`meta.test`), by the
 * golden's path in the project: read once for every golden. A test still running says nothing yet,
 * so the one before it counts. `shadowlap test` keeps its runs only in a store it is given (`--db`).
 */
export function lastTests(store: Store | null, root: string): Map<string, RunRecord> {
  const out = new Map<string, RunRecord>();
  if (!store) return out;
  for (const run of store.allRuns()) {
    // Newest first: the first finished run of a golden is its last test.
    if (!run.meta?.test || run.status === 'running') continue;
    const golden = projectPath(root, run.meta.test.golden);
    if (!out.has(golden)) out.set(golden, run);
  }
  return out;
}

/** Whether a golden's last test failed: it didn't complete, a check failed, or it diverged without being allowed to fork. Null when it never ran. */
export function testFailed(last: RunRecord | undefined, spec: TestSpec | null): boolean | null {
  if (!last) return null;
  return last.status !== 'completed' || (last.meta?.checks ?? []).some((c) => !c.ok) || (!!last.divergence && !spec?.fork);
}

/** The runs a golden's run came from, nearest first, as far as the store has them. */
function ancestorsOf(store: Store | null, run: RunRecord): RunRecord[] {
  const out: RunRecord[] = [];
  let parent = run.parentRunId;
  while (store && parent && out.length < 100) {
    const r = store.getRun(parent);
    if (!r) break;
    out.push(r);
    parent = r.parentRunId;
  }
  return out;
}

/** Every golden of the project in `root`, as a task. Throws on a config mistake in `tests`. */
export function loadTasks(root: string, store: Store | null): TaskList {
  const path = configPath(root);
  const raw = existsSync(path) ? ((JSON.parse(readFileSync(path, 'utf8')) as { tests?: unknown }).tests ?? undefined) : undefined;
  const entries = parseTests(raw);
  const blocks = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, { task?: unknown }>;
  const fields = new Map<string, TaskFields>();
  for (const e of entries) fields.set(e.recording, parseTaskFields(blocks[e.recording]?.task, `shadowlap.config.json: tests["${e.recording}"].task`));
  const keys = entries.map((e) => e.recording);
  const tests = lastTests(store, root);
  const tasks: LoadedTask[] = goldenPaths(root, keys).map(({ path: golden, exists }) => {
    const key = entryFor(root, keys, golden);
    const spec = key === null ? null : (entries.find((e) => e.recording === key)?.spec ?? null);
    const dir = resolve(root, golden);
    let pack: Golden | null = null;
    let unreadable: string | null = null;
    if (exists) {
      try {
        pack = readGolden(dir, golden);
      } catch (err) {
        unreadable = err instanceof Error ? err.message : String(err);
      }
    }
    const task = describeTask({ path: golden, golden: pack, fields: key === null ? {} : (fields.get(key) ?? {}), checks: taskChecks(spec), testFailed: pack ? testFailed(tests.get(golden), spec) : null, ...(pack && store ? { ancestors: ancestorsOf(store, pack.run) } : {}) });
    return { ...task, ...(unreadable ? { note: `its pack can't be read: ${unreadable}` } : {}), spec, dir, pack };
  });
  return { tasks, oneSided: oneSided(tasks) };
}

// ---- scoring ----

export interface ScoreSettings {
  attempts: number;
  reads: ReadPolicy;
  concurrency: number;
  /** Start no attempt once this many USD are spent, across tasks. */
  budget: number | null;
  timeoutMs: number | null;
  guard: GuardMode;
  /** Take over at this call instead of the task's (tasks serve's `from`). */
  takeover?: number;
  /** Number attempts from here, out of `of` (tasks serve numbers each request's attempt as it comes). */
  first?: number;
  of?: number;
}

export interface ScoredCheck {
  check: string;
  pass: boolean;
  detail: string | null;
}

export interface ScoredAttempt {
  attempt: number;
  runId: string;
  score: number;
  checks: ScoredCheck[];
  /** USD spent on the attempt's live model calls, priced as the model that answered each; the model under test's answers cost 0 on this machine. */
  spent: number;
  exitCode: number;
  ms: number;
}

export interface TaskScore {
  task: string;
  takeover: number;
  why: string;
  /** Calls replayed from the recording before the takeover. */
  prefix: number;
  via: string;
  attempts: ScoredAttempt[];
  mean: number | null;
  /** What every attempt of the task cost, one that stopped before it was scored included. */
  spent: number;
  /** Why it stopped short: the golden didn't replay up to the takeover, the budget, an interrupt. */
  stopped: string | null;
  /** What translating the conversation for the model left out (thinking blocks, a server tool). */
  dropped: string[];
  /** Models with no price, whose attempts' cost is missing. */
  unknownModels: string[];
}

/** Why a task can't be scored with this target, or null when it can. */
export function cannotScore(task: LoadedTask, target: ModelTarget, takeover?: number): string | null {
  if (task.status !== 'ready') return `${task.golden} is ${task.status === 'not-a-task' ? 'not a task' : task.status === 'no-golden' ? 'gone' : 'blocked'}: ${task.note ?? task.status}`;
  if (!task.takeover || !task.pack) return `${task.golden} has no call to take over`;
  const k = takeover ?? task.takeover.callNo;
  const call = task.pack.calls.find((c) => c.callNo === k);
  // A model list, an embedding or a token count asks a model nothing: nothing takes over there.
  if (!call || call.kind !== 'api' || !isModelRequest(call.name)) return `#${k} is not a model call of ${task.golden}'s run${call ? ` (${call.name})` : ''}`;
  if (task.scope !== null && takeover !== undefined && (typeof call.meta.scope === 'string' ? call.meta.scope : null) !== task.scope) return `#${k} is not made in the agent's scope (${task.scope})`;
  const provider = (call.end?.meta.provider ?? call.meta.provider) as string | undefined;
  if (!provider) return `${task.golden} can't be scored: its recording doesn't say which provider #${k} went to`;
  const shape = chatShapeOf(provider, call.name);
  const mode = takeoverMode(provider, shape, target);
  if (!mode) return `${task.golden} can't be answered by ${target.model}${target.baseUrl ? ` at ${target.baseUrl}` : ''}: ${untranslatable(provider, call.name)}, and only Anthropic Messages and OpenAI Chat Completions are translated`;
  if (mode === 'same') {
    // Found before anything runs: an attempt would ask the recorded model, and be paid for.
    const why = modelUnswitchable(provider, call.name);
    if (why) return `${task.golden} can't be scored with ${target.model}: ${why}`;
  }
  return null;
}

/** Where a provider's calls go without a takeover: the environment's upstream for it, else its own API. */
function providerUpstream(provider: string): string | null {
  return upstreamOverrides(process.env)[provider] || providers.find((x) => x.id === provider)?.upstream || null;
}

/** The model that answered a call: the takeover upstream's word for its answers, else the model the request named. */
export function answeredBy(c: CallRecord): string | null {
  const said = c.end?.meta.headers?.[ANSWERED_BY];
  if (typeof said === 'string' && said) return said;
  const m = c.end?.meta.model ?? c.meta.model;
  return typeof m === 'string' ? m : null;
}

/**
 * What an attempt's live model calls cost, priced as the model that answered each. A model on this
 * machine answers for nothing; the provider's own calls (an embedding, a token count) are priced as
 * any other. `unknown` collects the models with no price.
 */
export function attemptCost(calls: readonly CallRecord[], target: ModelTarget, prices: Record<string, Price> | undefined, unknown: Set<string>): number {
  let spent = 0;
  for (const c of calls) {
    const usage = c.end?.meta.usage;
    if (c.kind !== 'api' || c.origin !== 'live' || !usage) continue;
    const fromTakeover = typeof c.end?.meta.headers?.[ANSWERED_BY] === 'string';
    if (fromTakeover && target.local) continue;
    const model = answeredBy(c);
    const usd = estimateCost(model, usage, prices);
    if (usd === null) {
      if (model) unknown.add(model);
    } else spent += usd;
  }
  return spent;
}

/**
 * Scores one task: `settings.attempts` attempts, each a replay of the golden that the model under
 * test takes over at the takeover call. Every attempt is a run in the store, marked with what it
 * scored, or why it stopped before it could be scored. The first attempt runs on its own: a model
 * that doesn't answer, or a golden that forks before its takeover, stops the task after one attempt
 * whatever the concurrency. `spentBefore` counts toward the budget.
 */
export async function scoreTask(
  opts: GlobalOpts,
  task: LoadedTask,
  target: ModelTarget,
  settings: ScoreSettings,
  session: { id: string; spentBefore: number },
  onAttempt: (a: ScoredAttempt, task: LoadedTask) => void = () => {},
): Promise<TaskScore> {
  const refused = cannotScore(task, target, settings.takeover);
  if (refused) throw new Error(refused);
  const k = settings.takeover ?? task.takeover!.callNo;
  const call = task.pack!.calls.find((c) => c.callNo === k)!;
  const provider = (call.end?.meta.provider ?? call.meta.provider) as string;
  const shape = chatShapeOf(provider, call.name);
  const via = targetVia(target, provider);
  // Every call before the takeover replays from the recording, so the first request the upstream
  // gets is the takeover call: nothing is counted to find it, whatever the agent asked before.
  const takeover: Takeover = await startTakeover({ provider, shape, mode: takeoverMode(provider, shape, target)! }, target, { upstream: providerUpstream(provider) });
  const spec = task.spec ? scoringSpec(task.spec) : null;
  let runner: AttemptRunner;
  try {
    // The budget is kept here, at the prices of the models that answered.
    runner = await AttemptRunner.start(opts, { writes: 'stub', reads: settings.reads, liveTools: [], spec, budget: null, timeoutMs: settings.timeoutMs, guard: settings.guard, upstreams: { [provider]: takeover.url } });
  } catch (err) {
    await takeover.close();
    throw err;
  }
  const result: TaskScore = { task: task.golden, takeover: k, why: settings.takeover !== undefined ? 'asked for' : task.takeover!.why, prefix: task.pack!.calls.filter((c) => c.callNo < k).length, via, attempts: [], mean: null, spent: 0, stopped: null, dropped: [], unknownModels: [] };
  const unknown = new Set<string>();
  const of = settings.of ?? settings.attempts;
  let spent = 0;
  let budgetSpent = false;
  try {
    const { store } = runner;
    if (!store.getRun(task.runId!)) unpackRun(store, task.dir);
    const parent = store.getRun(task.runId!);
    if (!parent) throw new Error(`${task.golden}'s run could not be imported`);
    const target_ = { parent, argv: parent.command.argv, commandFromImport: commandIsImported(parent) };
    // Every attempt is marked as one, scored or not, so nothing reads it as another kind of attempt (a --repeat).
    const mark = (runId: string, n: number, outcome: { score: number } | { stopped: string }, extra: Partial<RunRecord['meta']> = {}) =>
      store.updateRunMeta(runId, {
        repeat: { group: `${session.id}-${task.name}`, attempt: n, of },
        task: { golden: task.golden, model: target.model, ...(target.scoreBase ? { baseUrl: target.scoreBase } : {}), takeover: k, attempt: n, of, session: session.id, ...('score' in outcome ? { score: outcome.score } : { score: null, stopped: outcome.stopped.split('\n')[0]! }) },
        ...extra,
      });
    let launched = 0;
    /** One attempt; false when the task must stop. */
    const one = async (): Promise<boolean> => {
      const n = (settings.first ?? 1) + launched++;
      const a = await runner.attempt(target_, { divergeAt: k });
      const cost = attemptCost(a.calls, target, runner.config.prices, unknown);
      if (!runner.interrupted) spent += cost;
      const stop = (reason: string) => {
        result.stopped ??= reason;
        mark(a.run.runId, n, { stopped: reason });
        return false;
      };
      if (runner.interrupted) return stop('interrupted');
      const d = a.summary.divergence;
      if (a.bypassed || !d || d.type !== 'forced' || d.callNo !== k || d.kind !== 'api') {
        // The prefix must be the recording's: an attempt that forked elsewhere answered another question.
        return stop(
          a.bypassed
            ? `${BYPASSED} (run ${a.run.runId})`
            : d
              ? `${task.golden} doesn't replay up to #${k}: it forked at call ${d.callNo} first (run ${a.run.runId}).\n${formatDivergence(d)}\nMake its test pass first: shadowlap test ${task.golden}`
              : `${task.golden} never reached #${k}: the agent took another path through the recording (run ${a.run.runId})`,
        );
      }
      const at = a.calls.find((c) => c.callNo === k);
      if (at?.end?.outcome === 'error') {
        // The model never answered the takeover: a score would grade the endpoint, not the model.
        const body = at.end.responseRef ? store.getBlob(at.end.responseRef)?.toString('utf8') : undefined;
        let message = at.end.meta.error?.message ?? `HTTP ${at.end.meta.status ?? 'error'}`;
        try {
          message = errorMessage(JSON.parse(body ?? 'null'), message);
        } catch {
          // not JSON: keep the status
        }
        return stop(`${target.model} didn't answer #${k}: ${message} (run ${a.run.runId})`);
      }
      // The score must be the model under test's: the takeover upstream says so on every answer it gives.
      if (at?.end?.meta.headers?.[ANSWERED_BY] !== target.model) {
        const went = at ? ((at.end?.meta.provider ?? at.meta.provider) as string | undefined) : undefined;
        return stop(`${target.model} didn't answer #${k}: ${!at ? `the agent made no call #${k}` : went && went !== provider ? `the agent sent it to ${went}, not ${provider}` : 'its answer came from somewhere else'} (run ${a.run.runId})`);
      }
      const exit: ScoredCheck = { check: EXIT_LABEL, pass: a.code === 0, detail: a.code === 0 ? null : a.failures.find((f) => /exited|timed out/.test(f)) ?? `the agent exited with code ${a.code}` };
      const checks: ScoredCheck[] = [exit, ...a.checks.map((c: CheckResult) => ({ check: c.label, pass: c.ok, detail: c.detail }))];
      const score = attemptScore(checks.map((c) => ({ ok: c.pass })));
      const scored: ScoredAttempt = { attempt: n, runId: a.run.runId, score, checks, spent: cost, exitCode: a.code, ms: a.ms };
      result.attempts.push(scored);
      mark(a.run.runId, n, { score }, a.checks.length ? { checks: a.checks } : {});
      onAttempt(scored, task);
      return true;
    };
    const canStart = () => {
      if (!runner.canStart()) return false;
      if (settings.budget !== null && session.spentBefore + spent >= settings.budget) {
        budgetSpent = true;
        return false;
      }
      return true;
    };
    const more = () => !result.stopped && launched < settings.attempts && canStart();
    const worker = async () => {
      while (more() && (await one()));
    };
    if (more() && (await one())) await Promise.all(Array.from({ length: Math.max(1, Math.min(settings.concurrency, settings.attempts - launched)) }, worker));
    if (!result.stopped && result.attempts.length < settings.attempts) result.stopped = budgetSpent ? `the budget of ${formatBudget(settings.budget!)} is spent` : (runner.stopReason ?? 'stopped');
    result.attempts.sort((x, y) => x.attempt - y.attempt);
    // What the task's attempts cost, a stopped one's included: it was spent all the same.
    result.spent = spent;
    result.mean = result.attempts.length ? result.attempts.reduce((s, a) => s + a.score, 0) / result.attempts.length : null;
    result.dropped = [...takeover.dropped];
    result.unknownModels = [...unknown];
    return result;
  } finally {
    await runner.close();
    await takeover.close();
  }
}

export interface KeptScores {
  /** `replaced`: the earlier score gave way to this one. `new`: there was none. `kept`: this one stopped short, and the earlier one stands. */
  outcome: 'new' | 'replaced' | 'kept' | 'none';
  /** The attempts the model had on the task before. */
  before: TaskScoreRow[];
}

/**
 * Keeps a model's scores on a task. A score that ran every attempt it was asked for replaces what the
 * model scored there before; one that stopped short (the budget, an interrupt, a model that stopped
 * answering) is kept only when there was nothing before, so a cut-short re-score never wipes a whole
 * one.
 */
export function keepScores(store: Store, target: ModelTarget, score: TaskScore, session: string, asked: number): KeptScores {
  const before = store.listTaskScores().filter((r) => r.model === target.model && r.baseUrl === target.scoreBase && r.golden === score.task);
  if (!score.attempts.length) return { outcome: 'none', before };
  if (score.attempts.length < asked && before.length) return { outcome: 'kept', before };
  const at = Date.now();
  store.replaceTaskScores(
    target.model,
    target.scoreBase,
    score.task,
    score.attempts.map((a) => ({ attempt: a.attempt, runId: a.runId, score: a.score, checks: a.checks.map((c) => ({ label: c.check, ok: c.pass, detail: c.detail })), spent: a.spent, via: score.via, session, at })),
  );
  return { outcome: before.length ? 'replaced' : 'new', before };
}
