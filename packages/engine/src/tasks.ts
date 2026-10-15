import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { PACK_FORMAT, PACK_VERSION } from './pack.js';
import { PACK_LIMITS, PackError, validateCall, validateRun } from './pack-schema.js';
import { safeLine } from './text.js';
import type { CallRecord, RunRecord, Usage } from './types.js';

/**
 * Goldens as tasks. A golden with outcome checks already says what a good run does; as a task, a
 * model under test takes over at one model call, everything before it replays from the recording
 * for free, and the checks score what the model did from there. Each task has, next to its `expect`
 * in shadowlap.config.json, the call where the model takes over, why that call, and what the task
 * rewards:
 *
 *   "tests": {
 *     "goldens/refund-over-limit": {
 *       "expect": { "tools": { "issue_refund": 0, "escalate": 1 } },
 *       "task": { "takeover": 17, "why": "decides between refunding and escalating", "rewards": "escalate above the limit" }
 *     }
 *   }
 *
 * All three are optional. The takeover defaults to the call blame found when the golden came from a
 * blamed run (the decision the run turned on), else the first model call after the last recorded
 * input (the agent's answer to the last thing a person said), else the first model call. What a task
 * rewards defaults to its outcome checks.
 */

export interface TaskFields {
  /** The model call where the model under test takes over, by its number in the golden's run. */
  takeover?: number;
  /** Why that call, in a few words. */
  why?: string;
  /** The behaviour a passing attempt shows, in a few words: `escalate above the limit`. */
  rewards?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The `task` object of a tests entry, checked; `where` names it in errors. */
export function parseTaskFields(raw: unknown, where: string): TaskFields {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new Error(`${where} must be an object with "takeover", "why" and "rewards"`);
  for (const key of Object.keys(raw)) if (!['takeover', 'why', 'rewards'].includes(key)) throw new Error(`${where} has an unknown key "${key}" (expected "takeover", "why", "rewards")`);
  const out: TaskFields = {};
  if (raw.takeover !== undefined) {
    if (typeof raw.takeover !== 'number' || !Number.isSafeInteger(raw.takeover) || raw.takeover < 1) throw new Error(`${where}.takeover must be a model call number, such as 17`);
    out.takeover = raw.takeover;
  }
  for (const key of ['why', 'rewards'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim() || v.length > 200 || CONTROL.test(v)) throw new Error(`${where}.${key} must be a short line of text (at most 200 characters)`);
    out[key] = v.trim();
  }
  return out;
}

// ---- goldens ----

export interface Golden {
  /** The directory as the project names it, relative to the config file: `goldens/refund-over-limit`. */
  path: string;
  dir: string;
  /** The golden's run: the last run in the pack, the one `shadowlap test` replays. */
  run: RunRecord;
  /** Runs packed before it (`pack --lineage`), root first. */
  lineage: RunRecord[];
  /** The golden run's calls. */
  calls: CallRecord[];
}

function readPackFile(path: string, limit: number, what: string): Buffer {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new PackError(`${what} is not a regular file`);
  if (st.size > limit) throw new PackError(`${what} is ${st.size} bytes, over the ${limit}-byte limit`);
  return readFileSync(path);
}

/** Whether a directory holds a pack. */
export function isPack(dir: string): boolean {
  try {
    return lstatSync(join(dir, 'run.json')).isFile();
  } catch {
    return false;
  }
}

/**
 * A golden's pack, read without importing it: what a task needs to know before anything runs. The
 * pack is untrusted like any other, so its records are validated as `unpack` validates them.
 */
export function readGolden(dir: string, path = dir): Golden {
  const root = resolve(dir);
  if (!isPack(root)) throw new PackError(`${path} is not a Shadowlap pack (no run.json)`);
  let manifest: { format?: unknown; version?: unknown; runs?: unknown };
  try {
    manifest = JSON.parse(readPackFile(join(root, 'run.json'), PACK_LIMITS.manifestBytes, 'run.json').toString('utf8')) as typeof manifest;
  } catch (err) {
    if (err instanceof PackError) throw err;
    throw new PackError(`${path}: run.json is not valid JSON`);
  }
  if (manifest.format !== PACK_FORMAT || manifest.version !== PACK_VERSION) throw new PackError(`${path}: not a pack this build reads`);
  if (!Array.isArray(manifest.runs) || !manifest.runs.length || manifest.runs.length > PACK_LIMITS.runs) throw new PackError(`${path}: run.json lists no runs`);
  const runs = manifest.runs.map((r, i) => validateRun(r, `${path}: run.json runs[${i}]`));
  const run = runs.at(-1)!;
  const calls: CallRecord[] = [];
  const callsPath = join(root, 'calls.jsonl');
  if (existsSync(callsPath)) {
    const lines = readPackFile(callsPath, PACK_LIMITS.callsBytes, 'calls.jsonl').toString('utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes(run.runId)) return; // another run's call: not needed, and not worth parsing
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new PackError(`${path}: calls.jsonl line ${i + 1} is not valid JSON`);
      }
      const call = validateCall(parsed, `${path}: calls.jsonl line ${i + 1}`);
      if (call.runId === run.runId) calls.push(call);
    });
  }
  calls.sort((a, b) => a.callNo - b.callNo);
  return { path, dir: root, run, lineage: runs.slice(0, -1), calls };
}

