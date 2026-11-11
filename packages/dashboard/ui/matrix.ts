import { statusTone } from './components/Status.js';
import { plural } from './format.js';
import { MANY_READS } from '../src/injection-defaults.js';

/**
 * The results matrix's data and words: one design for an injection test (its untrusted reads by
 * payload) and the error-path presets (a run by preset). What was tested runs down the side, its
 * variants across the top, and each cell says what came of them in the strip's grammar: a bar in its
 * tone, the word, the tally with its noun, the bound. Plain data and no DOM: a page builds it from
 * the store, and components/ResultsMatrix.tsx draws it fitted to its room (matrix-fit.ts). Its key
 * (components/MatrixKey.tsx) and receipt (components/Receipt.tsx) are Changes' preview's too.
 */

/** A cell's tone, in the consequence colours: passed (lime), failed, obeyed or caused (red), inconclusive or influenced (amber), what showed nothing (muted). */
export type CellTone = 'ok' | 'err' | 'warn' | 'mu';

export interface MatrixCell {
  /** What came of it, a verdict word, which gives the tone unless `tone` says otherwise. */
  word: string;
  tone?: CellTone;
  /** What it counts, with its noun ("3 of 3 obeyed", "5 of 6 passed"): the page's words, never counted here. */
  tally?: string | null;
  /** The gate's bound ("rate >= 0.60 (90%)"), drawn whole but for a range's "to" (`glueBound`). */
  bound?: string | null;
  /** The attempt that shows it. */
  href?: string | null;
  /** Its hover card (`tipCard`). */
  tip?: string | null;
}

export interface MatrixCol {
  key: string;
  label: string;
  /** What the variant does: a payload's title and text, where a preset hit. Its head's card, and under it where the matrix turns. */
  sub?: string | null;
}

export interface MatrixRow {
  key: string;
  /** What its head says, as text: what is measured and read, and drawn where the page gives no head of its own. */
  label: string;
  /** Its name in its cells' names where its label isn't enough: a group's member "#4" is "#4 get_ticket". */
  name?: string | null;
  /** A chip beside its head: the golden a run was replayed against. */
  chip?: string | null;
  sub?: string | null;
  /** The shortest form of its sub (an about line's), which its head keeps room for. */
  subMin?: string | null;
  /** A group's head in two parts, the count on a line of its own on a phone: ["get_ticket", "40 reads"]. */
  parts?: readonly [string, string];
  /** Where its head goes: the read's call. */
  href?: string | null;
  /** A group's members, under it once it is opened. */
  rows?: readonly MatrixRow[];
  /** A line across in place of cells: what a group's quiet reads came to. */
  note?: string;
}

export interface Matrix {
  /** Its name for the groups opened in it, kept while the page shows another run. */
  id: string;
  /** The grid's accessible name ("Untrusted reads by payload", "Error-path presets on <id>"). */
  label: string;
  /** Its one row is named in `label` (a run against the presets), so its cells' names leave the row out. */
  rowInLabel?: boolean;
  /** The heading over the row heads ("untrusted read", "run"). */
  corner: string;
  rows: readonly MatrixRow[];
  cols: readonly MatrixCol[];
  /** What came of a row against a column, a group's summed: null where nothing ran there. */
  cell: (row: MatrixRow, col: MatrixCol) => MatrixCell | null;
}

/**
 * A cell's tone: its own, else its word's as a status takes it (obeyed and failed red, influenced and
 * inconclusive amber, passed lime). What showed nothing (ignored, not caused, not applicable) and a tone
 * a cell doesn't draw (a fork's stubbed) read muted, so the red and the amber stand out.
 */
export function cellTone(c: Pick<MatrixCell, 'word' | 'tone'>): CellTone {
  if (c.tone) return c.tone;
  const t = statusTone(c.word);
  return t === 'ok' || t === 'err' || t === 'warn' ? t : 'mu';
}

/** Each tone's colour, as a cell's bar and the key's swatch draw it: a card's rows take theirs from here. */
export const TONE_COLOUR: Readonly<Record<CellTone, string>> = { err: 'var(--cq-red)', warn: 'var(--cq-amber)', ok: 'var(--cq-lime)', mu: 'var(--cq-muted)' };

/**
 * A gate's bound kept whole in a narrow cell: "rate", an operator and the confidence glued to their
 * figures, so it breaks only before a range's "to" ("rate 0.50" / "to 0.96 (90%)").
 */
export const glueBound = (bound: string): string =>
  bound
    .replace(/(>=|<=|to) /g, '$1\u00a0')
    .replace(/ \((\d+%)\)/g, '\u00a0($1)')
    .replace(/^rate /, 'rate\u00a0');

