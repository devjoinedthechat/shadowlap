import type { Store } from '@shadowlap/engine';
import { liveRuns } from './meta.js';
import type { ChangesView } from './views.js';

/**
 * The change feed behind `GET /api/changes?since=<cursor>`. The cursor carries the store's write
 * counters (`Store.changeCounts`: runs, call events, activity events, and any table a feature
 * counts) and the job manager's version, tagged with the server instance, so a browser polls one
 * tiny endpoint and refetches only what moved. Counters kept by triggers see every writer: the CLI,
 * the sidecar recording a run, another dashboard.
 */

const NAMED = ['runs', 'calls', 'events', 'jobs'] as const;

interface Cursor {
  /** The server instance: a cursor from before a restart means everything changed. */
  b: string;
  c: Record<string, number>;
}

function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decode(text: string | null | undefined): Cursor | null {
  if (!text || text.length > 4096) return null;
  try {
    const v = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof v.b !== 'string' || typeof v.c !== 'object' || v.c === null) return null;
    return { b: v.b, c: v.c };
  } catch {
    return null;
  }
}

export function changesView(store: Store, o: { boot: string; jobsVersion: number; since?: string | null }): ChangesView {
  const counts: Record<string, number> = { ...store.changeCounts(), jobs: o.jobsVersion };
  const cursor = encode({ b: o.boot, c: counts });
  const prev = decode(o.since);
  const fresh = !prev || prev.b !== o.boot;
  const moved = (name: string) => fresh || prev.c[name] !== counts[name];
  const other = Object.keys(counts)
    .filter((k) => !(NAMED as readonly string[]).includes(k) && moved(k))
    .sort();
  const view: ChangesView = {
    cursor,
    changed: false,
    runs: moved('runs'),
    calls: moved('calls'),
    events: moved('events'),
    jobs: moved('jobs'),
    other,
    live: liveRuns(store),
  };
  view.changed = fresh || view.runs || view.calls || view.events || view.jobs || other.length > 0;
  return view;
}
