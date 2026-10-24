import { links, parseRunsQuery, runsFilter, type RunsFilterRead } from '../../src/links.js';
import type { RunsQuery } from '../types.js';

/** The Runs page's requests as query strings, and the filter a link to it asks for. No DOM here: the tests import it. */

/** A query string from the Runs table's query: only what is set. */
export function runsQueryString(q: RunsQuery & { tz?: string; weeks?: number }): string {
  const p = new URLSearchParams();
  if (q.limit) p.set('limit', String(q.limit));
  if (q.cursor) p.set('cursor', q.cursor);
  if (q.from !== undefined && q.from !== null) p.set('from', String(q.from));
  if (q.to !== undefined && q.to !== null) p.set('to', String(q.to));
  if (q.types?.length) p.set('types', q.types.join(','));
  if (q.q?.trim()) p.set('q', q.q.trim());
  if (q.sort && q.sort !== 'when') p.set('sort', q.sort);
  if (q.tz) p.set('tz', q.tz);
  if (q.weeks) p.set('weeks', String(q.weeks));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * What a link to Runs asks it to show, as the page's address holds it: `#/runs?q=<words>&types=failed
 * &sort=spent&from=2026-10-20&to=2026-10-22` (`type=` too, as links wrote the chip before). Null for
 * a plain `#/runs`, one asking for nothing Runs knows, or another page's address.
 */
export function runsLinkQuery(hash: string): RunsFilterRead | null {
  const m = /^#\/runs\/?\?(.*)$/.exec(hash);
  return m ? parseRunsQuery(m[1]!) : null;
}

/** The link to Runs showing `f`: what the page writes into its address as its filter changes. */
export function runsHref(f: RunsFilterRead): string {
  return links.runs({ q: f.q, types: f.types, sort: f.sort, from: f.days?.from ?? null, to: f.days?.to ?? null });
}

/** Every run, as `#/runs` alone shows them. */
export const ALL_RUNS: RunsFilterRead = runsFilter();

/**
 * The instants a range of the viewer's days spans, for the table's request: the first day's start,
 * and the start of the day after the last, in the browser's time zone, the one the calendar's days
 * are worked out in. Null for a key that is no day.
 */
export function dayTimes(days: { from: string; to: string }): { from: number; to: number } | null {
  const at = (key: string, plus = 0) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plus).getTime() : NaN;
  };
  const from = at(days.from);
  const to = at(days.to, 1);
  return Number.isFinite(from) && Number.isFinite(to) && from < to ? { from, to } : null;
}
