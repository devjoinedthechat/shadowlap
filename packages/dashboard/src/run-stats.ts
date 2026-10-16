import { countOrigins, displayOrigin, estimateCost, ORIGIN_CODE, runCache, type CallRecord, type Origin, type OriginCounts, type Outcome, type Price, type SqlValue, type Store, type Usage } from '@shadowlap/engine';
import { modelResolver } from '@shadowlap/tui/data';
import { keepingIndex, loadRunIndex, type IndexedRun, type RunIndex } from './run-index.js';

/**
 * What a run's calls add up to: where each answer came from, the tokens each model used live,
 * replayed and captured, how long the replayed calls would have taken, and its live model calls'
 * use of the prompt cache under the run page's rule (the engine's `runCache`). Worked out in one
 * pass over the run's calls; the prompt cache, which reads every request to find the run's
 * conversations, only for the runs the Overview's week asks about (`cacheTotalsOf`). A finished
 * run's totals never change, so they are kept in the store (`run_stats`) and read back as one row
 * per run, in this process and the next: every run's calls are read once in the store's life, and
 * a recent run's once more for its cache. Prices are applied on reading, so changing them needs no
 * rework.
 */

/** A run's totals before prices: what `run_stats` keeps, as JSON. */
export interface CallTotals {
  /** One character per call, in call order: r replayed, l live, o overridden, i injected, f failed, b blocked, s stubbed. */
  codes: string;
  /** Tokens per model and bucket: `l` spent live, `r` replayed (not re-spent), `c` captured (an imported recording's calls). */
  models: Array<[bucket: 'l' | 'r' | 'c', model: string, input: number, output: number, cacheRead: number, cacheWrite: number]>;
  /**
   * Time not waited: for every replayed call, how long it took when it was recorded. A replayed call
   * that carries it (`meta.recordedMs`) says so itself; otherwise its recording is the parent's call,
   * or further back for a replay of a replay.
   */
  notWaitedMs: number;
  /**
   * Live model calls' use of the prompt cache (an imported recording's left out: it was live
   * elsewhere): their whole input, the part read from the cache, and the live calls where it
   * stopped hitting, with the tokens each sent again. Null without live model calls reporting usage.
   * Absent until asked for (`cacheTotalsOf`): only the Overview's week needs it, and it costs a
   * read of every request the run sent.
   */
  cache?: CacheTotals | null;
}

export interface CacheTotals {
  input: number;
  read: number;
  misses: Array<[callNo: number, scope: string | null, tokens: number]>;
}

export interface RunStats {
  calls: number;
  /** Calls per display origin (r, l, o, i, f, b, s). */
  origins: OriginCounts;
  /** Approximate USD: spent on live model calls, saved by replayed ones, and captured (an imported run's calls, paid for elsewhere). */
  spent: number;
  saved: number;
  captured: number;
  /** Models with usage but no price: their calls are not in the sums. */
  unknownModels: string[];
  notWaitedMs: number;
}

export interface StatsOptions {
  prices?: Record<string, Price>;
}

/** Bumped whenever `CallTotals` changes shape or meaning: totals kept under another format are worked out again. */
const FORMAT = 't3';

/**
 * How far back the warm-up works out the prompt cache too: the Overview's week starts at most seven
 * days and an hour back in any time zone, and a run's start never moves.
 */
const CACHE_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

/** What a run's totals were worked out from: a finished run's never change. */
const keyOf = (r: IndexedRun) => `${FORMAT}|${r.status}|${r.endedAt}|${r.calls}`;

/** The final answer of each call: its end row with the highest attempt. */
const FINAL_END = `LEFT JOIN call_events e ON e.run_id = s.run_id AND e.call_no = s.call_no AND e.phase = 'end'
  AND e.attempt = (SELECT MAX(x.attempt) FROM call_events x WHERE x.run_id = s.run_id AND x.call_no = s.call_no AND x.phase = 'end')`;