/** A path as the project writes it: relative to its root, forward slashes, no trailing slash. */
export function projectPath(root: string, dir: string): string {
  const rel = relative(resolve(root), resolve(root, dir)) || '.';
  return rel.split(sep).join('/');
}

function matches(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\\\/]*')}$`);
  return re.test(name);
}

/**
 * The tests entry that applies to a golden, as `shadowlap test` picks it: an exact path wins over a
 * pattern, and `*` matches within the last part of a path only. Null when none applies.
 */
export function entryFor(root: string, entries: readonly string[], golden: string): string | null {
  const target = resolve(root, golden).replace(/[\\/]+$/, '');
  let pattern: string | null = null;
  for (const e of entries) {
    const full = resolve(root, e).replace(/[\\/]+$/, '');
    if (!full.includes('*')) {
      if (full === target) return e;
      continue;
    }
    const cut = full.lastIndexOf(sep);
    if (!pattern && target.slice(0, target.lastIndexOf(sep)) === full.slice(0, cut) && matches(full.slice(cut + 1), target.slice(target.lastIndexOf(sep) + 1))) pattern = e;
  }
  return pattern;
}

/**
 * Every golden of a project: each pack under `goldens/`, each directory a tests entry names, and
 * each pack a pattern entry matches, by path. An entry naming a directory with no pack is kept, as a
 * golden that is gone.
 */
export function goldenPaths(root: string, entries: readonly string[]): Array<{ path: string; exists: boolean }> {
  const found = new Map<string, boolean>();
  const scan = (dir: string, pattern: string) => {
    let names: string[];
    try {
      names = readdirSync(resolve(root, dir));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!matches(pattern, name)) continue;
      const path = projectPath(root, join(dir, name));
      if (isPack(resolve(root, path))) found.set(path, true);
    }
  };
  scan('goldens', '*');
  for (const e of entries) {
    const clean = e.replace(/[\\/]+$/, '');
    if (clean.includes('*')) {
      const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
      scan(cut < 0 ? '.' : clean.slice(0, cut), clean.slice(cut + 1));
    } else {
      const path = projectPath(root, clean);
      found.set(path, isPack(resolve(root, path)));
    }
  }
  return [...found.entries()].map(([path, exists]) => ({ path, exists })).sort((a, b) => a.path.localeCompare(b.path));
}

// ---- tasks ----

export interface TaskCheck {
  label: string;
  /** A token or cost budget: it caps what a run spends, not what it does, so it doesn't score a model. */
  cap: boolean;
}

export type TaskStatus = 'ready' | 'blocked' | 'not-a-task' | 'no-golden';

export interface Takeover {
  callNo: number;
  why: string;
  /** Where the call came from: the config, blame, the last recorded input, or the first model call. */
  from: 'config' | 'blame' | 'input' | 'first';
}

