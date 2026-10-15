import type { RunsQuery } from '../types.js';

/** The Runs page's requests as query strings. No DOM here: the tests import it. */

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
