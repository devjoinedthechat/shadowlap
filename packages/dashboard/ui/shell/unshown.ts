import { useLayoutEffect, useSyncExternalStore } from 'react';
import type { Route } from '../route.js';

/**
 * What the open page has found it can't show (a run or a fix that isn't there), by the page it is
 * (`run:<id>`, `fixes:<id>`, `compare:<a>/<b>`): the crumbs and the tab's title then name only the
 * section, as the design has them name only what the page shows. Until a page says so they name what
 * it opened for, so an open never flashes. The page notes it (`Unshown`); the top bar and the title
 * read it. A page that says another project holds it notes which (`heldBy`): the tab's title names
 * that project (`In support-agent`).
 */
let unshown: { at: string; heldBy: string | null } | null = null;
const heard = new Set<() => void>();

function note(next: { at: string; heldBy: string | null } | null): void {
  if (unshown?.at === next?.at && unshown?.heldBy === next?.heldBy) return;
  unshown = next;
  for (const fn of heard) fn();
}

function onUnshown(fn: () => void): () => void {
  heard.add(fn);
  return () => heard.delete(fn);
}

/** The page a route opens, as `Unshown` notes it: null for a page that names nothing of its own. */
export function unshownKey(route: Route): string | null {
  if ((route.page === 'run' || route.page === 'fixes') && route.id) return `${route.page}:${route.id}`;
  return route.page === 'compare' && route.a ? `compare:${route.a}/${route.b ?? ''}` : null;
}

/** Whether the page `at` names has said it can't show what it opened for. */
export function useUnshown(at: string | null): boolean {
  return useSyncExternalStore(onUnshown, () => at !== null && unshown?.at === at);
}

/** The project the page `at` names has said holds what it opened for, or null. */
export function useHeldBy(at: string | null): string | null {
  return useSyncExternalStore(onUnshown, () => (at !== null && unshown?.at === at ? unshown.heldBy : null));
}

/** Drawn by a page in place of what it can't show: until it goes, the crumbs and the title name only its section, or the project that holds it. */
export function Unshown({ at, heldBy = null }: { at: string; heldBy?: string | null }): null {
  useLayoutEffect(() => {
    note({ at, heldBy });
    return () => {
      if (unshown?.at === at) note(null);
    };
  }, [at, heldBy]);
  return null;
}
