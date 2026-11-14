import { backoffSeconds } from './backoff.js';

/**
 * Whether the page can talk to its server, as a small state machine. Offline, it tries again when a
 * deadline passes, 5, 10, 20, then every 30 seconds apart; Retry now tries at once. A 401 means the
 * link expired: nothing is tried again. The `?state=offline` preview runs the same countdown through
 * the same schedule without reconnecting, so it stays offline until Retry now. No DOM here: the
 * tests import it.
 */

/** Why anything that needs the server waits while it can't be reached: a waiting control, its toast, the palette, a settings write. */
export const PAUSED = 'Paused until the dashboard server is back';

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

/**
 * The seconds the bar counts down: "Retrying in 7s". Never more than the wait itself: the page's clock
 * ticks four times a second, so it can be a moment behind the deadline just set.
 */
export function secondsLeft(s: ConnState, now: number): number {
  const wait = backoffSeconds(s.attempt);
  if (s.retryAt === null) return wait;
  return Math.min(wait, Math.max(0, Math.ceil((s.retryAt - now) / 1000)));
}

/**
 * Whether what changed since the last look means reloading the run list (and the open run with it):
 * the first look, a run added, ended or changed, or a call recorded. A server that only says whether
 * anything changed is taken at its word; one that names what moved is not reloaded for a job's
 * output or an activity entry.
 */
export function reloadFor(ch: { changed?: boolean; runs?: boolean; calls?: boolean }, first: boolean): boolean {
  return feedMoves(ch, first) !== null;
}

/**
 * What moved since the last look, as the page reloads for it: `runs` (a run added, ended or
 * changed, or a server that doesn't say what moved), which loads the run list again and every view
 * keyed on it; `calls`, only calls recorded, which means the recordings that are growing (the change
 * feed names each with its counts) and nothing else; or nothing a run view shows.
 */
export function feedMoves(ch: { changed?: boolean; runs?: boolean; calls?: boolean }, first: boolean): 'runs' | 'calls' | null {
  if (first) return 'runs';
  if (ch.runs !== undefined || ch.calls !== undefined) return ch.runs ? 'runs' : ch.calls ? 'calls' : null;
  return ch.changed !== false ? 'runs' : null;
}

/**
 * The feeds besides the runs that moved since the last look, by name, for the pages that read them to
 * load again: `jobs`, `events` (an activity entry stored, such as a normalizer added, with no run
 * changed), and each feature's table the change feed names in `other`. None on the first look, which
 * every page loads for anyway.
 */
export function feedsMoved(ch: { jobs?: boolean; events?: boolean; other?: readonly string[] }, first: boolean): string[] {
  if (first) return [];
  return [...(ch.jobs ? ['jobs'] : []), ...(ch.events ? ['events'] : []), ...(ch.other ?? [])];
}

/**
 * The run list with each recording's call count as the change feed has it now: when only calls
 * moved, the list itself is not asked for again. The same list when no count moved.
 */
export function withLiveCalls<R extends { runId: string; calls: number }>(runs: readonly R[] | null, live: readonly { runId: string; calls: number }[]): readonly R[] | null {
  if (!runs) return runs;
  const now = new Map(live.map((l) => [l.runId, l.calls]));
  let changed = false;
  const out = runs.map((r) => {
    const calls = now.get(r.runId);
    if (calls === undefined || calls === r.calls) return r;
    changed = true;
    return { ...r, calls };
  });
  return changed ? out : runs;
}

/**
 * What a run's page loads again on: the run list moving (`runsTick`: a run started, ended or
 * changed, which may be this one or its family), and while it records, its own call events (a call
 * started or answered). Another run recording moves neither.
 */
export function runRefresh(runsTick: number, live: { calls: number; events?: number } | null | undefined): string {
  return live ? `${runsTick}:${live.events ?? live.calls}` : String(runsTick);
}

/**
 * Where the change feed stands, to ask from next time: its cursor, or a version from a server that
 * keeps one. The page asks for it before it loads the run list (at the start, after reconnecting,
 * after switching projects), so the first poll after a load reloads only for what moved since,
 * rather than everything the page has just loaded and is still loading.
 */
export function feedCursor(ch: { cursor?: string; version?: string | number } | null): string | null {
  if (!ch) return null;
  return ch.cursor ?? (ch.version !== undefined ? String(ch.version) : null);
}

/** What a run's family (Forks) loads again on: the run list moving, and the calls of each run of the family that records. */
export function familyRefresh(runsTick: number, live: readonly { runId: string; calls: number }[], family: ReadonlySet<string>): string {
  const growing = live.filter((l) => family.has(l.runId)).map((l) => `${l.runId}:${l.calls}`);
  return growing.length ? `${runsTick}|${growing.join(',')}` : String(runsTick);
}

/** The hosts a dashboard's link names: it listens on the loopback interface only. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The link a dashboard printed, pasted on the card a refused session token shows: where to go with
 * it. The same server (this page's origin): its fragment, which the page reads the token from and
 * starts again with. Another one (the dashboard came back on another port): the whole link. Null for
 * anything else, so text from the clipboard never sends the page anywhere but a dashboard on this
 * machine.
 */
export function pastedLink(text: string, origin: string): { kind: 'hash'; hash: string } | { kind: 'go'; url: string } | null {
  const t = text.trim();
  if (!/^https?:\/\//i.test(t) || /\s/.test(t)) return null;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password) return null;
  if (!/(?:^#|&)token=[A-Za-z0-9_-]+/.test(url.hash)) return null;
  return url.origin === origin ? { kind: 'hash', hash: url.hash } : { kind: 'go', url: url.href };
}