/** Every call of the runs asked for, in call order, with the few fields of its final answer the totals read (one JSON parse each). */
const CALLS_SQL = `
SELECT s.run_id AS run, s.call_no AS call, s.kind AS kind, s.origin AS origin, s.name AS name,
       CASE WHEN s.kind = 'api' THEN s.request_ref END AS req,
       s.meta ->> '$.model' AS smodel, e.outcome AS outcome,
       json_extract(e.meta, '$.model', '$.usage', '$.recordedMs', '$.replayedFrom', '$.injected', '$.latencyMs') AS j
FROM call_events s
${FINAL_END}
WHERE s.phase = 'start' AND s.run_id IN (SELECT value FROM json_each(?))
ORDER BY s.run_id, s.call_no`;

/** Each call's recorded duration and, for a replayed call that does not carry its own, the parent's call it was replayed from. */
const DURATIONS_SQL = `
SELECT s.run_id AS run, s.call_no AS call, COALESCE(e.meta ->> '$.recordedMs', e.meta ->> '$.latencyMs') AS latency,
       CASE WHEN s.origin = 'replayed' AND e.meta ->> '$.recordedMs' IS NULL THEN e.meta ->> '$.replayedFrom' END AS source
FROM call_events s
${FINAL_END}
WHERE s.phase = 'start' AND s.run_id IN (SELECT value FROM json_each(?))`;

const KEPT_SQL = `SELECT run_id AS id, key, stats FROM run_stats WHERE run_id IN (SELECT value FROM json_each(?))`;

const BATCH = 800;

function* batches<T>(items: readonly T[], size = BATCH): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

const ids = (list: readonly string[]): SqlValue => JSON.stringify(list);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

interface Kept {
  memory: Map<string, { key: string; totals: CallTotals }>;
  /**
   * Runs in progress, as one look at the store (one run index) found them: they change with every
   * call they record, but not while the store does not, so the parts of one read model that ask
   * for them again read their calls once.
   */
  running: { index: RunIndex | null; totals: Map<string, CallTotals> };
  /** Runs whose calls were read to work out their totals, for tests that check how much a read model reads. */
  runsRead: number;
  /** Runs whose calls and requests were read to work out their prompt cache. */
  cachesRead: number;
}

const kept = new WeakMap<Store, Kept>();

function keptFor(store: Store): Kept {
  let k = kept.get(store);
  if (!k) {
    k = { memory: new Map(), running: { index: null, totals: new Map() }, runsRead: 0, cachesRead: 0 };
    kept.set(store, k);
  }
  return k;
}

/** How many runs' calls this store's read models have read so far: none for a finished run whose totals were kept. */
export function runsRead(store: Store): number {
  return keptFor(store).runsRead;
}

/** How many runs' prompt cache this store's read models have worked out so far: none for a finished run whose cache was kept. */
export function cachesRead(store: Store): number {
  return keptFor(store).cachesRead;
}

const EMPTY: CallTotals = { codes: '', models: [], notWaitedMs: 0, cache: null };

/** A run's totals as `run_stats` keeps them, or null for anything else. */
function readTotals(json: unknown): CallTotals | null {
  if (typeof json !== 'string') return null;
  try {
    const t = JSON.parse(json) as Partial<CallTotals>;
    if (typeof t.codes !== 'string' || !Array.isArray(t.models)) return null;
    const models = t.models.filter((m) => Array.isArray(m) && m.length === 6 && typeof m[1] === 'string' && m.slice(2).every((x) => typeof x === 'number'));
    const out: CallTotals = { codes: t.codes, models, notWaitedMs: n(t.notWaitedMs) };
    // Absent: not worked out yet. Null: no live model call reported usage.
    const c = t.cache;
    if (c === null) out.cache = null;
    else if (c && typeof c === 'object' && Array.isArray(c.misses))
      out.cache = { input: n(c.input), read: n(c.read), misses: c.misses.filter((m) => Array.isArray(m) && m.length === 3 && typeof m[0] === 'number' && typeof m[2] === 'number').map((m) => [m[0], typeof m[1] === 'string' ? m[1] : null, m[2]]) };
    return out;
  } catch {
    return null;
  }
}

