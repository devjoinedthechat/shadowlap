import { useLayoutEffect, useSyncExternalStore } from 'react';

/**
 * What the open page has found it can't show (a run, a fix or a revision that isn't there), by the
 * page it is (`run:<id>`, `fixes:<id>`, `changes:<rev>`): the crumbs and the tab's title then name only the section, as the
 * design has them name only what the page shows. Until a page says so they name what it opened for,
 * so an open never flashes. The page notes it (`Unshown`); the top bar and the title read it.
 */
let unshown: string | null = null;
const heard = new Set<() => void>();

function note(at: string | null): void {
  if (unshown === at) return;
  unshown = at;
  for (const fn of heard) fn();
}

function onUnshown(fn: () => void): () => void {
  heard.add(fn);
  return () => heard.delete(fn);
}

/** The page a route opens, as `Unshown` notes it: null for a page that names nothing of its own. */
export function unshownKey(route: { page: string; id?: string | null }): string | null {
  return (route.page === 'run' || route.page === 'fixes' || route.page === 'changes') && route.id ? `${route.page}:${route.id}` : null;
}

/** Whether the page `at` names has said it can't show what it opened for. */
export function useUnshown(at: string | null): boolean {
  return useSyncExternalStore(onUnshown, () => at !== null && unshown === at);
}

/** Drawn by a page in place of what it can't show: until it goes, the crumbs and the title name only its section. */
export function Unshown({ at }: { at: string }): null {
  useLayoutEffect(() => {
    note(at);
    return () => {
      if (unshown === at) note(null);
    };
  }, [at]);
  return null;
}
