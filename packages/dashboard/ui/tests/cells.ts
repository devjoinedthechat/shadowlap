import type { GoldenRow, HistoryCell, HistoryDrop, RevisionFact } from '../types.js';

/**
 * Tests' history in words, no DOM (the tests import it): a revision's label and hover, a cell's hover
 * card and its name for a screen reader, and the key under the table. A cell is a dot for one attempt
 * or a 24px bar filled to the share that passed for several, in the verdict's colour; a ring in ink
 * where the golden was updated, a red ring where its gate against history found a drop.
 */

/** A no-break space: a figure and its words stay on one line. */
const NB = ' ';
const nb = (s: string) => s.replace(/ /g, NB);

/** A cell's colour, and its hover's row: the verdict's (`--cq-*`), the hairline's where it has no result. */
const CELL_COLOR: Readonly<Record<NonNullable<HistoryCell['verdict']>, string>> = { passed: 'var(--cq-lime)', failed: 'var(--cq-red)', inconclusive: 'var(--cq-amber)' };

/** A revision's hover: its commit's subject, and who made it where names show; a session with none says why. */
export function revisionTip(rev: string | null, fact: RevisionFact | undefined): { t: string; s?: string } {
  if (!rev) return { t: 'no revision', s: 'This session recorded no revision: it ran outside a git repository' };
  return { t: fact?.subject ? `${rev} · ${fact.subject}` : rev, ...(fact?.by ? { s: fact.by } : {}) };
}

/** What a gate against history compared, where it found a drop: `a drop against 0.94 over its last 10 sessions (47 of 50; 4 of them are columns here, 20 of 20)`. */
function dropWords(d: HistoryDrop): string {
  if (!d.history) return 'a drop against its recording (no history yet)';
  const over = d.history.sessions > 1 ? `its last ${d.history.sessions} sessions` : 'its last session';
  const here = d.here.sessions ? `; ${nb(`${d.here.sessions} of them`)} ${d.here.sessions === 1 ? 'is a column' : 'are columns'} here, ${d.here.passes} of ${d.here.attempts}` : '';
  return `a drop against ${d.baseline.toFixed(2)} over ${over} (${d.history.passes} of ${d.history.attempts}${here})`;
}

/** A cell's card and name: its title, its word in its colour, what it says of it, and the whole as a screen reader hears it. */
export interface CellNote {
  /** `d2e8a1f · refund-flow`. */
  title: string;
  /** passed, failed, inconclusive, or `not tested here`. */
  word: string;
  note: string;
  color: string;
  /** `d2e8a1f: failed, 4 of 8 attempts passed · rate <= 0.87 (95%)`. */
  label: string;
}

/**
 * How a golden did at one revision, in its cell's hover and name: run again with changes on top of
 * that commit; for several attempts, how many passed and the bound its gate put on the pass rate; a
 * drop's baseline; an update there, with the reason it kept; and why it failed, or a connection the network guard blocked in
 * a replay that passed.
 */
export function cellNote(cell: HistoryCell, name: string): CellNote {
  const rev = cell.revision ?? 'no revision';
  const word = cell.verdict ?? 'not tested here';
  const parts: string[] = [];
  // Run again on its own with changes on top of this commit (Add normalizer and re-run): said, as it isn't the commit alone.
  if (cell.tested && cell.tested !== cell.revision) parts.push(`run again at ${cell.tested}`);
  if (cell.rate && (cell.rate.attempts > 1 || cell.verdict === 'inconclusive')) parts.push(`${cell.rate.passes} of ${cell.rate.attempts} attempts passed${cell.bound ? ` · ${cell.bound}` : ''}`);
  if (cell.drop) parts.push(dropWords(cell.drop));
  if (cell.updated) parts.push(cell.result === 'pass' ? 'updated here: re-recorded, its checks passed' : `updated here, then ${cell.note ?? 'failed'}`);
  // Why, where the update kept a reason (`test --update --reason`).
  if (cell.updated && cell.reason) parts.push(`why: ${cell.reason}`);
  if (cell.note && !(cell.updated && cell.result !== 'pass')) parts.push(cell.note);
  // A judge's why keeps "no recorded verdict" whole, as its check's line does.
  const note = parts.join(' · ').replace(/\bno recorded verdict\b/g, nb('no recorded verdict'));
  return { title: `${rev} · ${name}`, word, note, color: cell.verdict ? CELL_COLOR[cell.verdict] : 'var(--line2)', label: `${rev}: ${word}${note ? `, ${note}` : ''}` };
}

/** A cell's class by its verdict: `pass`, `fail`, `inc` (inconclusive told apart), `none` with no result. */
export const cellVerdict = (cell: HistoryCell): 'pass' | 'fail' | 'inc' | 'none' => (cell.verdict === 'inconclusive' ? 'inc' : (cell.result ?? 'none'));

/** A cell of several attempts is a bar filled to the share that passed: that share, 0 to 1; null for one attempt, a dot. */
export const cellShare = (cell: HistoryCell): number | null => (cell.rate && cell.rate.attempts > 1 ? cell.rate.passes / cell.rate.attempts : null);

/** The key to By revision's cells, only those the table shows, in this order. */
export type KeyPart = 'dot' | 'bar' | 'none' | 'upd' | 'drop';

export const KEY_WORDS: Readonly<Record<KeyPart, string>> = { dot: 'one attempt', bar: 'several, filled to the share that passed', none: 'not tested there', upd: 'updated there', drop: 'a drop against its own history' };

/** The parts of the key the table's cells need. */
export function historyKey(rows: ReadonlyArray<Pick<GoldenRow, 'history'>>): KeyPart[] {
  const cells = rows.flatMap((r) => r.history);
  const any = (f: (c: HistoryCell) => boolean) => cells.some(f);
  const parts: Array<[KeyPart, boolean]> = [
    ['dot', any((c) => c.result !== null && cellShare(c) === null)],
    ['bar', any((c) => cellShare(c) !== null)],
    ['none', any((c) => c.result === null)],
    ['upd', any((c) => c.updated)],
    ['drop', any((c) => c.dropped)],
  ];
  return parts.filter(([, on]) => on).map(([k]) => k);
}
