import { isFailure, type Origin7 } from '../origins.js';
import { judgeNumbers, type ScopedCall } from '../scopes.js';
import type { Kind } from './kinds.js';

/**
 * The call a run's page opens on when its link names none, and the one `n` jumps to. No DOM here:
 * the tests import it.
 *
 * A clock read or a random value is never where a run opens: it holds a value the agent read, not a
 * step it took, and its inspector has no conversation to show. So "its first call" is its first call
 * of any other kind, unless the run made only those.
 *
 * Nor is a judge's call (scopes.ts judgeNumbers): the judge is asked after the agent, so a judged
 * run's last model call is often the judge's, and opened there its page would be under the judge's
 * chip. Every rule here reads the agent's calls alone, as the design's tellingCall does.
 */

/** A call as the page has it: its number, who made it (a judge's is none to open on), kind, what a tool's call does and how it ended. */
export interface OpenCall extends ScopedCall {
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
 * and never a clock or random read, nor a judge's call. While a long run's pages come, `origins` has
 * every call's origin (`failed` among them), and `judge` the judge's calls by number (the server's
 * `judgeCalls`), so a failure past the calls read is found too. Null when none failed.
 */
export function firstFailedCall(calls: readonly OpenCall[], origins: readonly Origin7[] | null = null, judge: readonly number[] | null = null): number | null {
  return failedIn(calls, origins, judgeNumbers(calls, judge));
}

function failedIn(calls: readonly OpenCall[], origins: readonly Origin7[] | null, judge: ReadonlySet<number>): number | null {
  if (origins && origins.length > calls.length) {
    const byNo = new Map(calls.map((c) => [c.callNo, c]));
    for (let i = 0; i < origins.length; i++) {
      if (origins[i] !== 'fail' || judge.has(i + 1)) continue;
      const c = byNo.get(i + 1);
      // A call not read yet is taken on its origin alone: a clock or random read hardly ever fails.
      if (!c || !isRead(c)) return i + 1;
    }
    return null;
  }
  return calls.find((c) => isFailure(c) && !isRead(c) && !judge.has(c.callNo))?.callNo ?? null;
}

/** A run's first call that is neither a clock nor a random read, nor a judge's; its very first of the agent's when it made only those. */
export function firstStep(calls: readonly OpenCall[], judge: ReadonlySet<number> = judgeNumbers(calls)): number | null {
  const own = calls.filter((c) => !judge.has(c.callNo));
  return (own.find((c) => !isRead(c)) ?? own[0])?.callNo ?? null;
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
  /** While a long run's pages come, the judge's calls by number (the server's `judgeCalls`): none is where it opens. */
  judge?: readonly number[] | null;
  /**
   * While a long run's pages come, how many calls it has: a recording's newest is its count, not
   * the last call read. Opened at the last read, a recording of 3,000 calls stayed on #500 as it grew.
   */
  total?: number | null;
}

/** A call a run may open on: one of its own, no clock or random read, and none of the judge's. */
function stepAt(calls: readonly OpenCall[], n: number | null | undefined, judge: ReadonlySet<number>): number | null {
  if (n === null || n === undefined || judge.has(n)) return null;
  const c = calls.find((x) => x.callNo === n);
  return c && isRead(c) ? null : n;
}

/** The number of a long run's first call of a kind, or with `last` its last, the judge's left out. */
function kindAt(kinds: readonly Kind[], kind: Kind, judge: ReadonlySet<number>, last: boolean): number | null {
  for (let k = 0; k < kinds.length; k++) {
    const i = last ? kinds.length - 1 - k : k;
    if (kinds[i] === kind && !judge.has(i + 1)) return i + 1;
  }
  return null;
}

/**
 * A run's first write and the agent's last model call, never the judge's. While a long run's pages
 * come, they are taken from every call's kind, so a write or a model call past the calls read is
 * found as a failure is.
 */
function writeAndModel(calls: readonly OpenCall[], kinds: readonly Kind[] | null | undefined, judge: ReadonlySet<number>): { write: number | null; model: number | null } {
  if (kinds && kinds.length > calls.length) return { write: kindAt(kinds, 'k-write', judge, false), model: kindAt(kinds, 'k-model', judge, true) };
  const own = calls.filter((c) => !judge.has(c.callNo));
  const write = own.find((c) => c.kind === 'tool' && c.effect === 'write')?.callNo ?? null;
  let model: number | null = null;
  for (let k = own.length - 1; k >= 0 && model === null; k--) if (own[k]!.kind === 'api') model = own[k]!.callNo;
  return { write, model };
}

/**
 * Where a run opens, the most telling call first, as the design picks it: a recording at its newest
 * call; where blame found it lost; where it forked or diverged; the call its outcome names; its first
 * call that failed, whether or not the run failed for it; its first write; its last model call; else
 * its first call. Never a clock or random read, unless the run made only those, and never a judge's
 * call (the judge is asked once a recording has ended). While a long run's pages come, its failures,
 * its first write and its last model call are found past the calls read.
 */
export function openingCall(i: OpenInput): number | null {
  if (i.live) return Math.max(i.total ?? 0, i.calls.at(-1)?.callNo ?? 0) || null;
  const judge = judgeNumbers(i.calls, i.judge ?? null);
  const named = stepAt(i.calls, i.lostAt, judge) ?? stepAt(i.calls, i.forkAt, judge) ?? stepAt(i.calls, i.outcomeAt, judge);
  if (named !== null) return named;
  const { write, model } = writeAndModel(i.calls, i.kinds, judge);
  return failedIn(i.calls, i.origins ?? null, judge) ?? write ?? model ?? firstStep(i.calls, judge);
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
