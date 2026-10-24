import { isFailure, type Origin7 } from '../origins.js';

/**
 * The call a run's page opens on when its link names none, and the one `n` jumps to. No DOM here:
 * the tests import it.
 *
 * A clock read or a random value is never where a run opens: it holds a value the agent read, not a
 * step it took, and its inspector has no conversation to show. So "its first call" is its first call
 * of any other kind, unless the run made only those.
 */

/** A call as the page has it: its number, kind and how it ended. */
export interface OpenCall {
  callNo: number;
  kind: string;
  origin: string;
  outcome: 'ok' | 'error' | null;
}

/** A clock read or a random value: a value read, never a step to open on. */
const isRead = (c: Pick<OpenCall, 'kind'>) => c.kind === 'clock' || c.kind === 'random';

/**
 * A run's first call that failed: a model call answered with an error, a tool that threw. Not a
 * write fenced after a fork (Shadowlap refused it on purpose) nor a failure `--fail-at` played in,
 * and never a clock or random read. While a long run's pages come, `origins` has every call's
 * origin (`failed` among them), so a failure past the calls read is found too. Null when none failed.
 */
export function firstFailedCall(calls: readonly OpenCall[], origins: readonly Origin7[] | null = null): number | null {
  if (origins && origins.length > calls.length) {
    const byNo = new Map(calls.map((c) => [c.callNo, c]));
    for (let i = 0; i < origins.length; i++) {
      if (origins[i] !== 'fail') continue;
      const c = byNo.get(i + 1);
      // A call not read yet is taken on its origin alone: a clock or random read hardly ever fails.
      if (!c || !isRead(c)) return i + 1;
    }
    return null;
  }
  return calls.find((c) => isFailure(c) && !isRead(c))?.callNo ?? null;
}

/** A run's first call that is neither a clock nor a random read; its very first when it made only those. */
export function firstStep(calls: readonly OpenCall[]): number | null {
  return (calls.find((c) => !isRead(c)) ?? calls[0])?.callNo ?? null;
}

export interface OpenInput {
  /** Where a replay forked (the strip's FORK). */
  forkAt: number | null;
  /** Where blame found the run lost. */
  lostAt: number | null;
  /** The run is recording: its page follows its newest call. */
  live: boolean;
  /** The run failed, as the server's state has it (its check, its agent's exit, a fix's check). */
  failed: boolean;
  calls: readonly OpenCall[];
  origins?: readonly Origin7[] | null;
}

/**
 * Where a run opens: where it forked, else where blame found it lost; a recording at its newest
 * call; a run that failed at its first call that failed; else at its first call, clock and random
 * reads passed over.
 */
export function openingCall(i: OpenInput): number | null {
  if (i.forkAt !== null) return i.forkAt;
  if (i.lostAt !== null) return i.lostAt;
  if (i.live) return i.calls.at(-1)?.callNo ?? null;
  return (i.failed ? firstFailedCall(i.calls, i.origins ?? null) : null) ?? firstStep(i.calls);
}
