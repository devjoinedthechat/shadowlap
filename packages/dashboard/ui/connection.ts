import { backoffSeconds } from './backoff.js';

/**
 * Whether the page can talk to its server, as a small state machine. Offline, it tries again when a
 * deadline passes, 5, 10, 20, then every 30 seconds apart; Retry now tries at once. A 401 means the
 * link expired: nothing is tried again. The `?state=offline` preview runs the same countdown through
 * the same schedule without reconnecting, so it stays offline until Retry now. No DOM here: the
 * tests import it.
 */

export type Conn = 'ok' | 'offline' | 'expired';

export interface ConnState {
  conn: Conn;
  /** Tries that failed since the server went away: which wait comes next. */
  attempt: number;
  /** When the next try is due (epoch ms), while offline. */
  retryAt: number | null;
  /** The `?state=offline` preview: the countdown runs, and only Retry now reconnects. */
  preview: boolean;
}

export type ConnEvent =
  /** A request got no answer (or a gateway error). */
  | { type: 'unreachable'; now: number }
  /** A request was refused for its session token. */
  | { type: 'expired' }
  /** The deadline passed in the preview: the countdown moves on to the next wait. */
  | { type: 'due'; now: number }
  /** A try failed: wait longer. */
  | { type: 'retry-failed'; now: number }
  /** The server answered again. */
  | { type: 'reconnected' };

export function connStart(preview: 'offline' | 'expired' | null): ConnState {
  return { conn: preview === 'expired' ? 'expired' : 'ok', attempt: 0, retryAt: null, preview: preview === 'offline' };
}

export function connStep(s: ConnState, e: ConnEvent): ConnState {
  switch (e.type) {
    case 'unreachable':
      if (s.conn === 'expired' || s.conn === 'offline') return s;
      return { ...s, conn: 'offline', attempt: 0, retryAt: e.now + backoffSeconds(0) * 1000 };
    case 'expired':
      return { ...s, conn: 'expired', retryAt: null };
    case 'due':
    case 'retry-failed':
      if (s.conn !== 'offline') return s;
      return { ...s, attempt: s.attempt + 1, retryAt: e.now + backoffSeconds(s.attempt + 1) * 1000 };
    case 'reconnected':
      return { conn: 'ok', attempt: 0, retryAt: null, preview: false };
  }
}

/** What the countdown does when its clock ticks: nothing yet, try to reconnect, or (in the preview) move on to the next wait. */
export function onTick(s: ConnState, now: number, busy: boolean): 'wait' | 'try' | 'advance' {
  if (s.conn !== 'offline' || busy || s.retryAt === null || now < s.retryAt) return 'wait';
  return s.preview ? 'advance' : 'try';
}

/** The seconds the bar counts down: "Retrying in 7s". */
export function secondsLeft(s: ConnState, now: number): number {
  if (s.retryAt === null) return backoffSeconds(s.attempt);
  return Math.max(0, Math.ceil((s.retryAt - now) / 1000));
}

/**
 * Whether what changed since the last look means reloading the run list (and the open run with it):
 * the first look, a run added, ended or changed, or a call recorded. A server that only says whether
 * anything changed is taken at its word; one that names what moved is not reloaded for a job's
 * output or an activity entry.
 */
export function reloadFor(ch: { changed?: boolean; runs?: boolean; calls?: boolean }, first: boolean): boolean {
  if (first) return true;
  if (ch.runs !== undefined || ch.calls !== undefined) return !!ch.runs || !!ch.calls;
  return ch.changed !== false;
}
