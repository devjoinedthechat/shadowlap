import { basename } from 'node:path';
import { canonicalize } from './canonical.js';
import { runKind } from './classify.js';
import { normalizeConversation } from './conversation.js';
import { responseInfo } from './conversations.js';
import type { EffectOf } from './decisions.js';
import { sha256 } from './ids.js';
import { isReservedScope } from './judge-scope.js';
import { loadApiRequest } from './manifest.js';
import { commandIsImported, hasRecordedCommand } from './pack.js';
import { normalizeResponse } from './responses.js';
import type { Store } from './store.js';
import type { CallRecord, Effect, RunRecord } from './types.js';

/**
 * Production coverage: what imported runs (captures and traces) did, grouped by behaviour, and
 * which of those behaviours a golden covers. A behaviour is three things a run did:
 *
 *   - its path: the tools the model called, in order, as `--repeat` reports paths (the calls a
 *     model turn asked for together are sorted, since their order is scheduling, not a choice);
 *   - its effects: the write tools on that path, which is what the run did to the world;
 *   - its outcome: how it ended (an answer, a failed model call, the token limit, a tool call
 *     nothing answered, or the agent failing).
 *
 * The path is read from the model's own answers (the tool calls each response asked for), not from
 * recorded tool calls: a capture of the network holds no tool calls, and a golden's model answers
 * say the same thing its tool calls do, so both are read the same way and compare. Arguments are
 * not part of a behaviour, as they are not part of a path.
 */

/** How a run ended, from its last model call and, for a recording, the agent's exit. */
export type BehaviourOutcome = 'answered' | 'model-error' | 'token-limit' | 'tool-call' | 'agent-error' | 'no-model-calls';

/** Each outcome as the report says it. */
export const OUTCOME_WORDS: Readonly<Record<BehaviourOutcome, string>> = {
  answered: 'answered',
  'model-error': 'a model call failed',
  'token-limit': 'stopped at the token limit',
  'tool-call': 'ended on a tool call',
  'agent-error': 'the agent failed',
  'no-model-calls': 'no model calls',
};

export interface Behaviour {
  /** The tools the model called, in order; a model turn's calls sorted. */
  path: string[];
  /** The write tools on the path, each once, in the order first called. A tool of unknown effect counts as one. */
  writes: string[];
  /** Tools on the path whose effect nothing recorded or configured names: counted as writes. */
  unknown: string[];
  outcome: BehaviourOutcome;
}


/** Stop reasons that mean the answer was cut at the token limit, whatever the provider calls it. */
const TOKEN_LIMIT = new Set(['max_tokens', 'length', 'MAX_TOKENS', 'max_output_tokens', 'model_context_window_exceeded']);

function agentModelCalls(calls: readonly CallRecord[]): CallRecord[] {
  return [...calls]
    // Shadowlap's own calls (its judge's) are never the agent's behaviour.
    .filter((c) => c.kind === 'api' && !isReservedScope(c.meta.scope))
    .sort((a, b) => a.callNo - b.callNo);
}

/**
 * What a run did, read from its model calls: each answer's tool calls make the path, the effects
 * say which of them write, and the last model call (and, for a recording, the agent's exit) says
 * how it ended.
 */
export function runBehaviour(store: Store, run: Pick<RunRecord, 'status'>, calls: readonly CallRecord[], effectOf: EffectOf): Behaviour {
  const api = agentModelCalls(calls);
  const path: string[] = [];
  for (const c of api) {
    if (c.end?.outcome !== 'ok') continue;
    path.push(...responseInfo(store, c).tools.map((t) => t.name).sort());
  }
  const writes: string[] = [];
  const unknown: string[] = [];
  for (const name of path) {
    const effect = effectOf(name);
    if (effect === null && !unknown.includes(name)) unknown.push(name);
    if ((effect === 'write' || effect === null) && !writes.includes(name)) writes.push(name);
  }
  return { path, writes, unknown, outcome: outcomeOf(store, run, api) };
}

function outcomeOf(store: Store, run: Pick<RunRecord, 'status'>, api: readonly CallRecord[]): BehaviourOutcome {
  if (run.status === 'failed' || run.status === 'crashed') return 'agent-error';
  const last = api.at(-1);
  if (!last) return 'no-model-calls';
  if (!last.end || last.end.outcome !== 'ok') return 'model-error';
  const stop = typeof last.end.meta.stopReason === 'string' ? last.end.meta.stopReason : stopReasonOf(store, last);
  if (stop !== null && TOKEN_LIMIT.has(stop)) return 'token-limit';
  return responseInfo(store, last).tools.length ? 'tool-call' : 'answered';
}