export interface Task {
  /** The golden, as the project names it: `goldens/refund-over-limit`. */
  golden: string;
  /** Its last path segment: `refund-over-limit`. */
  name: string;
  status: TaskStatus;
  /** Why it isn't ready, in a few words. */
  note: string | null;
  /** The golden's run. */
  runId: string | null;
  takeover: Takeover | null;
  /** What a passing attempt does. */
  rewards: string | null;
  /** The golden's checks; caps are listed, but only the others score an attempt. */
  checks: TaskCheck[];
  /** Tools the recording called after the takeover: reads run live there (or replay with `--reads replay`), writes are stubbed. */
  after: { live: string[]; stubbed: string[] };
  /** Calls before the takeover, replayed from the recording for free. */
  prefix: number;
  /** The model and provider the recording asked at the takeover, and the call's endpoint. */
  model: string | null;
  provider: string | null;
  callName: string | null;
  /** What the recording's model calls used from the takeover on: a model's price per attempt is estimated from it. */
  tokensAfter: Usage | null;
}

export interface TaskInput {
  path: string;
  /** The golden's pack, or null when the directory has none. */
  golden: Golden | null;
  fields: TaskFields;
  /** The checks of its tests entry; none without one. */
  checks: TaskCheck[];
  /** Whether the golden's test fails: true, false, or null when that isn't known. */
  testFailed: boolean | null;
  /** The runs a golden came from, newest first, when the store has them and the pack doesn't. */
  ancestors?: RunRecord[];
}

/**
 * A call that records a person's input: E19 records what an interactive agent reads from a person as
 * a `read` tool named `user_input` (or marks it in the call's meta). The takeover defaults to the
 * model call that answers the last one.
 */
export function isRecordedInput(call: Pick<CallRecord, 'kind' | 'name' | 'meta'>): boolean {
  return call.kind === 'tool' && (call.name === 'user_input' || call.meta.input === true || call.meta.userInput === true);
}

function runName(run: RunRecord): string {
  return safeLine(run.meta?.labels?.[0] ?? run.runId.slice(0, 10));
}

function modelCalls(calls: readonly CallRecord[]): CallRecord[] {
  return calls.filter((c) => c.kind === 'api' && c.end?.outcome === 'ok');
}

/** Where a model takes over when the config doesn't say. */
export function defaultTakeover(golden: Golden, ancestors: readonly RunRecord[] = []): Takeover | null {
  const models = modelCalls(golden.calls);
  if (!models.length) return null;
  // The run the golden came from, or the golden itself, was blamed: the call it was lost at is the decision.
  const nearestFirst = [golden.run, ...[...golden.lineage].reverse(), ...ancestors];
  for (const run of nearestFirst) {
    const b = run.meta?.blame;
    const at = b?.callNo;
    if (b?.outcome === 'blamed' && typeof at === 'number' && Number.isSafeInteger(at) && models.some((c) => c.callNo === at)) return { callNo: at, why: `where ${runName(run)} was lost`, from: 'blame' };
  }
  const lastInput = golden.calls.filter(isRecordedInput).at(-1);
  if (lastInput) {
    const next = models.find((c) => c.callNo > lastInput.callNo);
    if (next) return { callNo: next.callNo, why: 'the first model call after the last input', from: 'input' };
  }
  return { callNo: models[0]!.callNo, why: 'the first model call: the model plays the whole run', from: 'first' };
}

function usageFrom(calls: readonly CallRecord[], from: number): Usage | null {
  const u: Required<Usage> = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let any = false;
  for (const c of calls) {
    const x = c.kind === 'api' && c.callNo >= from ? c.end?.meta.usage : undefined;
    if (!x) continue;
    any = true;
    u.inputTokens += x.inputTokens ?? 0;
    u.outputTokens += x.outputTokens ?? 0;
    u.cacheReadInputTokens += x.cacheReadInputTokens ?? 0;
    u.cacheCreationInputTokens += x.cacheCreationInputTokens ?? 0;
  }
  return any ? u : null;
}

const uniq = (xs: string[]) => [...new Set(xs)];

