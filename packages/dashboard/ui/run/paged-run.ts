import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type CallRow, type Client, type RunDetail } from '../api.js';
import { useLatest } from '../hooks.js';
import { parseOrigins, type Origin7 } from '../origins.js';
import { isRead, nextRead, rangeOf, withPage, withRange, type Read } from './paging.js';

/**
 * A run's page with its calls read a page at a time (paging.ts): the run as the page reads it, its
 * calls those read so far, and, until every page is read, what the page knows of the rest. The page
 * that holds a call asked for (`need`) is read before the others; the others are read in order, one
 * after another, the first of them after a moment for what the page asks first (the selected call's
 * details). Once every page is read, the run is as an answer that held every call would have it.
 *
 * A page on its way counts as read when the next is picked, so a call it holds is never asked for
 * again and no two pages overlap; the pages read in order wait for it. Scrolling asks for a call at
 * every step: while a page is on its way, the call asked for waits for the window to settle
 * (`NEED_SETTLE_MS`), so only where it stops is read, at most two pages are on their way at once, and
 * the pages read in order wait until the window has stopped a moment (`ASKING_PAUSE_MS`).
 * A jump into a 20,000-call run and a scroll after it asked for 44 overlapping pages, 16.9 MB.
 *
 * Deep in a long run the server is still analysing, the page of a call asked for comes at once from
 * the calls around it (`around`), its conversations not numbered yet; the pages read in order ask for
 * the whole analysis (`whole`), so they read such a page again with every fact once it is done.
 *
 * A page that could not be read is tried again after a second, then two, up to thirty, however the
 * window asks meanwhile; a call picked (`need(n, { pick: true })`) tries at once. A run the server no
 * longer has (404) is read no further: with the server stopped the page asked 178 times in 5 s.
 */

export interface Paging {
  /** How many calls the run has, and how many of them are read. */
  total: number;
  read: number;
  /** Every call's origin, from the run's page: the strip and the counts have them before the pages come. */
  origins: readonly Origin7[] | null;
  /**
   * Reads the page that holds call `n` ahead of the rest, when it isn't read yet. While a page could
   * not be read, only a call picked (`pick`, the selection) tries again at once; the window waits.
   */
  need: (n: number, o?: { pick?: boolean }) => void;
  /** Why the last page could not be read: it is tried again after a moment, or at once for a call picked. */
  error: string | null;
  /** The run is no longer in the store: nothing more is read. */
  gone: boolean;
}

/** How long the pages after the first wait to start, so that what the page asks first goes first. */
export const PAGES_AFTER_MS = 250;
/** How long a call asked for while a page is on its way waits for the window to settle before its page is asked for. */
export const NEED_SETTLE_MS = 90;
/** At most this many pages on their way at once: a call asked for may go beside one other. */
export const IN_FLIGHT = 2;
/** How long the pages read in order wait after a call not read was last asked for: while the window moves, only what it shows is read. */
export const ASKING_PAUSE_MS = 600;
/** After a page could not be read, the next try waits this long, doubled each time it fails again, up to `RETRY_MAX_MS`. */
export const RETRY_MS = 1000;
export const RETRY_MAX_MS = 30_000;

/** Why the pages stopped: the last failure, how many in a row, whether the next try waits, and whether the run is gone. */
interface Failure {
  runId: string;
  message: string;
  tries: number;
  waiting: boolean;
  gone: boolean;
}

interface Pages {
  runId: string;
  calls: CallRow[];
  read: Read;
  /** What is read with every fact the whole run's analysis gives: all of `read` but the pages that came from the calls around them. */
  exact: Read;
  /** The pages on their way, as the calls each was asked for: counted as read when the next is picked. */
  flight: ReadonlyArray<readonly [number, number]>;
}

const none = (runId: string): Pages => ({ runId, calls: [], read: [], exact: [], flight: [] });

/** What is read with the pages on their way counted in. */
const withFlight = (read: Read, flight: Pages['flight']): Read => flight.reduce<Read>((x, [a, b]) => withRange(x, a, b), read);

/** The pages on their way with one taken off, once it came or failed. */
const landed = (flight: Pages['flight'], range: readonly [number, number]) => flight.filter((f) => f !== range);