/**
 * The totals of `runs`: from memory, from the store, or worked out from their calls (and then kept,
 * for a finished run).
 */
export function callTotals(store: Store, index: RunIndex, runs: Iterable<IndexedRun>): Map<string, CallTotals> {
  const k = keptFor(store);
  const out = new Map<string, CallTotals>();
  const unknown: IndexedRun[] = [];
  if (k.running.index !== index) k.running = { index, totals: new Map() };
  for (const r of runs) {
    if (out.has(r.runId)) continue;
    const hit = r.status === 'running' ? { key: keyOf(r), totals: k.running.totals.get(r.runId) } : k.memory.get(r.runId);
    if (hit?.totals && hit.key === keyOf(r)) out.set(r.runId, hit.totals);
    else if (r.calls === 0) out.set(r.runId, EMPTY);
    else unknown.push(r);
  }
  if (!unknown.length) return out;

  // Kept in the store by an earlier read, here or in another process.
  const finished = unknown.filter((r) => r.status !== 'running');
  const found = new Set<string>();
  for (const batch of batches(finished.map((r) => r.runId))) {
    for (const row of store.query(KEPT_SQL, ids(batch))) {
      const run = index.byId.get(String(row.id));
      const totals = run && row.key === keyOf(run) ? readTotals(row.stats) : null;
      if (!run || !totals) continue;
      out.set(run.runId, totals);
      remember(k, run, totals);
      found.add(run.runId);
    }
  }
  const todo = unknown.filter((r) => !found.has(r.runId));
  if (!todo.length) return out;

  const fresh = sumCalls(store, index, todo);
  k.runsRead += todo.length;
  const keep: Array<{ runId: string; key: string; stats: string }> = [];
  for (const r of todo) {
    const totals = fresh.get(r.runId) ?? EMPTY;
    out.set(r.runId, totals);
    if (r.status === 'running') {
      k.running.totals.set(r.runId, totals);
      continue;
    }
    remember(k, r, totals);
    keep.push({ runId: r.runId, key: keyOf(r), stats: JSON.stringify(totals) });
  }
  // A store that can't be written just now keeps them in memory only. Keeping them changes no run,
  // so the run index read before stays current.
  if (keep.length) keepingIndex(store, () => store.saveRunStats(keep));
  return out;
}

/**
 * The prompt cache part of these runs' totals (`CallTotals.cache`): kept with the rest once worked
 * out, and worked out now (and kept, for a finished run) where it is not known yet. The Overview
 * asks for the week's runs; nothing else needs it.
 */
export function cacheTotalsOf(store: Store, index: RunIndex, runs: readonly IndexedRun[]): Map<string, CacheTotals | null> {
  const k = keptFor(store);
  const totals = callTotals(store, index, runs);
  const out = new Map<string, CacheTotals | null>();
  const keep: Array<{ runId: string; key: string; stats: string }> = [];
  for (const r of runs) {
    const t = totals.get(r.runId);
    if (!t) continue;
    if (t.cache === undefined) {
      // The totals in memory are this object: the next ask finds the cache in them.
      t.cache = cacheTotals(store, r.runId);
      k.cachesRead++;
      if (r.status !== 'running') keep.push({ runId: r.runId, key: keyOf(r), stats: JSON.stringify(t) });
    }
    out.set(r.runId, t.cache);
  }
  if (keep.length) keepingIndex(store, () => store.saveRunStats(keep));
  return out;
}

const warming = new WeakMap<Store, { index: RunIndex; next: number }>();

/** A batch of the warm-up stops at this many runs, or at this much work: calls, a recent run's counted four times for its cache. */
const WARM_RUNS = 50;
const WARM_COST = 2000;