/** A model call's stop reason as its response says it, for a call recorded without one in its metadata. */
function stopReasonOf(store: Store, call: CallRecord): string | null {
  const end = call.end;
  if (!end?.responseRef) return null;
  try {
    const provider = end.meta.provider ?? call.meta.provider;
    return normalizeResponse(store.getBlob(end.responseRef), end.meta.headers?.['content-type'], end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined).stopReason;
  } catch {
    return null;
  }
}

/** What groups runs: the path, the writes and the outcome. `unknown` follows from the effects known when it was read. */
export function behaviourKey(b: Pick<Behaviour, 'path' | 'writes' | 'outcome'>): string {
  return sha256(canonicalize({ path: b.path, writes: b.writes, outcome: b.outcome })).slice(0, 16);
}

/** A behaviour in one line: `lookup_order → issue_refund → send_email · writes issue_refund, send_email · answered`. */
export function describeBehaviour(b: Behaviour, o: { arrow?: string } = {}): string {
  const path = b.path.length ? b.path.join(o.arrow ?? ' → ') : 'no tool calls';
  const writes = b.writes.length ? `writes ${b.writes.join(', ')}` : 'no writes';
  return `${path} · ${writes} · ${OUTCOME_WORDS[b.outcome]}`;
}

/** How many steps two paths share from the start. */
export function sharedSteps(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * The effects a store knows: each tool's effect as its recorded calls declare it (the SDKs and
 * `shadowlap mcp` record one with every call), with what `extra` names (the config's MCP effects,
 * a golden's own calls) filling in, and what a run being read records winning for that run. A tool
 * recorded under several effects takes the one that does the most: a write over a read over pure.
 */
export function storeEffects(store: Store, extra: ReadonlyMap<string, Effect> = new Map()): Map<string, Effect> {
  const known = new Map<string, Effect>(extra);
  for (const t of store.toolUsage()) if (t.effect) known.set(t.name, strongest(known.get(t.name), t.effect));
  return known;
}

const RANK: Readonly<Record<Effect, number>> = { pure: 0, read: 1, write: 2 };
export function strongest(a: Effect | undefined, b: Effect): Effect {
  return a === undefined || RANK[b] > RANK[a] ? b : a;
}

/** A run's own recorded effects first (a trace that kept its tool calls), then what the store knows. */
export function effectsFor(calls: readonly CallRecord[], known: ReadonlyMap<string, Effect>): EffectOf {
  const own = new Map<string, Effect>();
  for (const c of calls) if (c.kind === 'tool' && c.effect) own.set(c.name, strongest(own.get(c.name), c.effect));
  return (tool) => own.get(tool) ?? known.get(tool) ?? null;
}

// ---- groups ----

/** One imported run as coverage reads it. */
export interface CoverageMember {
  runId: string;
  startedAt: number;
  /** Where it came from (`meta.imported.from`): a file's name, or `langfuse:7f3a9c2e`. */
  source: string | null;
  behaviour: Behaviour;
}

/** A golden as coverage reads it: its name in the test history and what its recording did. */
export interface CoverageGolden {
  golden: string;
  runId: string | null;
  behaviour: Behaviour;
}

/** The golden that comes closest to a behaviour no golden has: the steps they share, and the first that differs. */
export interface NearestGolden {
  golden: string;
  /** Steps of the path both take, from the start. */
  shared: number;
  /** The first step that differs: what the group does there and what the golden does (null where its path has ended). */
  differs: { step: number; seen: string | null; golden: string | null } | null;
}

export interface CoverageGroup {
  key: string;
  behaviour: Behaviour;
  /** Imported runs that behaved so. */
  runs: number;
  /** Their ids, newest first, at most {@link GROUP_RUN_IDS}. */
  runIds: string[];
  /** Their sources, each once, newest first, at most {@link GROUP_SOURCES}. */
  sources: string[];
  firstSeen: number;
  lastSeen: number;
  /** Goldens whose recording behaves the same way. Empty: no golden covers it. */
  coveredBy: string[];
  /** For a group no golden covers: the golden that shares the most of its path, or null when none shares a step. */
  nearest: NearestGolden | null;
}

export const GROUP_RUN_IDS = 20;
export const GROUP_SOURCES = 5;

/**
 * Imported runs grouped by behaviour, each group with the goldens that cover it (or the nearest
 * one): groups no golden covers first, then by how many runs behaved so, then newest first.
 */
export function groupCoverage(members: readonly CoverageMember[], goldens: readonly CoverageGolden[]): CoverageGroup[] {
  const byKey = new Map<string, CoverageMember[]>();
  for (const m of members) {
    const key = behaviourKey(m.behaviour);
    const list = byKey.get(key);
    if (list) list.push(m);
    else byKey.set(key, [m]);
  }
  const goldenKeys = goldens.map((g) => ({ ...g, key: behaviourKey(g.behaviour) }));
  const groups: CoverageGroup[] = [...byKey.entries()].map(([key, list]) => {
    const newest = [...list].sort((a, b) => b.startedAt - a.startedAt || b.runId.localeCompare(a.runId));
    const behaviour = newest[0]!.behaviour;
    const coveredBy = goldenKeys.filter((g) => g.key === key).map((g) => g.golden).sort();
    const sources: string[] = [];
    for (const m of newest) if (m.source && !sources.includes(m.source) && sources.length < GROUP_SOURCES) sources.push(m.source);
    return {
      key,
      behaviour,
      runs: list.length,
      runIds: newest.slice(0, GROUP_RUN_IDS).map((m) => m.runId),
      sources,
      firstSeen: Math.min(...list.map((m) => m.startedAt)),
      lastSeen: Math.max(...list.map((m) => m.startedAt)),
      coveredBy,
      nearest: coveredBy.length ? null : nearestGolden(behaviour, goldens),
    };
  });
  return groups.sort((a, b) => Number(a.coveredBy.length > 0) - Number(b.coveredBy.length > 0) || b.runs - a.runs || b.lastSeen - a.lastSeen || a.key.localeCompare(b.key));
}

/** The golden whose path shares the most steps with this one, from the start; ties go to the first by name. */
export function nearestGolden(b: Behaviour, goldens: readonly CoverageGolden[]): NearestGolden | null {
  let best: NearestGolden | null = null;
  for (const g of [...goldens].sort((x, y) => x.golden.localeCompare(y.golden))) {
    const shared = sharedSteps(b.path, g.behaviour.path);
    if (shared === 0 || (best && shared <= best.shared)) continue;
    const same = shared === b.path.length && shared === g.behaviour.path.length;
    best = { golden: g.golden, shared, differs: same ? null : { step: shared + 1, seen: b.path[shared] ?? null, golden: g.behaviour.path[shared] ?? null } };
  }
  return best;
}

/** A short name for a behaviour, for the golden `--pack` writes: its first tool and its writes, then its key. */
export function behaviourSlug(b: Behaviour, key: string): string {
  const words = [...new Set([b.path[0], ...b.writes].filter((x): x is string => !!x))].slice(0, 3);
  const slug = words
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/, '');
  return `${slug || (b.outcome === 'answered' ? 'answer' : b.outcome)}-${key.slice(0, 6)}`;
}

