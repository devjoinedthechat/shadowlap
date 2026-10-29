import { Lru } from './conversations.js';
import type { StoreOf } from './store.js';
import type { CallRecord, RunRecord } from './types.js';

/**
 * Time not waited: a replayed call is answered from the recording at once (it is stored with
 * `latencyMs: 0` and `replayedFrom`, the parent's call number), so the time it saves is how long
 * the recording waited for it. That duration is on the parent's call, or further back for a replay
 * of a replay: each ancestor is read once, whatever the number of calls followed through it.
 */

interface Timing {
  replayedFrom: number | null;
  latencyMs: number | null;
}

function timingOf(c: CallRecord): Timing {
  const meta = c.end?.meta;
  return {
    replayedFrom: c.origin === 'replayed' && typeof meta?.replayedFrom === 'number' ? meta.replayedFrom : null,
    latencyMs: typeof meta?.latencyMs === 'number' ? meta.latencyMs : null,
  };
}

/** Reads runs and their calls' timings, each once, for one computation over many runs. */
class Ancestry {
  private readonly runs = new Map<string, RunRecord | null>();
  private readonly timings = new Map<string, Map<number, Timing>>();
  constructor(private readonly store: StoreOf<'recording'>) {}
  run(runId: string): RunRecord | null {
    if (!this.runs.has(runId)) this.runs.set(runId, this.store.getRun(runId));
    return this.runs.get(runId)!;
  }
  timingsOf(runId: string, calls?: readonly CallRecord[]): Map<number, Timing> {
    let t = this.timings.get(runId);
    if (!t) {
      t = new Map((calls ?? this.store.getCalls(runId)).map((c) => [c.callNo, timingOf(c)]));
      this.timings.set(runId, t);
    }
    return t;
  }
}

/** `followed`, when given, gets each ancestor read, and whether it was in the store. */
function durations(a: Ancestry, run: RunRecord, calls: readonly CallRecord[], followed?: Array<[string, boolean]>): Map<number, number> {
  const out = new Map<number, number>();
  /** Calls of `run` still being followed, by the call number to read in the next ancestor. */
  let pending = new Map<number, number>();
  for (const c of calls) {
    const t = timingOf(c);
    if (t.replayedFrom !== null) pending.set(c.callNo, t.replayedFrom);
  }
  const seen = new Set<string>([run.runId]);
  let ancestor = run.parentRunId;
  while (pending.size && ancestor && !seen.has(ancestor)) {
    seen.add(ancestor);
    followed?.push([ancestor, a.run(ancestor) !== null]);
    const timings = a.timingsOf(ancestor);
    const next = new Map<number, number>();
    for (const [callNo, from] of pending) {
      const t = timings.get(from);
      if (!t) continue;
      if (t.replayedFrom !== null) next.set(callNo, t.replayedFrom);
      else if (t.latencyMs !== null) out.set(callNo, t.latencyMs);
    }
    pending = next;
    ancestor = a.run(ancestor)?.parentRunId ?? null;
  }
  return out;
}

/**
 * How long the recording waited for each of a run's replayed calls, by call number. A replayed call
 * whose recording is gone (deleted, or a pack's run whose parent was not packed) has no entry.
 */
export function recordedDurations(store: StoreOf<'recording'>, run: RunRecord, calls?: readonly CallRecord[]): Map<number, number> {
  return durations(new Ancestry(store), run, calls ?? store.getCalls(run.runId));
}

export interface NotWaited {
  /** Milliseconds the replays did not wait, summed. */
  ms: number;
  /** Replayed calls whose recorded duration was found. */
  calls: number;
  /** Per run, for daily or weekly sums: runs with nothing replayed are left out. */
  runs: Array<{ runId: string; startedAt: number; ms: number; calls: number }>;
}

/** Runs by id, or every run started in a window. */
export type RunSelection = readonly string[] | number | { since: number; until?: number };

/**
 * Each finished replay's part, per store: the calls it replayed and what its recording waited for
 * them no longer change, so the Overview, which asks on every load, reads them once. The ancestors
 * it was followed through are kept with it: once one of them is deleted (`gc`), the part is
 * worked out again, as the run's page would.
 */
const finishedWaits = new WeakMap<object, Lru<string, { ms: number; calls: number; followed: Array<[string, boolean]> }>>();

/**
 * The time replays did not wait, over the runs named or those started since a time (ms since the
 * epoch, or a window with an exclusive `until`). Ancestors shared by many runs are read once, and a
 * finished replay's calls once per store; a replay still running is read again each time.
 */
export function notWaited(store: StoreOf<'recording'>, which: RunSelection): NotWaited {
  const a = new Ancestry(store);
  let runs: RunRecord[];
  if (Array.isArray(which)) runs = (which as readonly string[]).map((id) => a.run(id)).filter((r): r is RunRecord => r !== null);
  else {
    const since = typeof which === 'number' ? which : (which as { since: number }).since;
    const until = typeof which === 'number' ? undefined : (which as { until?: number }).until;
    runs = store.allRuns().filter((r) => r.startedAt >= since && (until === undefined || r.startedAt < until));
  }
  let known = finishedWaits.get(store);
  if (!known) finishedWaits.set(store, (known = new Lru(8192)));
  const out: NotWaited = { ms: 0, calls: 0, runs: [] };
  for (const run of runs) {
    // Recordings replay nothing: no need to read their calls.
    if (run.mode !== 'replay' || !run.parentRunId) continue;
    const finished = run.status !== 'running' ? `${run.runId}\n${run.status}\n${run.endedAt ?? ''}` : null;
    let part = finished === null ? undefined : known.get(finished);
    if (part && !part.followed.every(([id, was]) => (a.run(id) !== null) === was)) part = undefined;
    if (part === undefined) {
      const calls = store.getCalls(run.runId);
      // A run selected here may be another's ancestor too: its calls are read once.
      a.timingsOf(run.runId, calls);
      const followed: Array<[string, boolean]> = [];
      const found = durations(a, run, calls, followed);
      let ms = 0;
      for (const v of found.values()) ms += v;
      part = { ms, calls: found.size, followed };
      if (finished !== null) known.set(finished, part);
    }
    if (!part.calls) continue;
    out.ms += part.ms;
    out.calls += part.calls;
    out.runs.push({ runId: run.runId, startedAt: run.startedAt, ms: part.ms, calls: part.calls });
  }
  return out;
}
