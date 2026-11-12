import { TOKEN, type Piece } from '../json-diff.js';

/**
 * A row's arguments in a line, as data a row draws (Compare's rows, `pages/Compare.tsx`): pieces a
 * line may break between, after a comma or an opening brace outside a string, each kept whole where
 * it fits its column. A wider one breaks after its key's colon, its value kept whole where that fits,
 * else after an `@ . / :` or `-` in a string. A piece with a space in a string breaks at its spaces,
 * as words do, its short strings kept whole. Words marked as what differs from the other side's
 * call (json-diff.ts `wordMarks`) keep their marks.
 */

/** A run of an argument's text, marked where it differs from the other side's; a line may break after it where `wbr`. */
export interface ArgRun {
  text: string;
  marked: boolean;
  wbr: boolean;
}

/**
 * A piece of arguments. `value`: its key (null for none) then its value, each kept whole where it
 * fits. `words`: a piece with a spaced string, breaking at its spaces, a short string kept whole.
 */
export type ArgPiece = { kind: 'value'; key: ArgRun[] | null; value: ArgRun[] } | { kind: 'words'; parts: Array<{ runs: ArgRun[]; whole: boolean }> };

type Token = { text: string; marked: boolean };
/** Tokens inside a string, its quotes with it, or between strings. */
type Segment = { str: boolean; tokens: Token[] };

/** Where a wide value may break: after these, in a string. */
const BREAK_AFTER = /^[@./:-]$/;
/** A string this long or shorter, with no space, is kept whole in a piece of words. */
const WHOLE = 32;

function segments(tokens: readonly Token[]): Segment[] {
  const out: Segment[] = [];
  let cur: Token[] = [];
  let str = false;
  tokens.forEach((t, i) => {
    const quote = t.text === '"' && !(i && tokens[i - 1]!.text === '\\');
    if (quote && !str) {
      if (cur.length) out.push({ str: false, tokens: cur });
      cur = [t];
      str = true;
      return;
    }
    cur.push(t);
    if (quote && str) {
      out.push({ str: true, tokens: cur });
      cur = [];
      str = false;
    }
  });
  if (cur.length) out.push({ str, tokens: cur });
  return out;
}

const textOf = (s: Segment): string => s.tokens.map((t) => t.text).join('');

/** A segment's runs: tokens of one mark joined, a break after each token `brk` matches in a string. */
function runsOf(s: Segment, brk: RegExp | null): ArgRun[] {
  const out: ArgRun[] = [];
  for (const t of s.tokens) {
    const wbr = !!brk && s.str && brk.test(t.text);
    const last = out.at(-1);
    if (last && !last.wbr && last.marked === t.marked) {
      last.text += t.text;
      last.wbr = wbr;
    } else out.push({ text: t.text, marked: t.marked, wbr });
  }
  return out;
}

/** A piece as it breaks: its key apart from its value, or at its spaces. */
function pieceOf(p: Segment[]): ArgPiece {
  if (p.some((g) => g.str && /\s/.test(textOf(g)))) return { kind: 'words', parts: p.map((g) => ({ runs: runsOf(g, null), whole: g.str && textOf(g).length <= WHOLE && !/\s/.test(textOf(g)) })) };
  const j = p.findIndex((g) => !g.str && g.tokens.some((t) => t.text === ':'));
  if (j < 0) return { kind: 'value', key: null, value: p.flatMap((g) => runsOf(g, BREAK_AFTER)) };
  const colon = p[j]!.tokens.findIndex((t) => t.text === ':');
  const key = [...p.slice(0, j), { str: false, tokens: p[j]!.tokens.slice(0, colon + 1) }];
  const value = [{ str: false, tokens: p[j]!.tokens.slice(colon + 1) }, ...p.slice(j + 1)];
  return { kind: 'value', key: key.flatMap((g) => runsOf(g, null)), value: value.flatMap((g) => runsOf(g, BREAK_AFTER)) };
}

/** Arguments as JSON in a line, their words marked or not, cut into the pieces a row breaks them by. */
export function argPieces(marked: readonly Piece[]): ArgPiece[] {
  const tokens = marked.flatMap((p) => (p.text.match(TOKEN) ?? []).map((text) => ({ text, marked: p.marked })));
  const pieces: Segment[][] = [[]];
  for (const g of segments(tokens)) {
    let run: Token[] = [];
    for (const t of g.tokens) {
      run.push(t);
      if (g.str || (t.text !== ',' && t.text !== '{')) continue;
      pieces.at(-1)!.push({ str: false, tokens: run });
      pieces.push([]);
      run = [];
    }
    if (run.length) pieces.at(-1)!.push({ str: g.str, tokens: run });
  }
  return pieces.filter((p) => p.length).map(pieceOf);
}

/** A row's part marked against the other side's is cut past this, so the words it marks show on a line or two. */
export const PART_SHOWN = 120;

export const cutPart = (s: string): string => (s.length > PART_SHOWN ? `${s.slice(0, PART_SHOWN - 1)}…` : s);