/** The name a row goes by in its cells' names. */
export const rowName = (r: MatrixRow): string => r.name ?? r.label;

/** Where a cell is, as its name starts: "#4 get_ticket, system-notice: ", the column alone where the matrix's name says the row. */
export const cellPlace = (m: Matrix, row: MatrixRow, col: MatrixCol): string => (m.rowInLabel ? `${col.label}: ` : `${rowName(row)}, ${col.label}: `);

/** What a screen reader hears for a cell: where it is, then its word, tally and bound; "not run" where nothing ran. */
export function cellName(m: Matrix, row: MatrixRow, col: MatrixCol, c: MatrixCell | null): string {
  if (!c) return `${cellPlace(m, row, col)}not run`;
  return cellPlace(m, row, col) + [c.word, c.tally, c.bound ? glueBound(c.bound) : null].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------------------------- groups

/** A read's worst attempt: obeyed, influenced, inconclusive, or ignored (nothing happened). */
export type Worst = 0 | 1 | 2 | 3;

/** A read as its row, with what grouping needs to know of it. */
export interface ReadRow {
  callNo: number;
  /** Its tool. */
  name: string;
  worst: Worst;
  row: MatrixRow;
}

/**
 * Past `many` reads (eight), a row for each tool in the order first read, "get_ticket · 40 reads",
 * keyed `g:<tool>` for the page to sum its cells. Opened, it holds the reads that obeyed, were influenced
 * or couldn't say, worst first then by number, each by its number alone (named "#4 get_ticket"), then
 * one line for the rest. Eight reads or fewer: a row each, as given.
 */
export function groupRows(reads: readonly ReadRow[], { many = MANY_READS }: { many?: number } = {}): MatrixRow[] {
  if (reads.length <= many) return reads.map((r) => r.row);
  const by = new Map<string, ReadRow[]>();
  for (const r of reads) {
    const list = by.get(r.name);
    if (list) list.push(r);
    else by.set(r.name, [r]);
  }
  return [...by].map(([name, list]) => {
    const loud = list.filter((r) => r.worst < 3).sort((a, b) => a.worst - b.worst || a.callNo - b.callNo);
    const quiet = list.length - loud.length;
    const members: MatrixRow[] = loud.map((r) => ({ ...r.row, label: `#${r.callNo}`, name: `#${r.callNo} ${name}`, sub: null, subMin: null }));
    if (quiet) members.push({ key: `q:${name}`, label: '', note: loud.length ? `${plural(quiet, 'more read')}, every one ignored` : 'every read ignored every payload' });
    const count = plural(list.length, 'read');
    return { key: `g:${name}`, label: `${name} · ${count}`, parts: [name, count], sub: list[0]!.row.sub ?? null, rows: members };
  });
}

// ---------------------------------------------------------------------------------------------- the key

/** A key's entry as words: a count, what it counts, its tone's swatch, and the card that says the rule it stands on. */
export interface KeyItem {
  n: number;
  words: string;
  tone?: CellTone | null;
  tip?: string | null;
}

/**
 * A key's lines: the entries that matter first, then the quieter ones on a line of their own; a lone
 * quieter entry ends the first line instead, keeping its quiet form. A count of zero is left out, and
 * where nothing that matters is left, the quieter entries take the first line.
 */
export function keyLines<E extends { n: number }>(main: readonly E[], quiet: readonly E[]): { first: Array<{ entry: E; quiet: boolean }>; second: E[] } {
  let loud = main.filter((e) => e.n);
  let soft = quiet.filter((e) => e.n);
  if (!loud.length) [loud, soft] = [soft, []];
  const lone = soft.length === 1;
  return { first: [...loud.map((entry) => ({ entry, quiet: false })), ...(lone ? [{ entry: soft[0]!, quiet: true }] : [])], second: lone ? [] : soft };
}

/** What a results key says more quietly: what showed nothing. Passed stays with the verdicts that need a look, as on Tests. */
const QUIET = new Set(['ignored', 'not caused', 'not applicable']);

/**
 * A results matrix's key from its counts in the page's order (obeyed, influenced, inconclusive, ignored;
 * failed, inconclusive, passed, not applicable): each a count, its word and its tone's swatch.
 */
export function resultsKey(counts: ReadonlyArray<readonly [string, number]>): { main: KeyItem[]; quiet: KeyItem[] } {
  const item = ([words, n]: readonly [string, number]): KeyItem => ({ n, words, tone: cellTone({ word: words }) });
  return { main: counts.filter(([w]) => !QUIET.has(w)).map(item), quiet: counts.filter(([w]) => QUIET.has(w)).map(item) };
}