// ---- the command that reproduces a capture ----

/** A command that reproduces a capture: the agent's argv, and the recording that says so. */
export interface InferredCommand {
  argv: string[];
  from: string;
}

/**
 * What finds the command that reproduces a capture when none is given: the command of this
 * project's newest run whose first model call sent the capture's first request, by its fingerprint
 * (the request under the normalizers, so a per-run value a normalizer masks doesn't stand in the
 * way) or byte for byte, as its own run (never a command that came from a pack or the team store,
 * which someone else chose, nor a capture's, which has none). The store is read once, on the first
 * capture asked about: every run's first model call, in one pass.
 */
export function commandFinder(store: Store): (capture: RunRecord) => InferredCommand | null {
  let index: { byFingerprint: Map<string, string[]>; byRef: Map<string, string[]> } | null = null;
  const read = () => {
    // SQLite returns the other columns of the row MIN() picked: each run's first model call.
    const rows = store.query(
      `SELECT e.run_id AS run_id, MIN(e.call_no) AS call_no, e.fingerprint AS fp, e.request_ref AS ref, r.started_at AS at
       FROM call_events e JOIN runs r ON r.run_id = e.run_id
       WHERE e.phase = 'start' AND e.kind = 'api' AND r.status <> 'running'
       GROUP BY e.run_id`,
    );
    rows.sort((a, b) => Number(b.at) - Number(a.at) || String(b.run_id).localeCompare(String(a.run_id)));
    const byFingerprint = new Map<string, string[]>();
    const byRef = new Map<string, string[]>();
    const add = (map: Map<string, string[]>, key: unknown, id: string) => {
      if (typeof key !== 'string' || !key) return;
      const list = map.get(key);
      if (list) list.push(id);
      else map.set(key, [id]);
    };
    for (const row of rows) {
      add(byFingerprint, row.fp, String(row.run_id));
      add(byRef, row.ref, String(row.run_id));
    }
    return { byFingerprint, byRef };
  };
  return (capture) => {
    const first = store.getCalls(capture.runId).find((c) => c.kind === 'api');
    if (!first) return null;
    index ??= read();
    const ids = [...(index.byFingerprint.get(first.fingerprint) ?? []), ...(first.requestRef ? (index.byRef.get(first.requestRef) ?? []) : [])];
    const tried = new Set<string>();
    for (const id of ids) {
      if (id === capture.runId || tried.has(id)) continue;
      tried.add(id);
      const run = store.getRun(id);
      if (!run || !hasRecordedCommand(run) || commandIsImported(run) || runKind(run) === 'capture') continue;
      return { argv: run.command.argv, from: run.runId };
    }
    return null;
  };
}

