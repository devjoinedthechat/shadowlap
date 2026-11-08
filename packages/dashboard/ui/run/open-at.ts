import { isFailure, type Origin7 } from '../origins.js';
import type { Kind } from './kinds.js';

/**
 * The call a run's page opens on when its link names none, and the one `n` jumps to. No DOM here:
 * the tests import it.
 *
 * A clock read or a random value is never where a run opens: it holds a value the agent read, not a
 * step it took, and its inspector has no conversation to show. So "its first call" is its first call
 * of any other kind, unless the run made only those.
 */

/** A call as the page has it: its number, kind, what a tool's call does and how it ended. */
export interface OpenCall {
  callNo: number;
  kind: string;
  origin: string;
  outcome: 'ok' | 'error' | null;
  effect?: string | null;
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
  /** Where a replay forked (the strip's FORK), or a test's replay diverged. */
  forkAt: number | null;
  /** Where blame found the run lost. */
  lostAt: number | null;
  /** The call the run's outcome names, its first fact's (a check's failing call); none where it names none. */
  outcomeAt?: number | null;
  /** The run is recording: its page follows its newest call. */
  live: boolean;
  calls: readonly OpenCall[];
  origins?: readonly Origin7[] | null;
  /** While a long run's pages come, every call's kind (kinds.ts), as `origins` has every call's origin. */
  kinds?: readonly Kind[] | null;
  /**
   * While a long run's pages come, how many calls it has: a recording's newest is its count, not
   * the last call read. Opened at the last read, a recording of 3,000 calls stayed on #500 as it grew.
   */
  total?: number | null;
}

/** A call a run may open on: one of its own, and no clock or random read. */
function stepAt(calls: readonly OpenCall[], n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  const c = calls.find((x) => x.callNo === n);
  return c && isRead(c) ? null : n;
}

/**
 * A run's first write and its last model call. While a long run's pages come, they are taken from
 * every call's kind, so a write or a model call past the calls read is found as a failure is.
 */
function writeAndModel(calls: readonly OpenCall[], kinds: readonly Kind[] | null | undefined): { write: number | null; model: number | null } {
  if (kinds && kinds.length > calls.length) {
    const w = kinds.indexOf('k-write');
    const m = kinds.lastIndexOf('k-model');
    return { write: w < 0 ? null : w + 1, model: m < 0 ? null : m + 1 };
  }
  const write = calls.find((c) => c.kind === 'tool' && c.effect === 'write')?.callNo ?? null;
  let model: number | null = null;
  for (let k = calls.length - 1; k >= 0 && model === null; k--) if (calls[k]!.kind === 'api') model = calls[k]!.callNo;
  return { write, model };
}

/**
 * Where a run opens, the most telling call first, as the design picks it: a recording at its newest
 * call; where blame found it lost; where it forked or diverged; the call its outcome names; its first
 * call that failed, whether or not the run failed for it; its first write; its last model call; else
 * its first call. Never a clock or random read, unless the run made only those. While a long run's
 * pages come, its failures, its first write and its last model call are found past the calls read.
 */
export function openingCall(i: OpenInput): number | null {
  if (i.live) return Math.max(i.total ?? 0, i.calls.at(-1)?.callNo ?? 0) || null;
  const named = stepAt(i.calls, i.lostAt) ?? stepAt(i.calls, i.forkAt) ?? stepAt(i.calls, i.outcomeAt);
  if (named !== null) return named;
  const { write, model } = writeAndModel(i.calls, i.kinds);
  return firstFailedCall(i.calls, i.origins ?? null) ?? write ?? model ?? firstStep(i.calls);
}

/** The call picked on each run's page this session, so a run opened again comes back to it. */
const picked = new Map<string, number>();

/** Remembers the call a run's page shows, one its address named too. */
export function rememberCall(runId: string, callNo: number): void {
  picked.set(runId, callNo);
}

/** The call a run's page last showed this session, if any. */
export function pickedCall(runId: string): number | null {
  return picked.get(runId) ?? null;
}

/** Where a run's page opens with no call named: the call picked on it earlier in the session, else the most telling; a recording follows its newest. */
export function openOn(runId: string, i: OpenInput): number | null {
  return (i.live ? null : pickedCall(runId)) ?? openingCall(i);
}

/** Forgets every picked call: for tests, which open the same run one after another. */
export function forgetPickedCalls(): void {
  picked.clear();
}
