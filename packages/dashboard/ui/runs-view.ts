import { useSyncExternalStore } from 'react';
import type { RunsFilterRead } from '../src/links.js';
import { ALL_RUNS, runsHref } from './runspage/query.js';

/**
 * The view Runs showed last while the dashboard is open, as its address says it: where the nav's
 * Runs, the crumbs, `g r`, Search or jump to's Runs and a cold Esc open it, so a run opened and
 * closed lands back on the same view. A link to `#/runs` alone (the sidebar's `all`, the Overview's)
 * opens every run. Small, with no page in it: the shell imports it.
 */

let last = runsHref(ALL_RUNS);
const heard = new Set<() => void>();

/** Notes the view Runs shows now. */
export function keepRunsView(f: RunsFilterRead): void {
  const href = runsHref(f);
  if (href === last) return;
  last = href;
  for (const fn of [...heard]) fn();
}

/** The view Runs showed last, `#/runs` until it has shown one. */
export function lastRunsHref(): string {
  return last;
}

/** Where a link to Runs alone that stands for the page (the nav's, a `g` key's) goes: the view it showed last. */
export function lastViewOf(to: string): string {
  return to === runsHref(ALL_RUNS) ? last : to;
}

const listen = (fn: () => void) => {
  heard.add(fn);
  return () => void heard.delete(fn);
};

/** The view Runs showed last, for a link drawn beside Runs as its view changes: the nav's. */
export function useLastRunsHref(): string {
  return useSyncExternalStore(listen, lastRunsHref, lastRunsHref);
}
