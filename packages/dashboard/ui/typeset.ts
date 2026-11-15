/**
 * Line breaks, worked out as a page renders, for the parts in components/Copy.tsx. Every line the
 * dashboard shows breaks where a careful typesetter would break it, at every width, by six rules:
 *
 * 1. Sentences stay whole in short copy: a line breaks between them before it breaks inside one.
 * 2. No orphans: a block of two lines balances them, a longer one wraps pretty, its last line a
 *    third of the measure where it can; a sentence of two lines breaks after a clause.
 * 3. What belongs together stays together: a number and its unit, a tally, a separator and the word
 *    before it, an operator, a small word and the word after it, a compound noun, a flag and its
 *    value, a sentence's last two words (`glueJoins`).
 * 4. Short identifiers never split: a run id, a model, a flag, a path, a golden's name; a long host
 *    or name may break after a dot or a hyphen only where no line holds it (`keptWords`).
 * 5. Controls never wrap (the stylesheet's).
 * 6. Commands and code break only between their arguments (`codePieces`, and cmdline.ts).
 *
 * This file holds the rules' vocabulary and what needs no measure; typeset-lines.ts sets copy at the
 * width it has. React owns its text, so nothing here reads or writes the page: a component measures
 * (a canvas, in each element's own font) and passes what it measured in. No DOM here: the tests
 * import it.
 */

// ---------------------------------------------------------------------------------------------- copy as parts

/**
 * A piece of copy: its own text, or an element in it (a link, code, a key, a term), which is kept
 * whole: `atom` its index among the copy's elements, `text` what it shows, `starts` whether it can
 * start a sentence (an id, a command or a link set apart, or text that starts as a sentence does).
 */
export type CopyPart = { text: string } | { atom: number; text: string; starts: boolean };

/** An element's place in copy's text. */
export interface AtomAt {
  from: number;
  to: number;
  atom: number;
  starts: boolean;
}

/** Copy as one text: its parts joined, which characters are its own (an element's are not), and where each element is. */
export interface Flat {
  str: string;
  own: readonly boolean[];
  atoms: readonly AtomAt[];
}

export function flatten(parts: readonly CopyPart[]): Flat {
  let str = '';
  const own: boolean[] = [];
  const atoms: AtomAt[] = [];
  for (const p of parts) {
    const mine = !('atom' in p);
    if (!mine) atoms.push({ from: str.length, to: str.length + p.text.length, atom: p.atom, starts: p.starts });
    for (let i = 0; i < p.text.length; i++) own.push(mine);
    str += p.text;
  }
  return { str, own, atoms };
}

/** Copy of one string, all its own. */
export const flatText = (text: string): Flat => flatten([{ text }]);

/** The element that starts at a place in copy's text, if one does. */
export const atomAt = (f: Flat, at: number): AtomAt | null => f.atoms.find((a) => a.from === at) ?? null;

/** Whether a character of copy is its own space, where a line may break. */
export const ownSpace = (f: Flat, i: number): boolean => !!f.own[i] && /[ \t\n\r]/.test(f.str[i]!);

// ---------------------------------------------------------------------------------------------- sentences

/** What starts a sentence: a capital, a digit, an opening quote or bracket, a sign. */
const START = /^[“‘"'([]?[A-Z0-9$#≈€£`]/;
/** A stop, the closers after it, and the space before the next sentence. */
const END = /([.!?][”’"')\]]*)([ \t\n\r]+)/g;
/** An abbreviation's stop is no sentence's end. */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|cf|approx|incl|No|Mr|Ms|Dr|St)\.$/;

/** How far into quotes and brackets each character is: what is inside one is a piece of the sentence around it. */
export function depthAt(text: string): number[] {
  const out: number[] = [];
  let depth = 0;
  let straight = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '“' || ch === '(' || ch === '[') depth++;
    else if ((ch === '”' || ch === ')' || ch === ']') && depth > 0) depth--;
    else if (ch === '"') {
      straight = !straight;
      depth += straight ? 1 : -1;
    }
    out.push(depth);
  }
  return out;
}

