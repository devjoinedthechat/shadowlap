import type { HeldWhat } from './held.js';

/**
 * The words of the page that says another project holds what a link names (pages/Elsewhere.tsx),
 * decided without the DOM: only that page loads them. The tests import it.
 */

/** A part of the page's line: the id in mono, kept whole, and each project's possessive kept whole. */
export interface LinePart {
  text: string;
  face?: 'id' | 'nw';
}

export interface ElsewhereWords {
  /** Over the title: this project, and what the page is. */
  eyebrow: string;
  /** `In triage-bot`, the project's name kept whole. */
  title: LinePart[];
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
    title: [{ text: 'In ' }, { text: o.holder, face: 'nw' }],
    line: [{ text: `The ${o.what} ` }, { text: o.id, face: 'id' }, { text: ' is in ' }, { text: `${o.holder}’s`, face: 'nw' }, { text: ' store, not ' }, { text: `${o.current}’s`, face: 'nw' }, { text: '.' }],
  };
}

/** The parts as one text, as a screen reader reads them. */
export function lineText(line: readonly LinePart[]): string {
  return line.map((p) => p.text).join('');
}
