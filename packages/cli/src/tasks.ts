import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attemptScore,
  chatShapeOf,
  commandIsImported,
  describeTask,
  entryFor,
  errorMessage,
  formatDivergence,
  goldenPaths,
  loadApiRequest,
  oneSided,
  parseTaskFields,
  projectPath,
  readGolden,
  unpackRun,
  untranslatable,
  type CallRecord,
  type Golden,
  type OneSided,
  type ReadPolicy,
  type RunRecord,
  type Store,
  type Task,
  type TaskCheck,
  type TaskFields,
} from '@shadowlap/engine';
import { AttemptRunner, BYPASSED, EXIT_LABEL } from './attempts.js';
import { evaluateChecks, parseTests, type CheckResult, type TestSpec } from './checks.js';
import { configPath } from './config.js';
import { type GuardMode } from './run-agent.js';
import { type GlobalOpts } from './shared.js';
import { needsTakeover, startTakeover, targetVia, type ModelTarget, type Takeover } from './takeover.js';

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
 * Whether a golden's test fails, from the last `shadowlap test` run of it kept in the store
 * (`meta.test`). Null when it never ran with a store.
 */
export function lastTestFailed(store: Store | null, root: string, golden: string, spec: TestSpec | null): boolean | null {
  if (!store) return null;
  const last = store.allRuns().find((r) => r.meta?.test && projectPath(root, r.meta.test.golden) === golden);
  if (!last || last.status === 'running') return null;
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
    const task = describeTask({ path: golden, golden: pack, fields: key === null ? {} : (fields.get(key) ?? {}), checks: taskChecks(spec), testFailed: pack ? lastTestFailed(store, root, golden, spec) : null, ...(pack && store ? { ancestors: ancestorsOf(store, pack.run) } : {}) });
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
  /** USD spent on the attempt's live model calls; 0 for a model on this machine. */
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
  spent: number;
  /** Why it stopped short: the golden didn't replay up to the takeover, the budget, an interrupt. */
  stopped: string | null;
  /** What translating the conversation for the model left out (thinking blocks, a server tool). */
  dropped: string[];
  /** Models with no price, whose attempts' cost is missing. */
  unknownModels: string[];
}

/**
 * The model a recorded model request asked for: the one its URL names (Gemini and Vertex
 * `…/models/<m>:…`, Bedrock `…/model/<m>/…`, an Azure deployment), else its `model` field. Null when
 * neither says.
 */
export function askedModel(store: Store, call: Pick<CallRecord, 'name' | 'requestRef'>): string | null {
  const path = call.name.replace(/^[A-Z]+\s+/, '').split('?')[0] ?? '';
  const named = /\/models\/([^/:]+)[:/]/.exec(path) ?? /\/model\/([^/]+)\//.exec(path) ?? /\/deployments\/([^/]+)\//.exec(path);
  if (named) {
    try {
      return decodeURIComponent(named[1]!);
    } catch {
      return named[1]!;
    }
  }
  if (!call.requestRef) return null;
  try {
    const body = loadApiRequest(store, call.requestRef) as { model?: unknown } | null;
    return typeof body?.model === 'string' ? body.model : null;
  } catch {
    return null;
  }
}

/** Why a task can't be scored with this target, or null when it can. */
export function cannotScore(task: LoadedTask, target: ModelTarget, takeover?: number): string | null {
  if (task.status !== 'ready') return `${task.golden} is ${task.status === 'not-a-task' ? 'not a task' : task.status === 'no-golden' ? 'gone' : 'blocked'}: ${task.note ?? task.status}`;
  if (!task.takeover || !task.pack) return `${task.golden} has no call to take over`;
  const k = takeover ?? task.takeover.callNo;
  const call = task.pack.calls.find((c) => c.callNo === k);
  if (!call || call.kind !== 'api') return `#${k} is not a model call of ${task.golden}'s run`;
  const provider = (call.end?.meta.provider ?? call.meta.provider) as string | undefined;
  const shape = chatShapeOf(provider, call.name);
  if (target.route !== 'same' && !shape) return `${task.golden} can't be answered by ${target.model}${target.baseUrl ? ` at ${target.baseUrl}` : ''}: ${untranslatable(provider, call.name)}, and only Anthropic Messages and OpenAI Chat Completions are translated`;
  return null;
}