/** The command that reproduces one capture ({@link commandFinder}), or null when no run here says it. */
export function inferCommand(store: Store, capture: RunRecord): InferredCommand | null {
  return commandFinder(store)(capture);
}

/**
 * The first message of a run: the text of the first user turn its first model call sent, which is
 * where an agent's input shows (the question asked, the order it was given). What a command's
 * `{message}` stands for when `coverage --pack` starts the agent for a capture. Null when the run's
 * first model call holds no user text.
 */
export function firstMessage(store: Store, runId: string): string | null {
  const first = store.getCalls(runId).find((c) => c.kind === 'api' && c.requestRef);
  if (!first?.requestRef) return null;
  try {
    return requestMessage(loadApiRequest(store, first.requestRef), typeof first.meta.model === 'string' ? first.meta.model : null);
  } catch {
    return null;
  }
}

/** The text of a request's first user turn, or null. */
export function requestMessage(body: unknown, model: string | null = null): string | null {
  const turn = normalizeConversation(body, model)?.turns.find((t) => t.role === 'user');
  const text = (turn?.blocks ?? []).filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n');
  return text ? text : null;
}

// ---- the command, per capture: `{message}` ----

/** `{message}`, or `{message:/<pattern>/<flags>}`: the pattern as a JavaScript regex literal writes it. */
const PLACEHOLDER = /\{message(?::\/((?:\\.|[^\\/\n])+)\/([imsu]*))?\}/g;

/** Programs that run their arguments as code: a message must never become a script. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
/**
 * The flags after which an interpreter runs, or loads, the next argument as code (`node -e`,
 * `python -c`, `python -m`, `node --require`): among the flags before the script, they are code.
 */
const CODE_FLAGS = new Set(['-c', '-e', '--eval', '-p', '--print', '-command', '/c', '-x', '-r', '-m', '--require', '--import', '--loader', '--experimental-loader']);

export function hasPlaceholder(argv: readonly string[]): boolean {
  return argv.some((a) => new RegExp(PLACEHOLDER.source).test(a));
}

/**
 * Why a command's placeholders can't be used, or null: each regex compiles, and none is where it
 * would be run as code (a shell's script; an interpreter's `-c`, `-e` or `-m` before its script).
 * The message comes from production traffic: it is only ever an argument, passed as it is.
 */
export function checkCommandTemplate(argv: readonly string[]): string | null {
  if (!hasPlaceholder(argv)) return null;
  const program = basename(argv[0] ?? '').toLowerCase();
  if (SHELLS.has(program)) return `${argv[0]!} runs its arguments as a script, and {message} is text from production: give the agent's own command, with {message} as one of its arguments`;
  // The interpreter's own flags: those before its script (the first argument that isn't a flag).
  let leading = 1;
  while (leading < argv.length && argv[leading]!.startsWith('-')) leading++;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    for (const m of arg.matchAll(PLACEHOLDER)) {
      if (i > 0 && i <= leading && CODE_FLAGS.has(argv[i - 1]!.toLowerCase())) return `{message} after ${argv[i - 1]!} would run as code: give the agent's own command, with {message} as one of its arguments`;
      if (m[1] !== undefined) {
        try {
          new RegExp(m[1], m[2]);
        } catch (err) {
          return `${m[0]}: ${(err as Error).message}`;
        }
      }
    }
  }
  return null;
}

/**
 * The command for one capture: each `{message}` replaced by its first message, each
 * `{message:/regex/}` by the part of it the regex picks (its first group, else the whole match).
 * Why not, when the capture has no first message or the regex finds nothing in it.
 */
export function fillCommand(argv: readonly string[], message: string | null): { argv: string[] } | { why: string } {
  if (!hasPlaceholder(argv)) return { argv: [...argv] };
  if (message === null) return { why: 'its first model call holds no user message for {message} to stand for' };
  const out: string[] = [];
  const missing: string[] = [];
  for (const arg of argv) {
    out.push(
      arg.replace(PLACEHOLDER, (all: string, pattern: string | undefined, flags: string | undefined) => {
        if (pattern === undefined) return message;
        const m = new RegExp(pattern, flags).exec(message);
        if (!m) missing.push(all.slice('{message:'.length, -1));
        return m ? (m[1] ?? m[0]) : all;
      }),
    );
  }
  return missing.length ? { why: `its first message has no match for ${missing[0]!}` } : { argv: out };
}