/**
 * Works out and keeps the totals of finished runs whose totals are not known yet, newest first, for
 * about `budgetMs` (50 unless asked) per call, and for runs of the last eight days their prompt
 * cache too. A dashboard calls it when it starts and while it is idle, a slice at a time, so the
 * first look at the Overview or the Runs page reads kept totals instead of every call of every run.
 * A slice stops at the first batch that ends past the budget; batches are cut by the calls they
 * read, so a slice ends close to it. True once it has been through every run in the store.
 */
export function warmRunStats(store: Store, options: { budgetMs?: number; now?: number } = {}): boolean {
  const budget = options.budgetMs ?? 50;
  const started = performance.now();
  const recent = (options.now ?? Date.now()) - CACHE_AHEAD_MS;
  const index = loadRunIndex(store);
  const k = keptFor(store);
  let w = warming.get(store);
  // Runs came or went since the last slice: go through the new list (what is known is skipped fast).
  if (!w || w.index !== index) warming.set(store, (w = { index, next: 0 }));
  while (w.next < index.runs.length) {
    const batch: IndexedRun[] = [];
    const caches: IndexedRun[] = [];
    let cost = 0;
    while (w.next < index.runs.length && batch.length < WARM_RUNS && cost < WARM_COST) {
      const r = index.runs[w.next++]!;
      if (r.status === 'running' || r.calls === 0) continue;
      const known = k.memory.get(r.runId);
      const cache = r.startedAt >= recent && !(r.meta.imported && r.mode === 'record');
      if (known?.key === keyOf(r) && (!cache || known.totals.cache !== undefined)) continue;
      batch.push(r);
      if (cache) caches.push(r);
      cost += cache ? r.calls * 4 : r.calls;
    }
    if (batch.length) callTotals(store, index, batch);
    if (caches.length) cacheTotalsOf(store, index, caches);
    // At least one batch a call, however small the budget.
    if (w.next < index.runs.length && performance.now() - started >= budget) return false;
  }
  return true;
}

function remember(k: Kept, r: IndexedRun, totals: CallTotals): void {
  if (k.memory.size > 50_000) k.memory.clear();
  k.memory.set(r.runId, { key: keyOf(r), totals });
}

interface Building {
  codes: string[];
  models: Map<string, [bucket: 'l' | 'r' | 'c', model: string, input: number, output: number, cacheRead: number, cacheWrite: number]>;
  notWaitedMs: number;
  /** Replayed calls that don't carry their recorded duration: the parent's calls they came from. */
  sources: number[];
  /** A live model call reported usage: the run's cache use is worked out from its conversations. */
  liveUsage: boolean;
}