/** A golden as a task: where a model takes over, why, what it rewards, and whether it can be scored. */
export function describeTask(input: TaskInput): Task {
  const { golden, fields, checks } = input;
  const name = input.path.split('/').at(-1) ?? input.path;
  const base: Task = { golden: input.path, name, status: 'ready', note: null, runId: golden?.run.runId ?? null, takeover: null, rewards: null, checks, after: { live: [], stubbed: [] }, prefix: 0, model: null, provider: null, callName: null, tokensAfter: null };
  const outcome = checks.filter((c) => !c.cap);
  base.rewards = fields.rewards ?? (outcome.length ? outcome.map((c) => c.label).join(' · ') : null);
  if (!golden) return { ...base, status: 'no-golden', note: 'the golden is gone' };

  let takeover: Takeover | null;
  if (fields.takeover !== undefined) {
    const call = golden.calls.find((c) => c.callNo === fields.takeover);
    if (!call || call.kind !== 'api') return { ...base, status: 'not-a-task', note: `#${fields.takeover} is not a model call of the golden's run` };
    takeover = { callNo: fields.takeover, why: fields.why ?? 'set in shadowlap.config.json', from: 'config' };
  } else {
    takeover = defaultTakeover(golden, input.ancestors ?? []);
    if (takeover && fields.why) takeover = { ...takeover, why: fields.why };
  }
  if (!takeover) return { ...base, status: 'not-a-task', note: "the golden's run made no model calls" };

  const k = takeover.callNo;
  const call = golden.calls.find((c) => c.callNo === k)!;
  const after = golden.calls.filter((c) => c.kind === 'tool' && c.callNo > k);
  const model = call.end?.meta.model ?? call.meta.model;
  const provider = call.end?.meta.provider ?? call.meta.provider;
  const task: Task = {
    ...base,
    takeover,
    after: { live: uniq(after.filter((c) => c.effect === 'read').map((c) => c.name)), stubbed: uniq(after.filter((c) => c.effect === 'write').map((c) => c.name)) },
    prefix: golden.calls.filter((c) => c.callNo < k).length,
    model: typeof model === 'string' ? model : null,
    provider: typeof provider === 'string' ? provider : null,
    callName: call.name,
    tokensAfter: usageFrom(golden.calls, k),
  };
  if (!outcome.length) return { ...task, status: 'not-a-task', note: checks.length ? 'its checks only cap tokens and cost' : 'it has no checks' };
  if (input.testFailed === true) return { ...task, status: 'blocked', note: 'its test fails' };
  return task;
}

export interface OneSided {
  /** What every ready task rewards. */
  rewards: string;
  /** The ready tasks, by golden. */
  tasks: string[];
  /** A task that rewards something else but isn't ready: making it ready evens the set out. */
  opposite: { golden: string; rewards: string; status: TaskStatus; note: string | null } | null;
}

/**
 * Tasks that all reward the same behaviour can be passed by a model that does only that: a model
 * trained to escalate every refund scores full marks on tasks that all reward escalating.
 */
export function oneSided(tasks: readonly Task[]): OneSided | null {
  const ready = tasks.filter((t) => t.status === 'ready');
  const kinds = uniq(ready.map((t) => t.rewards ?? ''));
  if (!ready.length || kinds.length !== 1 || !kinds[0]) return null;
  const other = tasks.find((t) => t.status !== 'ready' && t.rewards && t.rewards !== kinds[0]);
  return { rewards: kinds[0], tasks: ready.map((t) => t.golden), opposite: other ? { golden: other.golden, rewards: other.rewards!, status: other.status, note: other.note } : null };
}

/** The model calls' usage averaged over tasks: what one attempt is expected to use after its takeover. */
export function averageTokens(tasks: readonly Task[]): Usage | null {
  const used = tasks.map((t) => t.tokensAfter).filter((u): u is Usage => u !== null);
  if (!used.length) return null;
  const avg = (pick: (u: Usage) => number | undefined) => Math.round(used.reduce((s, u) => s + (pick(u) ?? 0), 0) / used.length);
  return { inputTokens: avg((u) => u.inputTokens), outputTokens: avg((u) => u.outputTokens), cacheReadInputTokens: avg((u) => u.cacheReadInputTokens), cacheCreationInputTokens: avg((u) => u.cacheCreationInputTokens) };
}

/** The score of one attempt: the share of its checks that passed. */
export function attemptScore(results: ReadonlyArray<{ ok: boolean }>): number {
  return results.length ? results.filter((r) => r.ok).length / results.length : 0;
}

/** The task a golden name or path refers to: `refund-over-limit` or `goldens/refund-over-limit`. */
export function findTask<T extends Pick<Task, 'golden' | 'name'>>(tasks: readonly T[], name: string): T | null {
  const clean = name.replace(/[\\/]+$/, '');
  return tasks.find((t) => t.golden === clean) ?? tasks.find((t) => t.name === clean) ?? tasks.find((t) => basename(t.golden) === basename(clean)) ?? null;
}
