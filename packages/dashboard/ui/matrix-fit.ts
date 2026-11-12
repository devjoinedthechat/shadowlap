import { glueBound, type Matrix, type MatrixCol, type MatrixRow } from './matrix.js';

/**
 * How a results matrix fits the room it has, worked out from its words' widths: only
 * components/ResultsMatrix.tsx imports this, so it loads with the matrix's own script, never with the
 * page that shows it (matrix.ts is what a page builds the matrix with).
 *
 * Each column is as wide as its longest unbroken head (a head breaks at a space or after a hyphen,
 * never inside a word or an id), the word "inconclusive", its widest tally and its widest bound need;
 * the row heads as wide as their longest. Columns that don't fit: a matrix of one row (a run against
 * the presets) wraps them into balanced bands, its one head over each; one of several rows is one band
 * of every column, which scrolls sideways under row heads that stay put. Narrower than 560px, a matrix
 * of three rows or fewer whose columns don't fit turns, its variants down the side, where turned it fits.
 */

/** The parts the layout measures, each in the font the stylesheet draws it in. */
export type Part = 'head' | 'row' | 'word' | 'tally' | 'bound' | 'sub' | 'chip';

/** A text's width on one line in a part's font. */
export type Measure = (text: string, part: Part) => number;

export interface Fit {
  /** Turned: its variants down the side. */
  flip: boolean;
  /** Columns a band at most. */
  per: number;
  /** The row heads' width, px. */
  rh: number;
  /** A column's narrowest, px. */
  cw: number;
  /** A band's width where it scrolls, px; 0 where it fits. */
  w: number;
}

export interface Room {
  /** The matrix's width once laid out; null before (the first frame, the tests' renderer). */
  width: number | null;
  /** The width it is fitted to meanwhile, never turned and never scrolling. */
  fallback: number;
  /** A phone's (640px or less), where a group's head sets its count on a line of its own. */
  narrow: boolean;
}

/** Between two columns, px. */
export const GAP = 4;

/** The widest piece of the heads that can't break: at a space or after a hyphen; turned, its sub's words too. */
function widestPiece(list: ReadonlyArray<MatrixCol | MatrixRow>, measure: Measure, turned: boolean): number {
  let w = 0;
  for (const x of list) {
    for (const s of x.label.split(/\s+|(?<=-)/)) if (s) w = Math.max(w, measure(s, turned ? 'row' : 'head'));
    if (turned && 'chip' in x && x.chip) w = Math.max(w, measure(x.chip, 'chip') + 16);
    if (turned && x.sub) for (const s of x.sub.split(/\s+/)) if (s) w = Math.max(w, measure(s, 'sub'));
  }
  return w;
}

/** A row head as drawn: its label (on a phone a group's wider part), a chip 8px after it in its own 16px of padding. */
function headWidth(x: MatrixRow, narrow: boolean, measure: Measure): number {
  const label = narrow && x.parts ? Math.max(...x.parts.map((t) => measure(t, 'row'))) : measure(x.label, 'row');
  return label + (x.chip ? 8 + measure(x.chip, 'chip') + 16 : 0);
}

/** The row heads' widest: a group's with its caret, room for a sub's shortest form (a group's sub kept to one line), a member indented. */
function rowHeadsWidth(rows: readonly MatrixRow[], narrow: boolean, measure: Measure): number {
  let w = 0;
  for (const x of rows) {
    if (x.note) continue;
    const sub = x.subMin ? measure(x.subMin, 'sub') : x.rows && x.sub ? measure(x.sub, 'sub') : 0;
    w = Math.max(w, headWidth(x, narrow, measure) + (x.rows ? 18 : 0), sub);
    for (const s of x.rows ?? []) if (!s.note) w = Math.max(w, measure(s.label, 'row') + 14);
  }
  return w;
}

/** What a cell needs: its word, its tally with its noun and its bound, each whole, a range's bound breaking only before "to". */
function cellNeed(m: Matrix, measure: Measure): number {
  let word = measure('inconclusive', 'word');
  let tally = 0;
  let bound = 0;
  for (const top of m.rows) {
    for (const r of [top, ...(top.rows ?? [])]) {
      if (r.note) continue;
      for (const col of m.cols) {
        const c = m.cell(r, col);
        if (!c) continue;
        word = Math.max(word, measure(c.word, 'word'));
        if (c.tally) tally = Math.max(tally, measure(c.tally, 'tally'));
        if (c.bound) for (const piece of glueBound(c.bound).split(' ')) bound = Math.max(bound, measure(piece.replace(/\u00a0/g, ' '), 'bound'));
      }
    }
  }
  return Math.max(word, tally || measure('120 of 120', 'tally'), bound) + 14;
}