/** One pass over the calls of `runs`, in call order. */
function sumCalls(store: Store, index: RunIndex, runs: readonly IndexedRun[]): Map<string, CallTotals> {
  const building = new Map<string, Building>();
  // The runs whose calls a replayed call may point back to: kept while reading, so a parent read in
  // this pass is not read again for its replays' durations.
  const parents = new Set(runs.map((r) => r.parentRunId).filter((p): p is string => !!p));
  const durations = new Map<string, Map<number, { latency: number; source: number | null }>>();
  const resolve = modelResolver(store);

  for (const batch of batches(runs.map((r) => r.runId))) {
    for (const row of store.query(CALLS_SQL, ids(batch))) {
      const runId = String(row.run);
      const run = index.byId.get(runId);
      if (!run) continue;
      let b = building.get(runId);
      if (!b) {
        b = { codes: [], models: new Map(), notWaitedMs: 0, sources: [], liveUsage: false };
        building.set(runId, b);
      }
      const origin = row.origin as Origin;
      const outcome = (row.outcome ?? null) as Outcome | null;
      const j = typeof row.j === 'string' ? (JSON.parse(row.j) as [unknown, unknown, unknown, unknown, unknown, unknown]) : null;
      const injected = outcome === 'error' && j?.[4] === true;
      b.codes.push(ORIGIN_CODE[displayOrigin(origin, outcome === null ? null : { outcome, injected })]);

      const recordedMs = j && typeof j[2] === 'number' ? j[2] : null;
      const replayedFrom = j ? int(j[3]) : null;
      if (origin === 'replayed') {
        if (recordedMs !== null) b.notWaitedMs += recordedMs;
        else if (replayedFrom !== null) b.sources.push(replayedFrom);
      }
      if (parents.has(runId)) {
        let table = durations.get(runId);
        if (!table) durations.set(runId, (table = new Map()));
        table.set(Number(row.call), { latency: recordedMs ?? n(j?.[5]), source: origin === 'replayed' && recordedMs === null ? replayedFrom : null });
      }

      const usage = j && typeof j[1] === 'object' && j[1] !== null ? (j[1] as Partial<Usage>) : null;
      if (row.kind !== 'api' || !usage) continue;
      const input = n(usage.inputTokens);
      const cacheRead = n(usage.cacheReadInputTokens);
      const cacheWrite = n(usage.cacheCreationInputTokens);
      const imported = !!run.meta.imported && run.mode === 'record';
      if (origin === 'live' && !imported) b.liveUsage = true;
      const bucket = origin === 'replayed' ? 'r' : origin === 'live' ? (imported ? 'c' : 'l') : null;
      if (!bucket) continue;
      // Recorded before the model was kept per call: the request says which.
      const model =
        (typeof j?.[0] === 'string' ? j[0] : null) ??
        (typeof row.smodel === 'string' ? row.smodel : null) ??
        (typeof row.req === 'string' ? resolve({ kind: 'api', requestRef: row.req, name: String(row.name) } as CallRecord) : null);
      if (!model) continue;
      const key = `${bucket}\u0000${model}`;
      const m = b.models.get(key) ?? [bucket, model, 0, 0, 0, 0];
      m[2] += input;
      m[3] += n(usage.outputTokens);
      m[4] += cacheRead;
      m[5] += cacheWrite;
      b.models.set(key, m);
    }
  }

  const of = recordedDurations(store, index, durations, runs.filter((r) => building.get(r.runId)?.sources.length).map((r) => r.parentRunId));
  const out = new Map<string, CallTotals>();
  for (const r of runs) {
    const b = building.get(r.runId);
    if (!b) continue;
    let notWaitedMs = b.notWaitedMs;
    for (const callNo of b.sources) notWaitedMs += of(r.parentRunId, callNo);
    // Without live usage there is no cache to work out; with it, it is worked out when asked for.
    out.set(r.runId, { codes: b.codes.join(''), models: [...b.models.values()], notWaitedMs, ...(b.liveUsage ? {} : { cache: null }) });
  }
  return out;
}

/**
 * A run's live model calls under the prompt cache's rule, the run page's Context view's (the
 * engine's `runCache`, conversation by conversation): what they sent, what they read from the
 * cache, and the live calls where it stopped hitting. As the engine's `cacheUse` counts them for the
 * Overview: a call Shadowlap answered with an injected failure is not a live call.
 */
function cacheTotals(store: Store, runId: string): CacheTotals | null {
  const calls = store.getCalls(runId);
  const r = runCache(store, calls);
  if (!r.liveInput) return null;
  const byNo = new Map(calls.map((c) => [c.callNo, c]));
  const live = (c: CallRecord | undefined) => !!c && c.origin === 'live' && !c.end?.meta.injected;
  return { input: r.liveInput, read: r.liveRead, misses: r.misses.filter((m) => live(byNo.get(m.callNo))).map((m) => [m.callNo, m.scope, m.sentAgain]) };
}

/**
 * The recorded duration of a parent's calls, following replayed calls back through their parents:
 * each run's calls are read once, level by level, and resolved from memory.
 */
