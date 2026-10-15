/**
 * What replaying a call did not wait for. A replayed call is answered from the recording in a few
 * milliseconds; how long it took when it ran is on the call it was replayed from, in the parent run,
 * or further back for a replay of a replay. No DOM here: the tests import it.
 */

export interface DurationCall {
  callNo: number;
  origin: string;
  latencyMs: number | null;
  /** The parent run's call this one was replayed from. */
  replayedFrom?: number | null;
  /** Set by the server when it already followed the chain. */
  recordedMs?: number | null;
}

/** A run's calls by number, for looking a call up while walking back. */
export type CallIndex = ReadonlyMap<number, DurationCall>;

export function indexCalls(calls: readonly DurationCall[]): CallIndex {
  return new Map(calls.map((c) => [c.callNo, c]));
}

/**
 * The time a call took when it was recorded. For a call that ran here, its own latency. For a
 * replayed call, the latency of the call it came from: `ancestors[0]` is the parent run's calls,
 * `ancestors[1]` the grandparent's, and so on. Null when the chain is not loaded or ends early.
 */
export function recordedDuration(call: DurationCall, ancestors: readonly CallIndex[]): number | null {
  if (call.origin !== 'replayed') return call.latencyMs;
  if (typeof call.recordedMs === 'number') return call.recordedMs;
  let n = call.replayedFrom ?? call.callNo;
  for (const level of ancestors) {
    const from = level.get(n);
    if (!from) return null;
    if (from.origin !== 'replayed') return from.latencyMs;
    if (typeof from.recordedMs === 'number') return from.recordedMs;
    n = from.replayedFrom ?? from.callNo;
  }
  return null;
}

/** The time not waited: every replayed call's recorded duration, and how many could not be found. */
export function notWaited(calls: readonly DurationCall[], ancestors: readonly CallIndex[]): { ms: number; unknown: number } {
  let ms = 0;
  let unknown = 0;
  for (const c of calls) {
    if (c.origin !== 'replayed') continue;
    const d = recordedDuration(c, ancestors);
    if (d === null) unknown++;
    else ms += d;
  }
  return { ms, unknown };
}

/** Whether the parent chain is needed: a replayed call the server did not resolve. */
export function needsAncestors(calls: readonly DurationCall[]): boolean {
  return calls.some((c) => c.origin === 'replayed' && typeof c.recordedMs !== 'number');
}