/** Whether what follows a place starts a sentence: an element that does, or text that starts as one does. */
function startsAt(f: Flat, at: number): boolean {
  const a = atomAt(f, at);
  return a ? a.starts : START.test(f.str.slice(at));
}

/** A range without the space at either end. */
export function trimRange(str: string, a: number, b: number): [number, number] {
  while (a < b && /\s/.test(str[a]!)) a++;
  while (b > a && /\s/.test(str[b - 1]!)) b--;
  return [a, b];
}

/**
 * Where copy's sentences are, each a range of its text without the space between two: a stop (`.`,
 * `!`, `?`, a closing quote or bracket after it), then the copy's own space, then what starts a
 * sentence. Never after an abbreviation (`e.g.`, `vs.`), inside a quotation or brackets (a model's
 * answer quoted in a sentence is one piece of it), or inside an element: a stop that ends one is a
 * sentence's end where the copy's own space follows it.
 */
export function sentenceRanges(f: Flat): Array<[number, number]> {
  const { str, own } = f;
  const depth = depthAt(str);
  const out: Array<[number, number]> = [];
  let from = 0;
  for (const m of str.matchAll(END)) {
    const stop = m.index;
    const end = stop + m[1]!.length;
    const next = end + m[2]!.length;
    if (next >= str.length || !own.slice(end, next).every(Boolean)) continue;
    // the stop is the sentence's own: outside every quote and bracket once its closers are counted
    if ((depth[end - 1] ?? 0) !== 0 || (end === stop + 1 && (depth[stop] ?? 0) !== 0)) continue;
    if (ABBREVIATION.test(str.slice(Math.max(0, stop - 12), stop + 1)) || !startsAt(f, next)) continue;
    out.push([from, end]);
    from = next;
  }
  out.push([from, str.length]);
  return out.map(([a, b]) => trimRange(str, a, b)).filter(([a, b]) => b > a);
}

/** A string's sentences, as `sentenceRanges` finds them. */
export const sentences = (text: string): string[] => sentenceRanges(flatText(text)).map(([a, b]) => text.slice(a, b));

/** Short copy, as rule 1 counts it: at most four sentences in at most 640 characters (one sentence is short too). */
export const isShortCopy = (text: string): boolean => text.length <= 640 && sentences(text).length <= 4;

// ---------------------------------------------------------------------------------------------- glue

