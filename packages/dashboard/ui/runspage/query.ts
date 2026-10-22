import type { RunChip } from '../runs.js';
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

/** The chips a link can pick: Local is where Needs a look's Push leads. */
const LINK_CHIPS: readonly RunChip[] = ['all', 'recording', 'fork', 'clean', 'test', 'capture', 'failed', 'local'];

/**
 * What a link to Runs asks it to show: `#/runs?q=<words>&type=failed`, as an import's drawer links
 * the runs it made and Needs a look the failed runs and the runs only here (`type=local`). Null for a
 * plain `#/runs`, or one asking for nothing Runs knows.
 */
export function runsLinkQuery(hash: string): { q: string; chip: RunChip } | null {
  const m = /^#\/runs\/?\?(.*)$/.exec(hash);
  if (!m) return null;
  const p = new URLSearchParams(m[1]);
  const q = (p.get('q') ?? '').slice(0, 200);
  const type = p.get('type');
  const chip = LINK_CHIPS.find((c) => c === type) ?? null;
  if (!q.trim() && !chip) return null;
  return { q, chip: chip ?? 'all' };
}
