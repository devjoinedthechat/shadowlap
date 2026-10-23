import { isJudgeCall } from './judge-scope.js';
import type { CallRecord } from './types.js';

/**
 * A provider that is down, overloaded or rate limiting says nothing about the agent. An attempt the
 * agent failed while one of its live model calls ended in such an error is `unavailable`: it is
 * retried after a pause, never counted in a gate's tally, and enough of them in a row make the result
 * inconclusive, with the provider named as the reason, instead of a verdict on the agent.
 *
 * What counts is what the call records hold, the final answer of each of the agent's live model calls
 * (a call its SDK retried and that then succeeded is fine): HTTP 408, 409, 429 or any 5xx from the
 * provider (529 "overloaded" included, and 504 or 524, a timeout on the provider's side), or the
 * connection failing (Shadowlap's 502 for an upstream it could not reach, or a stream cut short).
 * The agent's own timeout is not the provider's: an agent that hung up on a call (its client's
 * timeout, or an abort) or that a test's time limit stopped failed by its own clock. Failures
 * Shadowlap plays in on purpose (`--fail-at`, `test --chaos`) and calls it refused itself (offline, a
 * placeholder key) are no provider's either, and neither are a judge check's calls, which the judge
 * retries by itself.
 */

/** Statuses a provider sends when it can't answer now, whatever the request: worth asking again. */
export function unavailableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

/** The model call that shows the provider was unavailable, and what it asked for. */
export interface Unavailable {
  callNo: number;
  /** The provider's id as the call recorded it (`anthropic`, `openai`), when it did. */
  provider: string | null;
  /** The HTTP status the call ended with; 502 for a connection that failed, as Shadowlap answers it. */
  status: number | null;
  /** The connection error, for one that failed or was cut short. */
  error: string | null;
  /** How long the provider asked to wait (`retry-after-ms`, else `retry-after`), or null when it didn't. */
  retryAfterMs: number | null;
  /** In words: `HTTP 529 from anthropic at call #3`. */
  reason: string;
}

const CONNECTION_ERRORS = new Set(['UpstreamConnectionError', 'UpstreamStreamError']);

/**
 * How long a `retry-after-ms` or `retry-after` header asks to wait, in ms: a number of seconds, or an
 * HTTP date (counted from `now`). Null when neither says.
 */
export function retryAfter(headers: Record<string, string> | undefined, now = Date.now()): number | null {
  if (!headers) return null;
  const ms = Number(headers['retry-after-ms']);
  if (headers['retry-after-ms'] !== undefined && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers['retry-after']?.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * The live model call of the agent's whose final answer shows the provider unavailable, the last one
 * when several do, or null when none does. The caller decides whether the attempt failed: one that
 * passed with a call that failed (an agent that recovered) is a pass.
 */
export function providerUnavailable(calls: readonly CallRecord[]): Unavailable | null {
  let found: Unavailable | null = null;
  for (const c of calls) {
    if (c.kind !== 'api' || c.origin !== 'live' || isJudgeCall(c) || !c.end || c.end.outcome !== 'error') continue;
    const meta = c.end.meta;
    if (meta.injected || meta.offline || meta.refused) continue;
    const error = meta.error?.name ?? null;
    // The agent hung up: its own timeout or abort, not the provider's.
    if (error === 'ClientDisconnected') continue;
    const status = typeof meta.status === 'number' ? meta.status : null;
    const connection = error !== null && CONNECTION_ERRORS.has(error);
    if (!connection && !(status !== null && unavailableStatus(status))) continue;
    const provider = typeof meta.provider === 'string' ? meta.provider : typeof c.meta.provider === 'string' ? c.meta.provider : null;
    const what = connection ? (error === 'UpstreamStreamError' ? 'a stream cut short' : 'a connection that failed') : `HTTP ${status}`;
    found = { callNo: c.callNo, provider, status, error: connection ? error : null, retryAfterMs: retryAfter(meta.headers, c.end.at), reason: `${what}${provider ? ` from ${provider}` : ''} at call #${c.callNo}` };
  }
  return found;
}

/** How unavailable attempts are retried: up to `inARow` in a row, then the result is inconclusive. */
export const UNAVAILABLE_RETRY = Object.freeze({
  /** Unavailable attempts in a row that make a result inconclusive. */
  inARow: 3,
  /** The pause before the first retry when the provider asked for none; each next one is three times longer. */
  firstDelayMs: 5_000,
  /** The longest pause, whatever the provider asked for. */
  maxDelayMs: 60_000,
});

/**
 * The pause before retry `n` (1 for the first) after an unavailable attempt: what the provider asked
 * for (`retryAfterMs`), at most the cap, else 5 s, 15 s, 45 s… with a fifth either way at random,
 * so parallel jobs don't come back together, at most the cap.
 */
export function retryDelay(n: number, retryAfterMs: number | null, random: () => number = Math.random, limits: { firstDelayMs: number; maxDelayMs: number } = UNAVAILABLE_RETRY): number {
  if (retryAfterMs !== null) return Math.min(Math.max(0, retryAfterMs), limits.maxDelayMs);
  const base = limits.firstDelayMs * 3 ** Math.max(0, n - 1);
  return Math.min(limits.maxDelayMs, Math.round(base * (0.8 + 0.4 * random())));
}

/** The reason a result is inconclusive when the provider was unavailable for `n` attempts in a row. */
export function unavailableReason(n: number, last: Unavailable): string {
  return `provider unavailable: ${n} attempt${n === 1 ? '' : 's'} in a row ended on ${last.reason}, so none of them says anything about the agent; run it again once the provider answers`;
}