export function usePagedRun(client: Pick<Client, 'calls'>, run: RunDetail): { run: RunDetail; paging: Paging | null } {
  const runId = run.run.runId;
  const runNow = useLatest(runId);
  const whole = run.callsNext === null;
  const [pages, setPages] = useState<Pages>(() => none(runId));
  const own = pages.runId === runId ? pages : none(runId);
  // What the run's page came with is read: its first calls, up to where the next page starts.
  const read = useMemo<Read>(() => (whole ? [[1, Infinity]] : withRange(own.read, 1, run.callsNext! - 1)), [whole, own.read, run.callsNext]);
  const exact = useMemo<Read>(() => (whole ? [[1, Infinity]] : withRange(own.exact, 1, run.callsNext! - 1)), [whole, own.exact, run.callsNext]);
  const calls = useMemo(() => (own.calls.length ? withPage(own.calls, run.calls) : run.calls), [own.calls, run.calls]);
  const done = whole || nextRead(exact, null) === null;
  const origins = useMemo(() => (done ? null : parseOrigins(run.origins)), [done, run.origins]);

  const [wanted, setWanted] = useState<{ runId: string; n: number } | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);
  const failure = failed?.runId === runId ? failed : null;
  const readNow = useLatest(read);
  /** When a call not read was last asked for: the pages read in order wait a moment after it. */
  const askedAt = useRef(0);
  const need = useCallback(
    (n: number, o: { pick?: boolean } = {}) => {
      if (isRead(readNow.current, n)) return;
      askedAt.current = Date.now();
      // A call picked tries again at once; what the window asks waits for the next try.
      if (o.pick) setFailed((f) => (f?.runId === runId && f.waiting && !f.gone ? { ...f, waiting: false } : f));
      setWanted((w) => (w?.runId === runId && w.n === n ? w : { runId, n }));
    },
    [runId, readNow],
  );
  // The next try after a failure, a second later, then two, up to thirty.
  const waiting = failure?.waiting === true && !failure.gone;
  const tries = failure?.tries ?? 0;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setFailed((f) => (f?.runId === runId && f.waiting ? { ...f, waiting: false } : f)), Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** Math.max(0, tries - 1)));
    return () => clearTimeout(t);
  }, [waiting, tries, runId]);

  // The page to read next: the one that holds the call asked for, else the first not read with every
  // fact; a page on its way counts as read, so none is asked for twice and none overlaps another.
  const flight = own.flight;
  const planned = useMemo<Read>(() => withFlight(read, flight), [read, flight]);
  const plannedExact = useMemo<Read>(() => withFlight(exact, flight), [exact, flight]);
  const want = wanted?.runId === runId && !isRead(planned, wanted.n) ? wanted.n : null;
  const ask = done || failure?.gone || waiting ? null : want !== null ? nextRead(planned, want) : nextRead(plannedExact, null);
  const from = ask?.from ?? null;
  const limit = ask?.limit ?? null;
  // The pages read in order ask for every fact, waiting for the whole analysis when it is under way.
  const exactly = want === null;
  // A call asked for goes beside one page on its way, once the window settles; the pages read in order
  // go one at a time, the first of them after a moment for what the page asks first.
  const go = want !== null ? flight.length < IN_FLIGHT : flight.length === 0;
  const wait = want !== null ? (flight.length ? NEED_SETTLE_MS : 0) : own.read.length ? 0 : PAGES_AFTER_MS;
  useEffect(() => {
    if (!go || from === null || limit === null) return;
    // The pages read in order give way while the window moves: it asks for a call at every step.
    const delay = exactly ? Math.max(wait, askedAt.current + ASKING_PAUSE_MS - Date.now()) : wait;
    const t = setTimeout(() => {
      const range = [from, from + limit - 1] as const;
      setPages((p) => {
        const mine = p.runId === runId ? p : none(runId);
        return { ...mine, flight: [...mine.flight, range] };
      });
      client.calls(runId, from, limit, exactly ? { whole: true } : undefined).then(
        (page) => {
          // One that arrives for a run left meanwhile is dropped.
          if (runNow.current !== runId) return;
          setPages((p) => {
            const mine = p.runId === runId ? p : none(runId);
            const got = rangeOf(from, page);
            return { runId, calls: withPage(mine.calls, page.calls), read: withRange(mine.read, ...got), exact: page.around ? mine.exact : withRange(mine.exact, ...got), flight: landed(mine.flight, range) };
          });
          setFailed((f) => (f?.runId === runId ? null : f));
        },
        (err: unknown) => {
          if (runNow.current !== runId) return;
          setPages((p) => (p.runId === runId ? { ...p, flight: landed(p.flight, range) } : p));
          const gone = err instanceof ApiError && err.status === 404;
          const message = err instanceof Error ? err.message : String(err);
          setFailed((f) => ({ runId, message, tries: (f?.runId === runId ? f.tries : 0) + 1, waiting: true, gone }));
        },
      );
    }, delay);
    return () => clearTimeout(t);
  }, [client, runId, runNow, from, limit, wait, go, exactly]);

  const shown = useMemo<RunDetail>(() => {
    if (whole) return run;
    if (!done) return calls === run.calls ? run : { ...run, calls };
    // Every page read: the run as an answer that held every call would have it.
    const { origins: _origins, ...rest } = run;
    void _origins;
    return { ...rest, calls, callsNext: null };
  }, [whole, done, run, calls]);
  const error = failure?.message ?? null;
  const gone = failure?.gone === true;
  const paging = useMemo<Paging | null>(() => (done ? null : { total: run.callsTotal, read: calls.length, origins, need, error, gone }), [done, run.callsTotal, calls.length, origins, need, error, gone]);
  return { run: shown, paging };
}
