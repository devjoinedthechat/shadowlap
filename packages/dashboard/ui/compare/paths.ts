import type { PathCall, PathRow } from '../../../engine/src/fork-changes.js';
import { wordMarks, type Piece } from '../json-diff.js';
import { displayOrigin, type Origin7 } from '../origins.js';
import type { CompareView } from '../types.js';
import { argPieces, cutPart, type ArgPiece } from './args.js';

/**
 * Compare's rows (`compare/Rows.tsx`), without the DOM: what each side's call says in its row, the
 * words that differ from the other side's marked, and how the row is drawn: dimmed where both made
 * the same call, marked where the two are alike enough to set apart what differs.
 */

export type { PathCall, PathRow };

/** Both paths after the identical prefix, as `GET /api/compare` sends them. */
export type Pair = NonNullable<CompareView['pair']>;

/** What a part of a side says: what the call did (`→ get_sla`, `answered`, a tool's name), what with (its arguments, its words), or the status it got. */
export type PartKind = 'pdo' | 'pargs' | 'perr';

/** A part of a side's call in its row: its words, or where the other side's call is alike enough, its words marked as what differs, arguments broken into pieces. */
export type RowPart = { kind: PartKind; text: string } | { kind: PartKind; marked: Piece[] } | { kind: 'pargs'; pieces: ArgPiece[] };

/**
 * What a call says in its row, as the mock words it: a model call by what it decided, `→` and each
 * tool it calls then their arguments, or `answered` and its words, or the HTTP status it got and who
 * refused it (an injected failure by its origin alone); a tool by its name.
 */
export function callWords(c: PathCall): Array<{ kind: PartKind; text: string }> {
  if (c.kind !== 'api') return [{ kind: 'pdo', text: c.name }];
  if (c.failure) {
    const by = c.failure.by === 'injected' ? '' : c.failure.by === 'offline' ? 'refused offline' : 'refused by the provider';
    return [{ kind: 'perr', text: c.failure.status ? `HTTP ${c.failure.status}` : 'failed' }, { kind: 'pargs', text: by }];
  }
  const d = c.decision;
  if (d?.tools.length) return [{ kind: 'pdo', text: `→\u00a0${d.tools.map((t) => t.name).join(', ')}` }, { kind: 'pargs', text: d.tools.map((t) => JSON.stringify(t.args ?? {})).join(' ') }];
  return [{ kind: 'pdo', text: 'answered' }, { kind: 'pargs', text: d?.text ? `“${d.text.replace(/\s+/g, ' ').trim()}”` : '' }];
}

/**
 * A side's parts in its row. Where the row's two calls are alike enough (`similar`), each part is
 * cut to a line or two and its words marked against the other side's same part, arguments broken
 * between their pieces; else each reads plain, the row cutting it at its end. Empty parts go.
 */
export function rowParts(c: PathCall, other: PathCall | null, similar: boolean): RowPart[] {
  const mine = callWords(c);
  const theirs = other && similar ? callWords(other) : null;
  return mine.flatMap((p, i): RowPart[] => {
    if (!p.text) return [];
    if (!theirs) return [p];
    const marked = wordMarks(cutPart(theirs[i]?.text ?? ''), cutPart(p.text))[1];
    return p.kind === 'pargs' && c.kind === 'api' && !c.failure && c.decision?.tools.length ? [{ kind: 'pargs', pieces: argPieces(marked) }] : [{ kind: p.kind, marked }];
  });
}

/** A side's class in its row: `del` for A and `add` for B, then `same` where both made the same call, `diff` where the other side made another. */
export function sideClass(row: Pick<PathRow, 'alike' | 'a' | 'b'>, side: 'a' | 'b'): string {
  const other = side === 'a' ? row.b : row.a;
  return `pside ${side === 'a' ? 'del' : 'add'}${row.alike ? ' same' : other ? ' diff' : ''}`;
}

/** A call's origin as the strip names it: a model call that failed live reads `failed`. */
export const callOrigin = (c: Pick<PathCall, 'origin' | 'failure'>): Origin7 => displayOrigin({ origin: c.origin, outcome: c.failure ? 'error' : 'ok' });

/** The row a `#/compare/<a>/<b>/<n>` address opens, by its number: one of the rows drawn, or none. */
export const openRow = (rows: readonly Pick<PathRow, 'n'>[], call: number | null | undefined): number | null => (call && rows.some((r) => r.n === call) ? call : null);
