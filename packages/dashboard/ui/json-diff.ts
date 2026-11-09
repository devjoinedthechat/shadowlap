import { canonicalize } from '../../engine/src/canonical.js';
import { isObject } from '../../engine/src/is-object.js';

/**
 * The structural diff: two JSON values as one list of lines, a key a line. A key one side lacks is
 * one signed line (`+ refund_limit: 100`); a changed value is its two lines, the recorded one over
 * this run's, the words that differ marked; objects and arrays are walked into, so a change sits under
 * its own key, an array's item keyed by its index (`content[0]`), and a JSON document inside a string
 * is read as JSON and says so, so no line holds an escaped document. An object goes key by key in
 * this run's order, a key only the recording had where it stood. Unchanged values longer than a line
 * are cut, being context, and a changed array's unchanged items fold into one `[ … ]` line; changed
 * values are never cut. A key neither side holds, left out of a request built from its changes alone,
 * is one more `[ … ]` line. Show diff draws the lines as one list, Compare side by side (`splitRows`).
 *
 * Pure, and loaded only with JsonDiff.tsx, the part that draws it.
 */

export type Sign = ' ' | '+' | '-';

/** A run of a value's text: as it is, or marked as what differs from the other side. */
export interface Piece {
  text: string;
  marked: boolean;
}

export interface JsonLine {
  /** `-` the recording's, `+` this run's, ` ` both sides'. */
  sign: Sign;
  /** How deep it sits: 0 for the top level. */
  depth: number;
  /** Its key (`role`, `content[0]`, `[2]`), or null for a value at the top. */
  key: string | null;
  /** Its value's text; none for a key whose own keys follow. */
  value: Piece[];
  /** A value with no space in it (an id, a UUID, a model's name): kept whole, moved under the hanging indent rather than broken. */
  whole: boolean;
  /** The key holds a JSON document in a string, its keys walked below. */
  json: boolean;
  /** Unchanged items of a changed array, folded, or a key left out: `[ … ]`. */
  fold: boolean;
  /** Where it is, as the structural diff names a path (`$.messages[2].content`): inside a JSON string, the string's. */
  path: string;
}

