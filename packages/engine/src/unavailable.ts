import { isJudgeCall } from './judge-scope.js';
import type { CallRecord } from './types.js';

/**
 * A provider that is down, overloaded or rate limiting says nothing about the agent. An attempt the
 * agent failed while one of its live model calls ended in such an error is `unavailable`, and enough
 * of them in a row make the result inconclusive, with the provider named as the reason, instead of a
 * verdict on the agent. When the provider failed it decides how the attempt is counted:
 *
 * - `early`: before the model had answered anything live in the attempt. Nothing of the attempt's
 *   own course was sampled yet, so the error can't depend on how it would have gone: the attempt is
 *   retried after a pause and never counted, which leaves the attempts that are counted as they would
 *   have been.
 * - otherwise, part way through, after the model had answered: the error may come with the course the
 *   attempt took (an agent that loops until it is rate limited), and leaving such attempts out would
 *   leave the failing ones out. A gate counts it against either verdict: as a failure toward a pass,
 *   and as a pass toward a failure (stats.ts `decideUnavailable`), so neither verdict rests on how the
 *   attempts the provider cut short would have ended.
 *
 * What counts is what the call records hold, the final answer of each of the agent's live model calls
 * (a call its SDK retried and that then succeeded is fine): HTTP 408, 409, 429 or any 5xx from the
 * provider (529 "overloaded" included, and 504 or 524, a timeout on the provider's side), or the
 * connection failing (an upstream Shadowlap could not reach, which leaves the call no status, or a
 * stream cut short: either way the agent's connection is broken, and a replay breaks it again), or an
 * answer from the provider that could not be passed on to the agent at all. These are told by the
 * error the call recorded, whatever status it holds.
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
  /**
   * The HTTP status the call recorded, or null when it has none: an upstream that could not be reached
   * has none (an earlier version recorded a 502 of its own for it).
   */
  status: number | null;
  /** The connection error, for one that failed or was cut short. */
  error: string | null;
  /** How long the provider asked to wait (`retry-after-ms`, else `retry-after`), or null when it didn't. */
  retryAfterMs: number | null;
  /** In words: `HTTP 529 from anthropic at call #3`. */
  reason: string;
  /**
   * No live model call of the agent's in the attempt had been answered: the provider failed before the
   * attempt's own course began, so the error says nothing of how it would have gone, and the attempt
   * is retried, never counted. False when the model had answered some call live first.
   */
  early: boolean;
}

/** What the sidecar records for an upstream it could not reach, a stream cut short, and an answer it could not pass on. */
const CONNECTION_ERRORS = new Set(['UpstreamConnectionError', 'UpstreamStreamError', 'UpstreamResponseError']);

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
  // A live model call of the agent's the provider answered: the attempt's own course had begun.
  const answered = calls.some((c) => c.kind === 'api' && c.origin === 'live' && !isJudgeCall(c) && c.end?.outcome === 'ok');
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
    const what = connection ? (error === 'UpstreamStreamError' ? 'a stream cut short' : error === 'UpstreamResponseError' ? 'an answer that could not be passed on' : 'a connection that failed') : `HTTP ${status!}`;
    found = { callNo: c.callNo, provider, status, error: connection ? error : null, retryAfterMs: retryAfter(meta.headers, c.end.at), reason: `${what}${provider ? ` from ${provider}` : ''} at call #${c.callNo}`, early: !answered };
  }
  return found;
}

/**
 * The first live model call of the agent's the provider turned away for good, in words, or null when
 * none was: a 4xx that coming back later won't change, as a model that retired answers. The caller
 * decides what it means: one that passed with a call that failed (an agent that recovered) is a pass.
 */
export function providerRefused(calls: readonly CallRecord[]): string | null {
  for (const c of calls) {
    if (c.kind !== 'api' || c.origin !== 'live' || isJudgeCall(c) || !c.end || c.end.outcome !== 'error') continue;
    const meta = c.end.meta;
    if (meta.injected || meta.offline || meta.refused) continue;
    const status = typeof meta.status === 'number' ? meta.status : null;
    if (status === null || status < 400 || status >= 500 || unavailableStatus(status)) continue;
    const provider = typeof meta.provider === 'string' ? meta.provider : typeof c.meta.provider === 'string' ? c.meta.provider : null;
    return `HTTP ${status}${provider ? ` from ${provider}` : ''} at call #${c.callNo}`;
  }
  return null;
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

/** How every reason `unavailableReason` gives starts: what a stop's reason is read by (`unavailableStop`). */
const UNAVAILABLE_PREFIX = 'provider unavailable: ';

/** The reason a result is inconclusive when the provider was unavailable for `n` attempts in a row. */
export function unavailableReason(n: number, last: Unavailable): string {
  return `${UNAVAILABLE_PREFIX}${n} attempt${n === 1 ? '' : 's'} in a row ended on ${last.reason}, so none of them says anything about the agent; run it again once the provider answers`;
}

/**
 * How many unavailable attempts in a row stop a test session of `goldens` goldens, counted across the
 * session, whichever goldens ran them (their attempts run in turns): 3 for one golden, one more for
 * each tenfold of goldens (4 from 2, 5 from 11, 6 from 101). A provider that fails attempts now and
 * then, independently, fails k in a row somewhere in N attempts about N·e^k of the time, so a fixed 3
 * stops most large sessions for nothing: early errors on 5% or 10% of the attempts stopped 19% and 81%
 * of 100-golden sessions. At 3 + ⌈log₁₀ G⌉, a provider failing one attempt in ten stops a session
 * about as often whatever its size, and one that is down stops the session after that many in a row.
 */
export function sessionInARow(goldens: number): number {
  return UNAVAILABLE_RETRY.inARow + Math.max(0, Math.ceil(Math.log10(Math.max(1, goldens)) - 1e-12));
}

/**
 * How many unavailable attempts in a row stop a run of attempts once `attempts` of them have started
 * (verify's, blame's, repair's, migrate's and injection's runner): 3 within the first 10, one more for
 * each tenfold beyond (4 to 100, 5 to 1,000), as `sessionInARow` grows a test session's with its
 * goldens at 10 attempts a golden. A run that has gone on long has had more chances to meet a few
 * errors in a row by chance: with 5% and 10% of attempts failing, a fixed 3 stopped 300 attempts 3.5%
 * and 24% of the time, and 600, 6.9% and 42% (provider-session.test.ts).
 */
export function attemptsInARow(attempts: number): number {
  return sessionInARow(Math.ceil(Math.max(1, attempts) / 10));
}

/** Why a golden (or a preset, `what`) was not tested: the session's provider stayed unavailable `n` attempts in a row, across it, before its turn. */
export function sessionUnavailableReason(n: number, last: Unavailable, what: 'golden' | 'preset' = 'golden'): string {
  return `${UNAVAILABLE_PREFIX}${n} attempts in a row across the session ended on ${last.reason}, so the session stopped before this ${what} ran; run it again once the provider answers`;
}

/**
 * Whether a run, a probe or a session stopped because its provider was unavailable too many attempts
 * in a row (its `stopReason` is `unavailableReason`'s): inconclusive, the provider's doing, never a
 * failure of the agent's.
 */
export function unavailableStop(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(UNAVAILABLE_PREFIX);
}
