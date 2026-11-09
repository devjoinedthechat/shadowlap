import type { HeldWhat } from '../src/cross-project.js';
import type { Route } from './route.js';

/**
 * A link into another project, decided without the DOM: what a route names that another project's
 * store may hold. The page list asks it for a link into a project that can't be opened
 * (pages/lazy.tsx), so it is in the first look, and the words of the page that says which project holds it are in
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
 * step), or Compare's runs, the ones the address gives. Null for a page that names nothing of its own.
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
    default:
      return null;
  }
}