/**
 * Scores one task: `settings.attempts` attempts, each a replay of the golden that the model under
 * test takes over at the takeover call. Every attempt is a run in the store, marked with what it
 * scored. `spentBefore` counts toward the budget.
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
  const provider = (call.end?.meta.provider ?? call.meta.provider) as string | undefined;
  const shape = chatShapeOf(provider, call.name);
  const via = targetVia(target, provider ?? null);
  let takeover: Takeover | null = null;
  if (shape && needsTakeover(shape, target, provider ?? null)) takeover = await startTakeover(shape, target);
  const budget = settings.budget === null ? null : Math.max(0, settings.budget - session.spentBefore);
  const spec = task.spec ? scoringSpec(task.spec) : null;
  let runner: AttemptRunner;
  try {
    runner = await AttemptRunner.start(opts, { writes: 'stub', reads: settings.reads, liveTools: [], spec, budget, timeoutMs: settings.timeoutMs, guard: settings.guard, ...(takeover && provider ? { upstreams: { [provider]: takeover.url } } : {}) });
  } catch (err) {
    await takeover?.close();
    throw err;
  }
  const result: TaskScore = { task: task.golden, takeover: k, why: settings.takeover !== undefined ? 'asked for' : task.takeover!.why, prefix: task.pack!.calls.filter((c) => c.callNo < k).length, via, attempts: [], mean: null, spent: 0, stopped: null, dropped: [], unknownModels: [] };
  const unknown = new Set<string>();
  try {
    const { store } = runner;
    if (!store.getRun(task.runId!)) unpackRun(store, task.dir);
    const parent = store.getRun(task.runId!);
    if (!parent) throw new Error(`${task.golden}'s run could not be imported`);
    const target_ = { parent, argv: parent.command.argv, commandFromImport: commandIsImported(parent) };
    const interventions = { set: { fromCall: k, fields: { model: target.model } } };
    let launched = 0;
    const worker = async () => {
      while (!result.stopped && launched < settings.attempts && runner.canStart()) {
        const n = (settings.first ?? 1) + launched++;
        const a = await runner.attempt(target_, { divergeAt: k, interventions });
        if (runner.interrupted) {
          result.stopped = 'interrupted';
          break;
        }
        const d = a.summary.divergence;
        if (a.bypassed || !d || d.type !== 'forced' || d.callNo !== k || d.kind !== 'api') {
          // The prefix must be the recording's: an attempt that forked elsewhere answered another question.
          result.stopped = a.bypassed
            ? `${BYPASSED} (run ${a.run.runId})`
            : d
              ? `${task.golden} doesn't replay up to #${k}: it forked at call ${d.callNo} first (run ${a.run.runId}).\n${formatDivergence(d)}\nMake its test pass first: shadowlap test ${task.golden}`
              : `${task.golden} never reached #${k}: the agent took another path through the recording (run ${a.run.runId})`;
          store.updateRunMeta(a.run.runId, { repeat: { group: `${session.id}-${task.name}`, attempt: n, of: settings.of ?? settings.attempts } });
          break;
        }
        const at = a.calls.find((c) => c.callNo === k);
        // The score must be the model under test's: a request whose model --model can't change asked the recorded one.
        const asked = at ? askedModel(store, at) : null;
        if (asked !== null && asked !== target.model) {
          result.stopped = `${target.model} wasn't asked at #${k}: the request still named ${asked}, because --model can't change the model of ${provider ? `a ${provider}` : 'this'} request yet (run ${a.run.runId})`;
          store.updateRunMeta(a.run.runId, { repeat: { group: `${session.id}-${task.name}`, attempt: n, of: settings.of ?? settings.attempts } });
          break;
        }
        if (at?.end?.outcome === 'error') {
          // The model never answered the takeover: a score would grade the endpoint, not the model.
          const body = at.end.responseRef ? store.getBlob(at.end.responseRef)?.toString('utf8') : undefined;
          let message = at.end.meta.error?.message ?? `HTTP ${at.end.meta.status ?? 'error'}`;
          try {
            message = errorMessage(JSON.parse(body ?? 'null'), message);
          } catch {
            // not JSON: keep the status
          }
          result.stopped = `${target.model} didn't answer #${k}: ${message} (run ${a.run.runId})`;
          store.updateRunMeta(a.run.runId, { repeat: { group: `${session.id}-${task.name}`, attempt: n, of: settings.of ?? settings.attempts } });
          break;
        }
        const exit: ScoredCheck = { check: EXIT_LABEL, pass: a.code === 0, detail: a.code === 0 ? null : a.failures.find((f) => /exited|timed out/.test(f)) ?? `the agent exited with code ${a.code}` };
        const checks: ScoredCheck[] = [exit, ...a.checks.map((c: CheckResult) => ({ check: c.label, pass: c.ok, detail: c.detail }))];
        const score = attemptScore(checks.map((c) => ({ ok: c.pass })));
        const spent = target.local ? 0 : a.summary.cost.spent;
        // Only what ran live is paid for: the prefix's model, replayed, costs nothing here.
        if (!target.local) {
          for (const c of a.calls) {
            if (c.kind !== 'api' || c.origin !== 'live' || !c.end?.meta.usage || runner.costOf(c) !== null) continue;
            const m = c.end.meta.model ?? c.meta.model;
            if (typeof m === 'string') unknown.add(m);
          }
        }
        const scored: ScoredAttempt = { attempt: n, runId: a.run.runId, score, checks, spent, exitCode: a.code, ms: a.ms };
        result.attempts.push(scored);
        store.updateRunMeta(a.run.runId, {
          repeat: { group: `${session.id}-${task.name}`, attempt: n, of: settings.of ?? settings.attempts },
          task: { golden: task.golden, model: target.model, ...(target.scoreBase ? { baseUrl: target.scoreBase } : {}), takeover: k, attempt: n, of: settings.of ?? settings.attempts, score, session: session.id },
          ...(a.checks.length ? { checks: a.checks } : {}),
        });
        onAttempt(scored, task);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(settings.concurrency, settings.attempts)) }, worker));
    if (!result.stopped && result.attempts.length < settings.attempts) result.stopped = runner.stopReason ?? 'stopped';
    result.attempts.sort((x, y) => x.attempt - y.attempt);
    result.spent = result.attempts.reduce((s, a) => s + a.spent, 0);
    result.mean = result.attempts.length ? result.attempts.reduce((s, a) => s + a.score, 0) / result.attempts.length : null;
    result.dropped = takeover ? [...takeover.dropped] : [];
    result.unknownModels = [...unknown];
    return result;
  } finally {
    await runner.close();
    await takeover?.close();
  }
}

/** Keeps a model's scores on a task, replacing what it scored there before. */
export function keepScores(store: Store, target: ModelTarget, score: TaskScore, session: string): void {
  if (!score.attempts.length) return;
  const at = Date.now();
  store.replaceTaskScores(
    target.model,
    target.scoreBase,
    score.task,
    score.attempts.map((a) => ({ attempt: a.attempt, runId: a.runId, score: a.score, checks: a.checks.map((c) => ({ label: c.check, ok: c.pass, detail: c.detail })), spent: a.spent, via: score.via, session, at })),
  );
}
