import type { HeldWhat } from '../src/cross-project.js';
import type { Route } from './route.js';

/**
 * A link into another project, decided without the DOM: what a route names that another project's
 * store may hold (`heldAsk`), and the words of the page that says which project holds it
 * (`elsewhereWords`, pages/Elsewhere.tsx). The tests import it.
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

/** A part of the page's line: the id in mono, kept whole, and each project's possessive kept whole. */
export interface LinePart {
  text: string;
  face?: 'id' | 'nw';
}

export interface ElsewhereWords {
  /** Over the title: this project, and what the page is. */
  eyebrow: string;
  title: string;
  line: LinePart[];
}

/**
 * The page that says another project holds what the link names: `support-agent · in another
 * project`, *In triage-bot*, and `The fix fx-01K… is in triage-bot’s store, not support-agent’s.`
 * `current` is the project the server answered for, so the line never names one it has left.
 */
export function elsewhereWords(o: { what: HeldWhat; id: string; holder: string; current: string }): ElsewhereWords {
  return {
    eyebrow: `${o.current} · in another project`,
    title: `In ${o.holder}`,
    line: [{ text: `The ${o.what} ` }, { text: o.id, face: 'id' }, { text: ' is in ' }, { text: `${o.holder}’s`, face: 'nw' }, { text: ' store, not ' }, { text: `${o.current}’s`, face: 'nw' }, { text: '.' }],
  };
}

/** The line as one text, as a screen reader reads it. */
export function lineText(line: readonly LinePart[]): string {
  return line.map((p) => p.text).join('');
}