/** An unchanged value longer than this is cut, with `…`. */
export const CUT = 72;
/** What a fold or a key left out shows. */
const FOLDED = '[ … ]';
/** Past this many token pairs, two values' words aren't matched: every word is marked. */
const MATCH_LIMIT = 160_000;
const TOKEN = /[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g;
/** A lone mark between two changed words, marked with them, so a changed id reads as one change. */
const JOINER = /^[-_.:/]$/;

type Nested = Record<string, unknown> | unknown[];
const nested = (v: unknown): v is Nested => isObject(v) || Array.isArray(v);

/** A string that holds a JSON object or array, read; null for any other value. */
export function jsonInString(v: unknown): Nested | null {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return nested(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const textOf = (v: unknown): string => JSON.stringify(v) ?? 'null';
const cut = (t: string): string => (t.length > CUT ? `${t.slice(0, CUT - 1)}…` : t);
const keptWhole = (t: string): boolean => /^"\S*"$/.test(t);

function same(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

/** Two values' texts as runs of words, what differs between them marked; a common start and end are set aside before matching the rest. */
export function wordMarks(x: string, y: string): [Piece[], Piece[]] {
  const a = x.match(TOKEN) ?? [];
  const b = y.match(TOKEN) ?? [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const [ka, kb] = matched(a.slice(head, a.length - tail), b.slice(head, b.length - tail));
  const keep = (k: boolean[], n: number) => [...Array<boolean>(head).fill(true), ...k, ...Array<boolean>(n).fill(true)];
  return [pieces(a, joined(a, keep(ka, tail))), pieces(b, joined(b, keep(kb, tail)))];
}

/** Which tokens of each side the longest common run of tokens keeps; none past MATCH_LIMIT. */
function matched(a: readonly string[], b: readonly string[]): [boolean[], boolean[]] {
  const n = a.length;
  const m = b.length;
  const ka = Array<boolean>(n).fill(false);
  const kb = Array<boolean>(m).fill(false);
  if (n * m > MATCH_LIMIT) return [ka, kb];
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ka[i++] = true;
      kb[j++] = true;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  return [ka, kb];
}

function joined(tokens: readonly string[], keep: boolean[]): boolean[] {
  for (let q = 1; q < tokens.length - 1; q++) if (keep[q] && !keep[q - 1] && !keep[q + 1] && JOINER.test(tokens[q]!)) keep[q] = false;
  return keep;
}

function pieces(tokens: readonly string[], keep: readonly boolean[]): Piece[] {
  const out: Piece[] = [];
  tokens.forEach((t, q) => {
    const last = out.at(-1);
    if (last && last.marked === !keep[q]) last.text += t;
    else out.push({ text: t, marked: !keep[q] });
  });
  return out;
}

/**
 * The lines of two values' structural diff, the recording's (`was`) against this run's (`now`).
 * `leftOut`, top-level keys of a request built from its changes alone that neither side holds (its
 * conversation, `messages`): each one unchanged line last, `messages: [ … ]`.
 */
export function jsonDiff(was: unknown, now: unknown, leftOut: readonly string[] = []): JsonLine[] {
  const out: JsonLine[] = [];
  new Walk(out).pair(was, now, 0, null, '$', false);
  for (const k of leftOut) out.push({ sign: ' ', depth: 0, key: k, value: [{ text: FOLDED, marked: false }], whole: false, json: false, fold: true, path: `$.${k}` });
  return out;
}

class Walk {
  constructor(private readonly out: JsonLine[]) {}

  private line(sign: Sign, depth: number, key: string | null, path: string, value: Piece[], o: { json?: boolean; whole?: boolean; fold?: boolean } = {}): void {
    this.out.push({ sign, depth, key, value, whole: !!o.whole, json: !!o.json, fold: !!o.fold, path });
  }

  /** A value as its line holds it: its text, unmarked, cut when it is context. */
  private plain(sign: Sign, depth: number, key: string | null, path: string, v: unknown, cutIt: boolean): void {
    const t = cutIt ? cut(textOf(v)) : textOf(v);
    this.line(sign, depth, key, path, [{ text: t, marked: false }], { whole: keptWhole(t) });
  }

  /** A value only one side has: one line when short, else its keys under its own, each with the same sign. */
  private one(sign: Sign, v: unknown, depth: number, key: string | null, path: string, inner: boolean): void {
    const parsed = jsonInString(v);
    if (parsed) {
      this.line(sign, depth, key, path, [], { json: true });
      this.each(sign, parsed, depth + 1, path, true);
    } else if (nested(v) && textOf(v).length > CUT) {
      if (key !== null) this.line(sign, depth, key, path, []);
      this.each(sign, v, key !== null ? depth + 1 : depth, path, inner);
    } else this.plain(sign, depth, key, path, v, false);
  }

  private each(sign: Sign, v: Nested, depth: number, path: string, inner: boolean): void {
    if (Array.isArray(v)) v.forEach((item, i) => this.one(sign, item, depth, `[${i}]`, inner ? path : `${path}[${i}]`, inner));
    else for (const [k, item] of Object.entries(v)) this.one(sign, item, depth, k, inner ? path : `${path}.${k}`, inner);
  }

  pair(x: unknown, y: unknown, depth: number, key: string | null, path: string, inner: boolean): void {
    const px = jsonInString(x);
    const py = jsonInString(y);
    if (px && py) {
      this.line(' ', depth, key, path, [], { json: true });
      this.pair(px, py, depth + 1, null, path, true);
    } else if (same(x, y)) {
      if (key !== null || !nested(x)) this.plain(' ', depth, key, path, x, true);
      else this.each(' ', x, depth, path, inner);
    } else if (Array.isArray(x) && Array.isArray(y)) this.items(x, y, depth, key, path, inner);
    else if (isObject(x) && isObject(y)) this.keys(x, y, depth, key, path, inner);
    else {
      const [a, b] = wordMarks(textOf(x), textOf(y));
      this.line('-', depth, key, path, a, { whole: keptWhole(textOf(x)) });
      this.line('+', depth, key, path, b, { whole: keptWhole(textOf(y)) });
    }
  }

  /** An array's items by index, each keyed under the array's key at its depth; a run of unchanged ones folded into one line. */
  private items(x: unknown[], y: unknown[], depth: number, key: string | null, path: string, inner: boolean): void {
    const at = (i: number) => (inner ? path : `${path}[${i}]`);
    const both = Math.min(x.length, y.length);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (i >= y.length) this.one('-', x[i], depth, `${key ?? ''}[${i}]`, at(i), inner);
      else if (i >= x.length) this.one('+', y[i], depth, `${key ?? ''}[${i}]`, at(i), inner);
      else if (!same(x[i], y[i])) this.pair(x[i], y[i], depth, `${key ?? ''}[${i}]`, at(i), inner);
      else {
        let j = i;
        while (j + 1 < both && same(x[j + 1], y[j + 1])) j++;
        if (j === i) this.plain(' ', depth, `${key ?? ''}[${i}]`, at(i), y[i], true);
        else this.line(' ', depth, `${key ?? ''}[${i}–${j}]`, at(i), [{ text: FOLDED, marked: false }], { fold: true });
        i = j;
      }
    }
  }

  /** An object's keys in this run's order, a key only the recording had where it stood. */
  private keys(x: Record<string, unknown>, y: Record<string, unknown>, depth: number, key: string | null, path: string, inner: boolean): void {
    if (key !== null) this.line(' ', depth, key, path, []);
    const d = key !== null ? depth + 1 : depth;
    const at = (k: string) => (inner ? path : `${path}.${k}`);
    const theirs = Object.keys(x);
    const done = new Set<string>();
    const gone = (k: string) => {
      if (Object.hasOwn(y, k) || done.has(k)) return;
      done.add(k);
      this.one('-', x[k], d, k, at(k), inner);
    };
    for (const k of Object.keys(y)) {
      if (!Object.hasOwn(x, k)) this.one('+', y[k], d, k, at(k), inner);
      else {
        theirs.slice(0, theirs.indexOf(k)).forEach(gone);
        this.pair(x[k], y[k], d, k, at(k), inner);
      }
    }
    theirs.forEach(gone);
  }
}

/**
 * Side by side: a removed line beside the added line that replaces it, a context line on both, and
 * between them the lines one side alone has, each side's from the top, beside a gap where the other
 * side has fewer. So where a value's shape changed (a tool's result that came back as an error), the
 * recording's keys sit beside this run's, not below them, though the walk lists this run's first.
 */
export function splitRows(lines: readonly JsonLine[]): Array<[JsonLine | null, JsonLine | null]> {
  const rows: Array<[JsonLine | null, JsonLine | null]> = [];
  let was: JsonLine[] = [];
  let now: JsonLine[] = [];
  const alone = () => {
    for (let k = 0; k < Math.max(was.length, now.length); k++) rows.push([was[k] ?? null, now[k] ?? null]);
    was = [];
    now = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const next = lines[i + 1];
    if (l.sign === '-' && next?.sign === '+' && next.key === l.key && next.depth === l.depth) {
      alone();
      rows.push([l, next]);
      i++;
    } else if (l.sign === '-') was.push(l);
    else if (l.sign === '+') now.push(l);
    else {
      alone();
      rows.push([l, l]);
    }
  }
  alone();
  return rows;
}
