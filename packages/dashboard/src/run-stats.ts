import { displayOrigin, emptyOriginCounts, estimateCost, ORIGIN_CODE, summarizeRun, type Origin, type OriginCounts, type Outcome, type Price, type SqlValue, type Store } from '@shadowlap/engine';
import { modelResolver } from '@shadowlap/tui/data';
import type { IndexedRun, RunIndex } from './run-index.js';

/**
 * What a run's calls add up to, aggregated in SQL rather than by loading the calls: how many came
 * from where, what the live ones cost and the replayed ones saved, and how long the replayed ones
 * would have taken. A finished run never changes, so its numbers are kept per store once worked out.
 */

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
  /**
   * Time not waited: for every replayed call, the duration it took when it was recorded. A replayed
   * call stores none of its own; its recording is the parent's call, or further back for a replay
   * of a replay.
   */
  notWaitedMs: number;
  /** Live model calls with usage (imported runs left out): their whole input, and the part read from the prompt cache. */
  liveInput: number;
  liveCacheRead: number;
}

export interface StatsOptions {
  prices?: Record<string, Price>;
}

/** The final answer of each call: its end row with the highest attempt. */
const FINAL_END = `LEFT JOIN call_events e ON e.run_id = s.run_id AND e.call_no = s.call_no AND e.phase = 'end'
  AND e.attempt = (SELECT MAX(x.attempt) FROM call_events x WHERE x.run_id = s.run_id AND x.call_no = s.call_no AND x.phase = 'end')`;

const STATS_SQL = `
SELECT s.run_id AS run, s.kind AS kind, s.origin AS origin, e.outcome AS outcome,
       CASE WHEN e.outcome = 'error' THEN e.meta ->> '$.injected' END AS injected,
       CASE WHEN s.kind = 'api' THEN COALESCE(e.meta ->> '$.model', s.meta ->> '$.model') END AS model,
       COUNT(*) AS n,
       SUM(CASE WHEN s.kind = 'api' AND e.meta -> '$.usage' IS NOT NULL THEN 1 ELSE 0 END) AS with_usage,
       SUM(CASE WHEN s.kind = 'api' THEN e.meta ->> '$.usage.inputTokens' END) AS input,
       SUM(CASE WHEN s.kind = 'api' THEN e.meta ->> '$.usage.outputTokens' END) AS output,
       SUM(CASE WHEN s.kind = 'api' THEN e.meta ->> '$.usage.cacheReadInputTokens' END) AS cache_read,
       SUM(CASE WHEN s.kind = 'api' THEN e.meta ->> '$.usage.cacheCreationInputTokens' END) AS cache_write,
       group_concat(CASE WHEN s.origin = 'replayed' THEN e.meta ->> '$.replayedFrom' END) AS sources
FROM call_events s
${FINAL_END}
WHERE s.phase = 'start' AND s.run_id IN (SELECT value FROM json_each(?))
GROUP BY s.run_id, s.kind, s.origin, e.outcome, injected, model`;

/** Each call's recorded duration and, for a replayed call, the parent's call it was replayed from. */
const DURATIONS_SQL = `
SELECT s.run_id AS run, s.call_no AS call, e.meta ->> '$.latencyMs' AS latency,
       CASE WHEN s.origin = 'replayed' THEN e.meta ->> '$.replayedFrom' END AS source
FROM call_events s
${FINAL_END}
WHERE s.phase = 'start' AND s.run_id IN (SELECT value FROM json_each(?))`;

const ORIGINS_SQL = `
SELECT s.run_id AS run, s.origin AS origin, e.outcome AS outcome, CASE WHEN e.outcome = 'error' THEN e.meta ->> '$.injected' END AS injected
FROM call_events s
${FINAL_END}
WHERE s.phase = 'start' AND s.run_id IN (SELECT value FROM json_each(?))
ORDER BY s.run_id, s.call_no`;

const BATCH = 800;

function* batches<T>(items: readonly T[], size = BATCH): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

const ids = (list: readonly string[]): SqlValue => JSON.stringify(list);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The one-character origin of a call, from its stored origin and its final answer. */
function codeOf(origin: unknown, outcome: unknown, injected: unknown): string {
  return ORIGIN_CODE[displayOrigin(origin as Origin, outcome === null || outcome === undefined ? null : { outcome: outcome as Outcome, injected: injected === 1 })];
}

const cache = new WeakMap<Store, Map<string, { key: string; stats: RunStats }>>();

/** What the numbers of a run depend on: a finished run's are fixed until the prices change. */
const keyOf = (r: IndexedRun, prices: string) => `${r.status}|${r.endedAt}|${r.calls}|${prices}`;