/** The small words a line shouldn't end on (rule 3): an article, a preposition, a conjunction, an auxiliary. */
export const SMALL = new Set(
  'a an the of to in on at by for and or nor but with from as is its it your my our no not than into onto per via vs vs. if so be until unless while because whether once since that which whose when where before after over under through across against within without between are was were been has have had can could will would should may might must'.split(
    ' ',
  ),
);
/** An article or a possessive, which holds its word more than the other small words do. */
export const ARTICLES = new Set(['a', 'an', 'the', 'its', 'your', 'my', 'our', 'no']);
/** What a number never holds after it: a small word, or a preposition (`#19 with`, `0.94 over`). */
const NOT_A_UNIT = new Set([...SMALL, 'over', 'above', 'below', 'under', 'against', 'after', 'before', 'until', 'since', 'across', 'between', 'within', 'without']);
/** A figure ending a word: a count, a price, a rate, a share, a call's number, a number in words. */
const NUMBER = /(?:^|[(“"‘[/])(?:[≈~$€£#+−-]{0,2}\d(?:[\d,.:]*\d)?(?:[kKmMbB%×x+]|ms)?|[Oo]ne|[Tt]wo|[Tt]hree|[Ff]our|[Ff]ive|[Ss]ix|[Ss]even|[Ee]ight|[Nn]ine|[Tt]en)$/;
/** A word that names the number after it: `call 19`, `Attempt 2`, `HTTP 529`, `Oct 1`, `tier 2`, `against 0.94`, `above 100`. */
const NAMES_NUMBER =
  /\b(?:calls?|attempts?|probes?|steps?|turns?|candidates?|revisions?|rev|runs?|sessions?|goldens?|HTTP|PR|exit|exited|code|tier|lines?|version|port|page|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|against|over|above|below|under|than)$/i;
/** How a number a word names starts. */
const A_NUMBER = /^[#≈~$€£]?\d/;
/** A revision's short hash, after the word that names it (`rev a7b3c2e`): it starts with a letter as often as a digit. */
const REV_HASH = /^[0-9a-f]{7,40}\b/;
/** An operator, a word of its own: no line starts with one. */
const OPERATOR = /^(?:[<>=≤≥≠]|[<>!=]=)$/;
/** A separator, a word of its own: no line starts with one. */
const SEPARATOR = /^[·→↳—…]$/;
/** A sign before its amount. */
const SIGN = /^[≈~$€£]$/;
/** A flag in prose: it keeps its value, as a command's does. */
const FLAG = /^[(“"‘[]?--?[A-Za-z][\w-]*$/;
/** Nouns of two words, and of three, that read as one: how the first part ends, and how the next starts. */
const COMPOUNDS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/\bprompts?$/i, /^and$/i],
  [/^and$/i, /^tools?\b/i],
  [/\bworking$/i, /^tree\b/i],
  [/\bpull$/i, /^requests?\b/i],
  [/\brequest$/i, /^(?:field|format|body)\b/i],
  [/\btool$/i, /^(?:rewrites|descriptions?|definitions?)\b/i],
  [/\bsystem$/i, /^(?:prompt|message)s?\b/i],
  [/\bjudge$/i, /^checks?\b/i],
  [/\bup$/i, /^to\b/i],
];

/** How strongly each join holds, strongest first (rule 3's order), as a run too long for its line gives up the weakest first. */
export const JOIN = { sign: 9, last: 8.5, figure: 8, operator: 7, compound: 6, article: 5, small: 4, after: 3, smalls: 2 } as const;
/** The weakest joins, which give way where they would cost a short block a line: a small word's, an operator's with what follows it. */
export const WEAK = JOIN.small;

/** A word's last piece and the next one's first: a no-break space already in the text joins what is beside it. */
const lastPiece = (w: string) => w.slice(w.lastIndexOf('\u00a0') + 1);
const firstPiece = (w: string) => w.split('\u00a0')[0]!;
/** A word as a small word reads: without an opening bracket or quote before it, in lower case. */
const lead = (w: string) => w.replace(/^[(“"‘[]+/, '').toLowerCase();

/** Whether a space is inside a compound noun: `pull requests`, `prompt and tools`, `up to`. */
function compound(a: string, b: string, before: string | undefined, after: string | undefined): boolean {
  return COMPOUNDS.some(([x, y], k) => {
    if (!x.test(a) || !y.test(b)) return false;
    // "and" is a compound's middle only between "prompt" and "tools"
    if (k === 0) return !!after && /^tools?\b/i.test(after);
    if (k === 1) return !!before && /\bprompts?$/i.test(before);
    return true;
  });
}

/** Whether word `b` is the unit of the figure word `a` ends on: `40 days`, `3 calls`, `$0.42 spent`, never a small word (`#19 with`). */
const unitOf = (a: string, b: string): boolean => NUMBER.test(a) && /^[A-Za-z%×(]/.test(b) && !NOT_A_UNIT.has(b.toLowerCase());

/**
 * A line with a no-break space between each figure and its unit (`after 40 days.`), as rule 3 holds
 * them, and no other join: for words that keep their own pieces, such as an activity entry's.
 */
export const unitsKept = (text: string): string => text.replace(/([^ ]+) (?=([^ ]+))/g, (m, a: string, b: string) => (unitOf(lastPiece(a), firstPiece(b)) ? `${a}\u00a0` : m));

/** How strongly a number, a tally or a word that names a number holds the word after it, 0 where none does. */
function figureJoin(a: string, b: string, before: string | undefined, after: string | undefined): number {
  if (/\d$/.test(a) && b === 'of' && !!after && A_NUMBER.test(after)) return JOIN.figure;
  if (a === 'of' && !!before && /\d$/.test(before) && A_NUMBER.test(b)) return JOIN.figure;
  if (unitOf(a, b)) return JOIN.figure;
  if (NAMES_NUMBER.test(a) && A_NUMBER.test(b)) return JOIN.figure;
  if (/^rev(?:ision)?$/i.test(a) && REV_HASH.test(b)) return JOIN.figure;
  return 0;
}

/**
 * How strongly the space after word `i` holds the words beside it, 0 for a space that breaks
 * freely: the strongest of the joins that apply (rule 3), each word read as its piece beside the space.
 */
export function joinOf(words: readonly string[], i: number): number {
  const a = lastPiece(words[i]!);
  const b = firstPiece(words[i + 1]!);
  const before = words[i - 1] === undefined ? undefined : lastPiece(words[i - 1]!);
  const after = words[i + 2] === undefined ? undefined : firstPiece(words[i + 2]!);
  const al = lead(a);
  const bl = b.toLowerCase();
  let j = 0;
  const hold = (p: number) => void (j = Math.max(j, p));
  if (SEPARATOR.test(b) || (SIGN.test(a) && /^\d/.test(b))) hold(JOIN.sign);
  hold(figureJoin(a, b, before, after));
  // an operator holds the word before it where something follows it
  if (OPERATOR.test(b) && (after !== undefined || words[i + 1] !== b)) hold(JOIN.operator);
  if (compound(a, b, before, after) || (FLAG.test(a) && !SMALL.has(bl) && !/^[·→—…-]/.test(b))) hold(JOIN.compound);
  if (SMALL.has(al)) hold(SMALL.has(bl) ? JOIN.smalls : ARTICLES.has(al) ? JOIN.article : JOIN.small);
  if (OPERATOR.test(a)) hold(JOIN.after);
  return j;
}

/** The copy's words between its own spaces, each space with where it is and how long: an element is part of the word it sits in. */
function wordsOf(f: Flat): { words: string[]; gaps: Array<{ at: number; len: number }> } {
  const { str } = f;
  const gaps: Array<{ at: number; len: number }> = [];
  const words: string[] = [];
  let word = '';
  for (let i = 0; i < str.length; i++) {
    if (!ownSpace(f, i)) {
      word += str.charAt(i);
      continue;
    }
    const at = i;
    while (i + 1 < str.length && ownSpace(f, i + 1)) i++;
    if (word) {
      words.push(word);
      gaps.push({ at, len: i - at + 1 });
    }
    word = '';
  }
  if (word) words.push(word);
  // a space at the copy's end has no word after it
  gaps.length = Math.min(gaps.length, Math.max(0, words.length - 1));
  return { words, gaps };
}

/** The space before a block's or a sentence's last word, which holds it there: never one word alone on a line. */
const LAST = /[ \t\n\r]+(?=[^\s\u00a0]{1,24}$)/;

/**
 * Rule 3 over copy: where each of its own single spaces holds the words beside it, by its place in
 * the text, with how strongly. No space between two sentences (`free`) ever holds, and a block's
 * and each sentence's last two words (`ends`, where each ends) hold a little more than a number and
 * its noun, unless the first ends a clause of its own or is long.
 */
export function glueJoins(f: Flat, free: ReadonlySet<number> = new Set(), ends: readonly number[] = []): Map<number, number> {
  const joins = new Map<number, number>();
  const join = (at: number, p: number) => {
    if (!f.own[at] || free.has(at) || (joins.get(at) ?? 0) >= p) return;
    joins.set(at, p);
  };
  const { words, gaps } = wordsOf(f);
  gaps.forEach((g, k) => {
    const p = g.len === 1 ? joinOf(words, k) : 0;
    if (p) join(g.at, p);
  });
  for (const e of [f.str.replace(/[\s\u00a0]+$/, '').length, ...ends]) {
    const head = f.str.slice(0, e);
    const m = LAST.exec(head);
    if (!m || m[0].length !== 1) continue;
    const prev = /[^\s\u00a0]*$/.exec(head.slice(0, m.index))![0];
    if (prev.length && prev.length <= 18 && !/[.!?:;]$/.test(prev)) join(m.index, JOIN.last);
  }
  return joins;
}

/**
 * A run of joined words wider than its line gives up the weakest join whose giving way leaves both
 * sides fitting their line, or failing that its weakest, the one nearest its middle among equals,
 * and each side again, until every run fits or has no join left (`tsCap`): "Sign in" / "to
 * shadowlap.northwind.internal", never "Sign" alone. A run also ends where a long name may break
 * (`soft`). `fits` says whether a range of the text fits a line.
 */
export function capRuns(f: Flat, joins: Map<number, number>, fits: (a: number, z: number) => boolean, soft: ReadonlySet<number> = new Set()): void {
  const cut = (a: number, z: number): void => {
    if (fits(a, z)) return;
    const mid = (a + z) / 2;
    const inside = [...joins.keys()].filter((i) => i > a && i < z).sort((p, q) => joins.get(p)! - joins.get(q)! || Math.abs(p - mid) - Math.abs(q - mid));
    if (!inside.length) return;
    const best = inside.find((i) => fits(a, i) && fits(i + 1, z)) ?? inside[0]!;
    joins.delete(best);
    cut(a, best);
    cut(best + 1, z);
  };
  let a = -1;
  for (let i = 0; i <= f.str.length; i++) {
    const sp = i === f.str.length || ownSpace(f, i);
    if (sp && joins.has(i)) continue;
    if (!sp && soft.has(i) && a >= 0) {
      cut(a, i);
      a = i;
    } else if (sp) {
      if (a >= 0) cut(a, i);
      a = -1;
    } else if (a < 0) a = i;
  }
}

/** Text with a no-break space where a join holds. */
export function joined(str: string, joins: { has: (i: number) => boolean }): string {
  let out = '';
  for (let i = 0; i < str.length; i++) out += joins.has(i) ? '\u00a0' : str.charAt(i);
  return out;
}

/** The spaces between sentences, which never hold, and where each sentence ends: for two to four sentences. */
export function sentenceGaps(ranges: ReadonlyArray<readonly [number, number]>): { free: Set<number>; ends: number[] } {
  const free = new Set<number>();
  for (let k = 1; k < ranges.length; k++) for (let i = ranges[k - 1]![1]; i < ranges[k]![0]; i++) free.add(i);
  return { free, ends: ranges.map(([, b]) => b) };
}

/**
 * Rule 3 over a line of copy no `Copy` sets (a verdict's sentence, a heading, a caption): a no-break
 * space (U+00A0) where its words belong together, so no line ends on a small word, starts with a
 * separator or an operator, or splits a number from its unit, a tally, a compound noun, or a
 * sentence's last two words. A run of joined words gives way where it outgrows its line (`fits`;
 * unmeasured, past 30 characters, as a block not laid out yet does). For prose only: never code, a
 * command, JSON or anything a user copies to run, where the no-break space would be copied.
 */
export function glue(text: string, fits: (s: string) => boolean = (s) => s.length <= 30): string {
  const f = flatText(text);
  const ranges = text.length <= 640 ? sentenceRanges(f) : [];
  const { free, ends } = ranges.length >= 2 && ranges.length <= 4 ? sentenceGaps(ranges) : { free: new Set<number>(), ends: [] };
  const joins = glueJoins(f, free, ends);
  capRuns(f, joins, (a, z) => fits(text.slice(a, z)));
  return joined(text, joins);
}

// ---------------------------------------------------------------------------------------------- words kept whole

/** A request field set to an object or a list, as `--set` takes it: `thinking={"type":"adaptive"}`. */
const FIELD_SET = /^[A-Za-z_][\w.]*=[{[]/;
/** A word kept whole: one with a hyphen or a dash between two of its characters (a path or a URL among them), a flag, a range (`#1–#18`), a name with a dot in it, a field set to an object or a list. */
const KEPT = /(^|[\s\u00a0(“"‘[])([^\s\u00a0]*\w[-‐–][#\w][^\s\u00a0]*|--?[A-Za-z][^\s\u00a0]*|[^\s\u00a0]*[A-Za-z_]\.[A-Za-z_][^\s\u00a0]*|[A-Za-z_][\w.]*=[{[][^\s\u00a0]*)/g;
/**
 * A long one, which may break where its line can't hold it: after a dot or a hyphen, a host or a
 * dotted field of 24 characters or more and a hyphenated name of 28; a field set to an object or a
 * list, whatever its length, after its `=` and its value's commas.
 */
export const LONG = /^(?=[^\s\u00a0]{24,}$)[^/]*\w\.\w|^(?=[^\s\u00a0]{28,}$)[^/]*\w-\w|^[A-Za-z_][\w.]*=[{[]/;

/** A word kept whole, by its range: `w` nowrap, `long` a long name (whole where its line holds it), `path` broken only after a slash. */
export interface KeptWord {
  from: number;
  to: number;
  kind: 'w' | 'long' | 'path';
}

/**
 * The words of copy's own text a line never breaks inside (rule 4): each with a hyphen, a dash or
 * a dot in it, and each flag, kept whole in a nowrap element, never with a changed character, so a
 * copy of it is exact. One its line can't hold (`fits`) isn't held, since a nowrap piece never runs
 * out of its box, unless it is a long name, which then breaks only after a dot or a hyphen; a path
 * or a URL longer than a short line breaks only after a slash, never inside a name. Unmeasured
 * (`fits` null), each is held.
 */
export function keptWords(f: Flat, fits: ((word: string) => boolean) | null): KeptWord[] {
  const out: KeptWord[] = [];
  for (const m of f.str.matchAll(KEPT)) {
    const from = m.index + m[1]!.length;
    const w = m[2]!;
    const to = from + w.length;
    if (!f.own.slice(from, to).every(Boolean) || w.replace(/\W/g, '').length < 2) continue;
    const long = !w.includes('/') && LONG.test(w);
    if (fits && !fits(w) && !long) continue;
    out.push({ from, to, kind: long ? 'long' : w.length > 24 && pathPieces(w).length > 1 ? 'path' : 'w' });
  }
  return out;
}

/**
 * A long name's pieces, each ending on the dot or the hyphen after which it may break; a field set's
 * on its `=` and on each comma between its value's members, as code shown as text breaks after one.
 */
export const longPieces = (w: string): string[] => (FIELD_SET.test(w) ? w.split(/(?<==)(?=[{[])|(?<=,)(?=["{[])/) : w.split(/(?<=\w[.-])(?=\w)/));
/** A path's pieces, each ending on a slash after which it may break: never inside `//`, nor right after `:/`. */
export const pathPieces = (w: string): string[] => w.split(/(?<=[^/:]\/)(?!\/)/);
/**
 * A piece of code kept whole that a narrow line may not hold (a key with a URL in a tool call's
 * arguments), cut where a name or a path may break: after a dot or a hyphen between words, or after a
 * path's slash, never inside `//`. Joined, the pieces are the code.
 */
export const codeCuts = (s: string): string[] => s.split(/(?<=\w[.-])(?=\w)|(?<=[^/:]\/)(?!\/)/);

// ---------------------------------------------------------------------------------------------- code

/** A piece of code or a command: text kept on one line (`whole`) or free to wrap, or a place it may break. */
export type Piece = { text: string; whole: boolean } | { wbr: true };

const WBR: Piece = { wbr: true };

/** A <wbr> right before a space offers a break the space already offers; where a block balances its lines, Chromium crashes on one. */
export function wbrSafe<P extends object>(pieces: P[]): P[] {
  return pieces.filter((p, i) => {
    if (!('wbr' in p)) return true;
    const next = pieces[i + 1] as { text?: unknown } | undefined;
    return !(typeof next?.text === 'string' && next.text.startsWith(' '));
  });
}

/** Whether a space in code holds: what follows is an operator that ends there, or a number the word before it names. */
const HOLDS = /^ (?:(?:[<>!=]=?|→)(?: |$)|[#−-]?\d[\d.,]*(?![^\s),;:\]}]))/;

/** How code's pieces are put down: a character onto the piece being cut, the piece ended, a space or a break after it. */
interface PieceWriter {
  add: (s: string) => void;
  flush: () => void;
  push: (p: Piece) => void;
}

/** The pieces of one unquoted stretch of code, the `i`th of `parts`. */
function codeStretch(parts: readonly string[], i: number, put: PieceWriter): void {
  const part = parts[i]!;
  for (let k = 0; k < part.length; k++) {
    const ch = part.charAt(k);
    const key = k === 1 && part[0] === ':' && i > 0 ? parts[i - 1]! : null;
    const value = k + 1 < part.length ? (/^[^,}\]\s]*/.exec(part.slice(k + 1))?.[0] ?? '') : (parts[i + 1] ?? '');
    const keeps = key !== null && key.length + 2 + value.length <= 32;
    if (ch === ' ' && !keeps && !HOLDS.test(part.slice(k))) {
      put.flush();
      put.push({ text: ' ', whole: false });
      continue;
    }
    put.add(ch);
    if (/[,{[]/.test(ch) && !/[{[]/.test(part.charAt(k + 1))) {
      put.flush();
      put.push(WBR);
    }
  }
}

/**
 * Code shown as text (a failure line, a model's tool call, a decision's step, a command's JSON), cut
 * where it may wrap: at a space, after a comma or a run of opening braces and brackets, between the
 * words of a quoted value longer than 24 characters, and nowhere else. A JSON key keeps a value short
 * enough to share a narrow line with it (`"to": "customer@example.com"`, `"amount": 240`), a field
 * or a call its number (`amount 240`, `issue_refund #6:`), an operator the word before it, so no
 * line starts with `>`; an object of 30 characters or fewer stays whole. Joined, the pieces are the
 * code as written.
 */
export function codePieces(s: string): Piece[] {
  // short code with no space in it, and a short object or call however it is spaced, stays whole
  if (s.length <= 30 && (!/\s/.test(s) || /[{[]/.test(s))) return [{ text: s, whole: true }];
  const out: Piece[] = [];
  let cur = '';
  const put: PieceWriter = {
    add: (x) => void (cur += x),
    flush: () => {
      if (cur) out.push({ text: cur, whole: true });
      cur = '';
    },
    push: (p) => void out.push(p),
  };
  const parts = s.split(/("[^"]*")/);
  parts.forEach((part, i) => {
    if (i % 2 && part.length > 24) {
      part.split(' ').forEach((w, j) => {
        if (j) {
          put.flush();
          out.push({ text: ' ', whole: false });
        }
        cur += w;
      });
    } else if (i % 2) cur += part;
    else codeStretch(parts, i, put);
  });
  put.flush();
  return wbrSafe(out);
}

/**
 * Inline code with no space in it, as rule 4 cuts it: a longer path (over 32 characters) only after
 * a slash (never inside `//`), a longer host or dotted field after a dot that a word of five letters
 * or more follows, a list after its commas. Null for code none of that cuts, which is one piece,
 * whole where its line holds it. Joined, the pieces are the code.
 */
export function inlineCodeCuts(s: string): string[] | null {
  if (s.length <= 32 || /\s/.test(s)) return null;
  const parts = s.includes('/') ? pathPieces(s) : /\.\w{5}/.test(s) ? s.split(/(?<=\w\.)(?=\w{5})/) : s.includes(',') ? s.split(/(?<=,)/) : null;
  return parts && parts.length > 1 ? parts : null;
}