/** Turned where it is narrower than 560px, of three rows or fewer, with no groups, and its columns don't fit, if turned it fits. */
function turned(m: Matrix, width: number, per: number, need: number, measure: Measure): Fit | null {
  const n = m.rows.length;
  if (width >= 560 || m.rows.some((r) => r.rows) || n > 3 || m.cols.length <= n || per >= m.cols.length) return null;
  const frh = Math.ceil(Math.min(Math.max(96, Math.max(0, ...m.cols.map((c) => measure(c.label, 'row'))) + 12), width * 0.5));
  const fcw = Math.ceil(Math.max(96, need, widestPiece(m.rows, measure, true) + 14));
  if ((width - frh) / n < Math.min(fcw, 112)) return null;
  return { flip: true, per: n, rh: frh, cw: Math.min(fcw, Math.floor((width - frh) / n) - GAP), w: 0 };
}

/** How the matrix fits its room. */
export function fitMatrix(m: Matrix, room: Room, measure: Measure): Fit {
  const width = room.width ?? room.fallback;
  const need = cellNeed(m, measure);
  const cw = Math.ceil(Math.max(84, need, widestPiece(m.cols, measure, false) + 12));
  const rh = Math.ceil(Math.min(Math.max(96, rowHeadsWidth(m.rows, room.narrow, measure) + 12), width * 0.42, 260));
  const per = Math.max(1, Math.min(m.cols.length, Math.floor((width - rh) / (cw + GAP))));
  const turn = room.width === null ? null : turned(m, width, per, need, measure);
  if (turn) return turn;
  if (per >= m.cols.length || (m.rows.length === 1 && !m.rows[0]!.rows)) return { flip: false, per, rh, cw, w: 0 };
  return { flip: false, per: m.cols.length, rh, cw, w: room.width === null ? 0 : rh + m.cols.length * (cw + GAP) };
}

/** A band's columns, by their place in what runs across (the columns, or the rows where it turned), and the empty places that keep its cells under the first band's. */
export interface Band {
  from: number;
  to: number;
  fill: number;
}

/** The bands, balanced: as few as hold every column at `per` a band, each as full as the first but the last. */
export function bandsOf(across: number, per: number): { n: number; bands: Band[] } {
  const count = Math.max(1, Math.ceil(across / Math.max(1, per)));
  const n = Math.ceil(across / count);
  const bands: Band[] = [];
  for (let b = 0; b < count; b++) {
    const from = Math.min(across, b * n);
    const to = Math.min(across, from + n);
    bands.push({ from, to, fill: n - (to - from) });
  }
  return { n, bands };
}

/** The rows in order, an opened group's members (and its line for the rest) under it. */
export function shownRows(m: Matrix, open: (row: MatrixRow) => boolean): Array<{ row: MatrixRow; member: boolean }> {
  const out: Array<{ row: MatrixRow; member: boolean }> = [];
  for (const row of m.rows) {
    out.push({ row, member: false });
    if (row.rows && open(row)) for (const s of row.rows) out.push({ row: s, member: true });
  }
  return out;
}

/**
 * Where the key in the matrix's head starts: where the cells start (past the row heads and a gap)
 * while the columns that show hold its first line's entries, each with its 26px around it; else, or
 * turned, or not laid out, across the whole width.
 */
export function keyStart(fit: Fit, cols: number, width: number | null, firstLine: readonly number[]): number {
  if (fit.flip || !width) return 0;
  const shown = Math.min(cols, Math.floor((width - fit.rh) / (fit.cw + GAP)));
  const need = firstLine.reduce((s, w) => s + w + 26, 0);
  return shown * (fit.cw + GAP) >= need ? fit.rh + GAP : 0;
}

/** A fit as the matrix keeps it in data-rmxfit: turned or banded, columns a band, the widths, and the groups open. */
export const fitText = (f: Fit, open: readonly string[]): string => `${f.flip ? 'f' : 'b'}${f.per}:${f.rh}:${f.cw}:${f.w}:${open.join(',')}`;

// ---------------------------------------------------------------------------------------------- open groups

/** The groups opened, by `<matrix id>|<row key>`: kept while the panel closes and another run shows, until the page loads again. */
const OPEN = new Set<string>();

export const groupOpen = (id: string, key: string): boolean => OPEN.has(`${id}|${key}`);

export function toggleGroup(id: string, key: string): void {
  const k = `${id}|${key}`;
  if (!OPEN.delete(k)) OPEN.add(k);
}

/** The keys of the groups open in a matrix, in the order opened. */
export const openGroups = (id: string): string[] => [...OPEN].filter((k) => k.startsWith(`${id}|`)).map((k) => k.slice(id.length + 1));

/** Forgets every group opened: for the tests, whose matrices share this module. */
export function resetMatrixState(): void {
  OPEN.clear();
}
