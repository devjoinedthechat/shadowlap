import { canonicalize } from './canonical.js';
import { responseInfo } from './conversations.js';
import { sha256 } from './ids.js';
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

/** A tool's declared effect, or null when nothing says. */
export type EffectOf = (tool: string) => Effect | null;

/** The reserved scope of judge calls: never the agent's behaviour. */
const RESERVED_SCOPE = /^shadowlap:/;

/** Stop reasons that mean the answer was cut at the token limit, whatever the provider calls it. */
const TOKEN_LIMIT = new Set(['max_tokens', 'length', 'MAX_TOKENS', 'max_output_tokens', 'model_context_window_exceeded']);

function agentModelCalls(calls: readonly CallRecord[]): CallRecord[] {
  return [...calls]
    .filter((c) => c.kind === 'api' && !(typeof c.meta.scope === 'string' && RESERVED_SCOPE.test(c.meta.scope)))
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
  const stop = last.end.meta.stopReason;
  if (typeof stop === 'string' && TOKEN_LIMIT.has(stop)) return 'token-limit';
  return responseInfo(store, last).tools.length ? 'tool-call' : 'answered';
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
