import { useSyncExternalStore } from 'react';
import type { HeldWhat } from '../src/cross-project.js';
import type { Route } from './route.js';

/**
 * A link into another project, decided without the DOM: what a route names that another project's
 * store may hold. The page list asks it for a link into a project with no runs yet (pages/lazy.tsx),
 * so it is in the first look, and the words of the page that says which project holds it are in
 * held-words.ts, which only that page loads. The tests import both.
 */

export type { HeldWhat };

/** What a page asks the server for (`client.projects.holding`): the kind, and the ids its address names. */
export interface HeldAsk {
  what: HeldWhat;
  ids: string[];
}

/**
 * What the route names that another project may hold: a run (any of its calls or views), a fix (any
 * step), Compare's runs, the ones the address gives, or a preview on its own tab (at any run or cell).
 * Null for a page that names nothing of its own: a revision is every project's, and a migration's
 * address opens Verdicts until its tab lands.
 */
export function heldAsk(route: Route): HeldAsk | null {
  switch (route.page) {
    case 'run':
      return { what: 'run', ids: [route.id] };
    case 'fixes':
      return route.id ? { what: 'fix', ids: [route.id] } : null;
    case 'compare': {
      const ids = [...new Set([route.a, route.b].filter((id): id is string => !!id))];
      return ids.length ? { what: 'run', ids } : null;
    }
    case 'changes':
      return route.tab === 'decisions' && route.id ? { what: 'preview', ids: [route.id] } : null;
    default:
      return null;
  }
}

/**
 * What a tab under a page's head found missing, by the address it was at: the page then draws the
 * page that asks which project holds it in place of its head and tabs, as that page takes the page
 * whole (pages/Changes.tsx, for Preview's session). The tab unmounts as it draws, so the note outlives
 * it: one that went with the tab would draw the tab again, which would read, find it missing and note
 * it again, round and round. Only the page clears it, as its address moves on or it reads again.
 */
let missing: { at: string; error: Error } | null = null;
const heard = new Set<() => void>();

function told(next: { at: string; error: Error } | null): void {
  missing = next;
  for (const fn of heard) fn();
}

function onMissing(fn: () => void): () => void {
  heard.add(fn);
  return () => heard.delete(fn);
}

/** The tab at `at` couldn't find what its address names, its read failing with `error`; noted once. */
export function noteMissing(at: string, error: Error): void {
  if (missing?.at !== at) told({ at, error });
}

/** The page at `at` reads again, or its address moved on: what its tab found missing is forgotten. */
export function clearMissing(at: string): void {
  if (missing?.at === at) told(null);
}

/** The read that found missing what the page at `at` names, or null: a note at another address doesn't count. */
export function useMissing(at: string): Error | null {
  return useSyncExternalStore(onMissing, () => (missing?.at === at ? missing.error : null));
}