/** The call statistics of `runs`. */
export function runStats(store: Store, index: RunIndex, runs: Iterable<IndexedRun>, options: StatsOptions = {}): Map<string, RunStats> {
  const prices = options.prices ? JSON.stringify(options.prices) : '';
  let kept = cache.get(store);
  if (!kept) {
    kept = new Map();
    cache.set(store, kept);
  }
  const out = new Map<string, RunStats>();
  const todo: IndexedRun[] = [];
  for (const r of runs) {
    if (out.has(r.runId)) continue;
    const hit = kept.get(r.runId);
    if (hit && hit.key === keyOf(r, prices)) out.set(r.runId, hit.stats);
    else if (r.calls === 0) out.set(r.runId, empty());
    else todo.push(r);
  }
  if (!todo.length) return out;

  const fresh = new Map<string, RunStats>(todo.map((r) => [r.runId, empty()]));
  const sources = new Map<string, number[]>();
  const legacy = new Set<string>();
  for (const batch of batches(todo.map((r) => r.runId))) {
    for (const row of store.query(STATS_SQL, ids(batch))) {
      const runId = String(row.run);
      const st = fresh.get(runId)!;
      const run = index.byId.get(runId)!;
      const count = n(row.n);
      st.calls += count;
      st.origins[codeOf(row.origin, row.outcome, row.injected) as keyof OriginCounts] += count;
      if (row.origin === 'replayed' && typeof row.sources === 'string' && row.sources) {
        const list = sources.get(runId) ?? [];
        for (const s of row.sources.split(',')) {
          const k = Number(s);
          if (Number.isInteger(k)) list.push(k);
        }
        sources.set(runId, list);
      }
      if (row.kind !== 'api' || n(row.with_usage) === 0) continue;
      // Recorded before the model was kept per call: the request has to be read for it.
      if (typeof row.model !== 'string') {
        legacy.add(runId);
        continue;
      }
      const usage = { inputTokens: n(row.input), outputTokens: n(row.output), cacheReadInputTokens: n(row.cache_read), cacheCreationInputTokens: n(row.cache_write) };
      const imported = !!run.meta.imported && run.mode === 'record';
      if (row.origin === 'live' && !imported) {
        st.liveInput += usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
        st.liveCacheRead += usage.cacheReadInputTokens;
      }
      const usd = estimateCost(row.model, usage, options.prices);
      if (usd === null) {
        if (!st.unknownModels.includes(row.model)) st.unknownModels.push(row.model);
      } else if (row.origin === 'replayed') st.saved += usd;
      else if (row.origin === 'live' && imported) st.captured += usd;
      else if (row.origin === 'live') st.spent += usd;
    }
  }

  // Costs of old recordings, call by call, as the run page sums them.
  for (const runId of legacy) {
    const run = store.getRun(runId);
    if (!run) continue;
    const s = summarizeRun(run, store.getCalls(runId), [], [], { modelOf: modelResolver(store), ...(options.prices ? { prices: options.prices } : {}) });
    Object.assign(fresh.get(runId)!, { spent: s.cost.spent, saved: s.cost.saved, captured: s.cost.captured, unknownModels: s.cost.unknownModels });
  }

  const durations = recordedDurations(store, index, [...sources.keys()].map((id) => index.byId.get(id)?.parentRunId ?? null));
  for (const [runId, list] of sources) {
    const parent = index.byId.get(runId)?.parentRunId ?? null;
    let ms = 0;
    for (const k of list) ms += durations.of(parent, k);
    fresh.get(runId)!.notWaitedMs = ms;
  }

  for (const r of todo) {
    const st = fresh.get(r.runId)!;
    out.set(r.runId, st);
    if (r.status !== 'running') kept.set(r.runId, { key: keyOf(r, prices), stats: st });
  }
  if (kept.size > 50_000) kept.clear();
  return out;
}

function empty(): RunStats {
  return { calls: 0, origins: emptyOriginCounts(), spent: 0, saved: 0, captured: 0, unknownModels: [], notWaitedMs: 0, liveInput: 0, liveCacheRead: 0 };
}

/**
 * The recorded duration of calls in `runs`, following replayed calls back through their parents:
 * each run's calls are read once, level by level, and resolved from memory.
 */
function recordedDurations(store: Store, index: RunIndex, runs: Array<string | null>): { of: (runId: string | null, callNo: number) => number } {
  const tables = new Map<string, Map<number, { latency: number; source: number | null }>>();
  let wanted = new Set(runs.filter((r): r is string => !!r));
  for (let level = 0; wanted.size && level < 32; level++) {
    const load = [...wanted].filter((id) => !tables.has(id));
    wanted = new Set();
    for (const id of load) tables.set(id, new Map());
    for (const batch of batches(load)) {
      for (const row of store.query(DURATIONS_SQL, ids(batch))) {
        const source = typeof row.source === 'number' && Number.isInteger(row.source) ? row.source : null;
        tables.get(String(row.run))!.set(Number(row.call), { latency: n(row.latency), source });
        if (source !== null) {
          const parent = index.byId.get(String(row.run))?.parentRunId;
          if (parent && !tables.has(parent)) wanted.add(parent);
        }
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
  return { of: (runId, callNo) => of(runId, callNo) };
}

/** Every call's origin, one character per call in call order, for each run asked for. */
export function originStrings(store: Store, runIds: readonly string[]): Map<string, string> {
  const parts = new Map<string, string[]>(runIds.map((id) => [id, []]));
  for (const batch of batches([...new Set(runIds)])) {
    for (const row of store.query(ORIGINS_SQL, ids(batch))) parts.get(String(row.run))?.push(codeOf(row.origin, row.outcome, row.injected));
  }
  return new Map([...parts].map(([id, codes]) => [id, codes.join('')]));
}

/** Sums of several runs' statistics. */
export function sumStats(list: Iterable<RunStats>): RunStats {
  const total = empty();
  for (const s of list) {
    total.calls += s.calls;
    for (const k of Object.keys(total.origins) as Array<keyof OriginCounts>) total.origins[k] += s.origins[k];
    total.spent += s.spent;
    total.saved += s.saved;
    total.captured += s.captured;
    total.notWaitedMs += s.notWaitedMs;
    total.liveInput += s.liveInput;
    total.liveCacheRead += s.liveCacheRead;
    for (const m of s.unknownModels) if (!total.unknownModels.includes(m)) total.unknownModels.push(m);
  }
  return total;
}