function recordedDurations(store: Store, index: RunIndex, tables: Map<string, Map<number, { latency: number; source: number | null }>>, runs: Array<string | null>): (runId: string | null, callNo: number) => number {
  let wanted = new Set(runs.filter((r): r is string => !!r));
  // Parents already read whose calls point further back.
  for (const [runId, table] of tables) for (const e of table.values()) if (e.source !== null) addParent(index, runId, tables, wanted);
  for (let level = 0; wanted.size && level < 32; level++) {
    const load = [...wanted].filter((id) => !tables.has(id));
    wanted = new Set();
    for (const id of load) tables.set(id, new Map());
    for (const batch of batches(load)) {
      for (const row of store.query(DURATIONS_SQL, ids(batch))) {
        const source = int(row.source);
        tables.get(String(row.run))!.set(Number(row.call), { latency: n(row.latency), source });
        if (source !== null) addParent(index, String(row.run), tables, wanted);
      }
    }
  }
  const memo = new Map<string, number>();
  const of = (runId: string | null, callNo: number, depth = 0): number => {
    if (!runId || depth > 64) return 0;
    const key = `${runId}#${callNo}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const entry = tables.get(runId)?.get(callNo);
    const ms = !entry ? 0 : entry.source === null ? entry.latency : of(index.byId.get(runId)?.parentRunId ?? null, entry.source, depth + 1);
    memo.set(key, ms);
    return ms;
  };
  return (runId, callNo) => of(runId, callNo);
}

function addParent(index: RunIndex, runId: string, tables: Map<string, unknown>, wanted: Set<string>): void {
  const parent = index.byId.get(runId)?.parentRunId;
  if (parent && !tables.has(parent)) wanted.add(parent);
}

/** A run's statistics under the prices given. */
export function priced(t: CallTotals, prices?: Record<string, Price>): RunStats {
  const s: RunStats = { calls: t.codes.length, origins: countOrigins(t.codes), spent: 0, saved: 0, captured: 0, unknownModels: [], notWaitedMs: t.notWaitedMs };
  for (const [bucket, model, input, output, cacheRead, cacheWrite] of t.models) {
    const usd = estimateCost(model, { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite }, prices);
    if (usd === null) {
      if (!s.unknownModels.includes(model)) s.unknownModels.push(model);
    } else if (bucket === 'r') s.saved += usd;
    else if (bucket === 'c') s.captured += usd;
    else s.spent += usd;
  }
  return s;
}

/** The call statistics of `runs`. */
export function runStats(store: Store, index: RunIndex, runs: Iterable<IndexedRun>, options: StatsOptions = {}): Map<string, RunStats> {
  const out = new Map<string, RunStats>();
  for (const [runId, t] of callTotals(store, index, runs)) out.set(runId, priced(t, options.prices));
  return out;
}

/**
 * What each run spent live, for sorting the Runs table by it as the table shows it: a run recorded
 * elsewhere (a capture, a teammate's run pulled from the team store, an unpacked golden) by what its
 * calls cost there.
 */
export function spentOf(store: Store, index: RunIndex, runs: readonly IndexedRun[], options: StatsOptions = {}): Map<string, number> {
  const out = new Map<string, number>();
  for (const [runId, s] of runStats(store, index, runs, options)) out.set(runId, s.spent + s.captured);
  return out;
}

/** Every call's origin, one character per call in call order, for each run asked for. */
export function originStrings(store: Store, index: RunIndex, runs: readonly IndexedRun[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [runId, t] of callTotals(store, index, runs)) out.set(runId, t.codes);
  return out;
}

/** Sums of several runs' statistics. */
export function sumStats(list: Iterable<RunStats>): RunStats {
  const total: RunStats = { calls: 0, origins: countOrigins(''), spent: 0, saved: 0, captured: 0, unknownModels: [], notWaitedMs: 0 };
  for (const s of list) {
    total.calls += s.calls;
    for (const k of Object.keys(total.origins) as Array<keyof OriginCounts>) total.origins[k] += s.origins[k];
    total.spent += s.spent;
    total.saved += s.saved;
    total.captured += s.captured;
    total.notWaitedMs += s.notWaitedMs;
    for (const m of s.unknownModels) if (!total.unknownModels.includes(m)) total.unknownModels.push(m);
  }
  return total;
}
