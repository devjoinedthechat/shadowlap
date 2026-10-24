import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallRow, Client, RunDetail } from '../api.js';
import { useLatest } from '../hooks.js';
import { parseOrigins, type Origin7 } from '../origins.js';
import { isRead, nextRead, rangeOf, withPage, withRange, type Read } from './paging.js';

/**
 * A run's page with its calls read a page at a time (paging.ts): the run as the page reads it, its
 * calls those read so far, and, until every page is read, what the page knows of the rest. The page
 * that holds a call asked for (`need`) is read before the others; the others are read in order, one
 * after another, the first of them after a moment for what the page asks first (the selected call's
 * details). Once every page is read, the run is as an answer that held every call would have it.
 */

export interface Paging {
  /** How many calls the run has, and how many of them are read. */
  total: number;
  read: number;
  /** Every call's origin, from the run's page: the strip and the counts have them before the pages come. */
  origins: readonly Origin7[] | null;
  /** Reads the page that holds call `n` ahead of the rest, when it isn't read yet. */
  need: (n: number) => void;
  /** Why the last page could not be read; asking for a call again tries again. */
  error: string | null;
}

/** How long the pages after the first wait to start, so that what the page asks first goes first. */
export const PAGES_AFTER_MS = 250;

interface Pages {
  runId: string;
  calls: CallRow[];
  read: Read;
}

const none = (runId: string): Pages => ({ runId, calls: [], read: [] });

export function usePagedRun(client: Pick<Client, 'calls'>, run: RunDetail): { run: RunDetail; paging: Paging | null } {
  const runId = run.run.runId;
  const runNow = useLatest(runId);
  const whole = run.callsNext === null;
  const [pages, setPages] = useState<Pages>(() => none(runId));
  const own = pages.runId === runId ? pages : none(runId);
  // What the run's page came with is read: its first calls, up to where the next page starts.
  const read = useMemo<Read>(() => (whole ? [[1, Infinity]] : withRange(own.read, 1, run.callsNext! - 1)), [whole, own.read, run.callsNext]);
  const calls = useMemo(() => (own.calls.length ? withPage(own.calls, run.calls) : run.calls), [own.calls, run.calls]);
  const done = whole || nextRead(read, null) === null;
  const origins = useMemo(() => (done ? null : parseOrigins(run.origins)), [done, run.origins]);

  const [wanted, setWanted] = useState<{ runId: string; n: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readNow = useLatest(read);
  const need = useCallback(
    (n: number) => {
      if (isRead(readNow.current, n)) return;
      setError(null);
      setWanted((w) => (w?.runId === runId && w.n === n ? w : { runId, n }));
    },
    [runId, readNow],
  );

  // The page to read next: the one asked for, else the first not read.
  const want = wanted?.runId === runId && !isRead(read, wanted.n) ? wanted.n : null;
  const ask = done || error ? null : nextRead(read, want);
  const from = ask?.from ?? null;
  const limit = ask?.limit ?? null;
  const wait = want !== null || own.read.length ? 0 : PAGES_AFTER_MS;
  // A page on its way is not asked for again; one that arrives for a run left meanwhile is dropped.
  const flying = useRef(new Set<string>());
  useEffect(() => {
    if (from === null || limit === null) return;
    const key = `${runId}:${from}:${limit}`;
    if (flying.current.has(key)) return;
    const t = setTimeout(() => {
      flying.current.add(key);
      client.calls(runId, from, limit).then(
        (page) => {
          flying.current.delete(key);
          if (runNow.current !== runId) return;
          setPages((p) => {
            const mine = p.runId === runId ? p : none(runId);
            return { runId, calls: withPage(mine.calls, page.calls), read: withRange(mine.read, ...rangeOf(from, page)) };
          });
        },
        (err: unknown) => {
          flying.current.delete(key);
          if (runNow.current === runId) setError(err instanceof Error ? err.message : String(err));
        },
      );
    }, wait);
    return () => clearTimeout(t);
  }, [client, runId, runNow, from, limit, wait]);

  const shown = useMemo<RunDetail>(() => {
    if (whole) return run;
    if (!done) return calls === run.calls ? run : { ...run, calls };
    // Every page read: the run as an answer that held every call would have it.
    const { origins: _origins, ...rest } = run;
    void _origins;
    return { ...rest, calls, callsNext: null };
  }, [whole, done, run, calls]);
  const paging = useMemo<Paging | null>(() => (done ? null : { total: run.callsTotal, read: calls.length, origins, need, error }), [done, run.callsTotal, calls.length, origins, need, error]);
  return { run: shown, paging };
}
