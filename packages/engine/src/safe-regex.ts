/**
 * Patterns are code. A normalizer's or redaction rule's pattern comes from shadowlap.config.json and
 * the dashboard, and from a pack or the team store, which anyone may have written, and it runs on
 * every string of every recorded request and response, while recording, replaying and copying. A
 * JavaScript regular expression backtracks: one of the wrong shape tries every way to split the text
 * among its parts, so `(a+)+$` takes time that doubles with each character and stalls on thirty. So
 * before a pattern is compiled anywhere (compilePattern), it is read here and refused, with what to
 * change, when it could do that:
 *
 * - A backreference (`\1`, `\k<name>`), which only trying every split of the text can match.
 * - Inside a part that repeats (`*`, `+`, `{n,m}` with m over 1), a choice the next character
 *   doesn't settle: a quantifier whose part could go on with a character that can also come after
 *   it (`(a+)+`, `(\w+\s?)*`, `(.*,)+`), one that repeats a part that can match nothing (`(a?)*` as
 *   the part of a repeated group), or alternatives that can start with the same character
 *   (`(a|ab)*`, `(\w|\d)+`). Each such choice multiplies the ways at every repetition.
 * - Outside one, more than one part that repeats, or more than ten choices in all, that the next
 *   character doesn't settle (`.*a.*b`, `[a-z]*[a-z]*!`, or `a?` written out 25 times before
 *   `a{25}`): each one multiplies the ways too, by the length of the text or by two, and two such
 *   parts already take the cube of a line's length (10 seconds on 4 KB).
 * - A pattern longer than PATTERN_MAX characters.
 *
 * Whether the next character settles a choice is read from the characters each option can start
 * with and those that can come after it, the case-insensitive flag and Unicode properties included;
 * assertions and lookarounds are read as matching nothing, which can only make two options look
 * alike, never apart. A lookbehind is read right to left, as it runs.
 *
 * What passes takes time in proportion to the text at each place a match is tried, times at most the
 * text's length when it has a repeated part it can't settle: `.*x` reads a long line once for each
 * place it could start, and so does the plain `[\w.+-]+@`, whose part runs to the end of a long word
 * at each place in it. Anchor such a pattern, or bound it (`[^\n]{0,200}x`). So that even a pattern
 * this check takes can't stall a recording, a replay or a copy on a long text, every document's rules
 * run within a time budget (withinPatternBudget): past it, they are stopped and named.
 */

/** The longest pattern a rule may have, as written (`/…/flags`), wherever it comes from. */
export const PATTERN_MAX = 10_000;
/** At most this many parts that repeat, outside a repeated part, whose end the next character doesn't settle. */
const AMBIGUOUS_LOOPS = 1;
/** At most this many choices of any kind, outside a repeated part, that the next character doesn't settle. */
const AMBIGUOUS_CHOICES = 10;

// ---- sets of characters, as sorted ranges of code points ----

type Range = readonly [number, number];
type Chars = readonly Range[];

const EMPTY: Chars = [];

function normalized(ranges: Array<[number, number]>): Chars {
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [[ranges[0]![0], ranges[0]![1]]];
  for (const [lo, hi] of ranges.slice(1)) {
    const last = out[out.length - 1]!;
    if (lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

function union(...sets: Chars[]): Chars {
  const all = sets.flat();
  return all.length ? normalized(all.map(([a, b]) => [a, b] as [number, number])) : EMPTY;
}

function intersection(a: Chars, b: Chars): Chars {
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i]![0], b[j]![0]);
    const hi = Math.min(a[i]![1], b[j]![1]);
    if (lo <= hi) out.push([lo, hi]);
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return out;
}

function complement(set: Chars, max: number): Chars {
  const out: Array<[number, number]> = [];
  let next = 0;
  for (const [lo, hi] of set) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= max) out.push([next, max]);
  return out;
}

function has(set: Chars, cp: number): boolean {
  let lo = 0;
  let hi = set.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < set[mid]![0]) hi = mid - 1;
    else if (cp > set[mid]![1]) lo = mid + 1;
    else return true;
  }
  return false;
}

const one = (cp: number): Chars => [[cp, cp]];
const LINE_TERMINATORS: Chars = [[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]];
const DIGITS: Chars = [[0x30, 0x39]];
const WORD: Chars = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
const SPACES: Chars = [[0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff]];

/**
 * Characters that are the same letter in another case, as groups: every code point joined to its
 * lower and upper case (where each is one code point), which covers what both case-insensitive
 * matchings (`i`, and `i` with `u` or `v`) take as equal, and a little more. Built once, when a
 * case-insensitive pattern is first read.
 */
let cases: { cased: number[]; group: Map<number, number[]> } | null = null;

function caseGroups(): NonNullable<typeof cases> {
  if (cases) return cases;
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const join = (a: number, b: number) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  // Every cased letter is below U+20000.
  for (let cp = 0; cp < 0x20000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    for (const other of [c.toLowerCase(), c.toUpperCase()]) {
      const o = other.codePointAt(0)!;
      if (o !== cp && String.fromCodePoint(o) === other) join(cp, o);
    }
  }
  const members = new Map<number, number[]>();
  for (const cp of parent.keys()) {
    const r = find(cp);
    const list = members.get(r) ?? [];
    list.push(cp);
    members.set(r, list);
  }
  const group = new Map<number, number[]>();
  for (const list of members.values()) for (const cp of list) group.set(cp, list);
  cases = { cased: [...group.keys()].sort((a, b) => a - b), group };
  return cases;
}

/** A set with every character the same letter as one of it, in any case. */
function caseClosed(set: Chars): Chars {
  if (!set.length) return set;
  const { cased, group } = caseGroups();
  const extra: Array<[number, number]> = [];
  const size = set.reduce((n, [lo, hi]) => n + hi - lo + 1, 0);
  // A few characters (a letter, a short range) by their own groups; a large set by every cased one.
  if (size <= 256) {
    for (const [lo, hi] of set) for (let cp = lo; cp <= hi; cp++) for (const o of group.get(cp) ?? []) extra.push([o, o]);
  } else for (const cp of cased) if (has(set, cp)) for (const o of group.get(cp)!) extra.push([o, o]);
  return extra.length ? union(set, extra) : set;
}

/** Every code point but the surrogates, in order, for reading a Unicode property's set off the engine itself. */
let everyCodePoint: string | null = null;

/** The code point at a position of everyCodePoint (U+0000–U+D7FF, then U+E000–U+FFFF, then two units each). */
function codePointAt(index: number): number {
  if (index < 0xd800) return index;
  if (index < 0xf800) return index + 0x800;
  return 0x10000 + Math.floor((index - 0xf800) / 2);
}

const properties = new Map<string, Chars>();

/**
 * The characters a Unicode property escape (`\p{L}`, `\P{Script=Greek}`) matches under `flags`, as
 * the engine itself reads it: its runs in a text of every code point, and each lone surrogate on
 * its own. Remembered for the process.
 */
function propertyChars(escape: string, flags: string): Chars {
  const key = `${escape}\u0000${flags}`;
  const known = properties.get(key);
  if (known) return known;
  if (everyCodePoint === null) {
    const parts: string[] = [];
    const push = (from: number, to: number) => {
      for (let cp = from; cp <= to; cp += 8192) parts.push(String.fromCodePoint(...Array.from({ length: Math.min(8192, to - cp + 1) }, (_, k) => cp + k)));
    };
    push(0, 0xd7ff);
    push(0xe000, 0x10ffff);
    everyCodePoint = parts.join('');
  }
  const out: Array<[number, number]> = [];
  const runs = new RegExp(`(?:${escape})+`, `g${flags}`);
  for (const m of everyCodePoint.matchAll(runs)) {
    const from = codePointAt(m.index);
    const to = codePointAt(m.index + m[0].length - 1);
    if (from < 0xd800 && to >= 0xe000) out.push([from, 0xd7ff], [0xe000, to]);
    else out.push([from, to]);
  }
  const alone = new RegExp(`^(?:${escape})$`, flags);
  for (let cp = 0xd800; cp <= 0xdfff; cp++) if (alone.test(String.fromCharCode(cp))) out.push([cp, cp]);
  const set = normalized(out);
  properties.set(key, set);
  return set;
}

// ---- reading a pattern ----

type Node =
  | { type: 'char'; set: Chars; from: number; to: number }
  | { type: 'empty'; from: number; to: number }
  | { type: 'seq'; items: Node[]; from: number; to: number }
  | { type: 'alt'; branches: Node[]; from: number; to: number }
  | { type: 'group'; body: Node; from: number; to: number }
  | { type: 'look'; body: Node; behind: boolean; from: number; to: number }
  | { type: 'quant'; body: Node; min: number; max: number; from: number; to: number };

/** A pattern this check refuses, with the reason in words. */
class Refused extends Error {}
/** Syntax the parser below doesn't read: the pattern is refused, never passed unread. */
class Unread extends Error {}

class Reader {
  i = 0;
  private readonly unicode: boolean;
  private readonly sets: boolean;
  private readonly named: boolean;
  private readonly max: number;
  /** The case-insensitive and dot-all flags in force, as group modifiers change them. */
  private flags: { i: boolean; s: boolean };

  constructor(
    private readonly s: string,
    private readonly flagText: string,
  ) {
    this.unicode = /[uv]/.test(flagText);
    this.sets = flagText.includes('v');
    this.named = /\(\?<(?![=!])/.test(s);
    this.max = this.unicode ? 0x10ffff : 0xffff;
    this.flags = { i: flagText.includes('i'), s: flagText.includes('s') };
  }

  read(): Node {
    const node = this.disjunction();
    if (this.i < this.s.length) throw new Unread(`an unexpected "${this.s[this.i]!}"`);
    return node;
  }

  private disjunction(): Node {
    const from = this.i;
    const branches = [this.alternative()];
    while (this.s[this.i] === '|') {
      this.i++;
      branches.push(this.alternative());
    }
    return branches.length === 1 ? branches[0]! : { type: 'alt', branches, from, to: this.i };
  }

  private alternative(): Node {
    const from = this.i;
    const items: Node[] = [];
    while (this.i < this.s.length && this.s[this.i] !== '|' && this.s[this.i] !== ')') items.push(this.term());
    return { type: 'seq', items, from, to: this.i };
  }

  private term(): Node {
    const from = this.i;
    const s = this.s;
    const c = s[this.i]!;
    if (c === '^' || c === '$') {
      this.i++;
      return { type: 'empty', from, to: this.i };
    }
    if (c === '\\' && (s[this.i + 1] === 'b' || s[this.i + 1] === 'B')) {
      this.i += 2;
      return { type: 'empty', from, to: this.i };
    }
    if (s.startsWith('(?=', this.i) || s.startsWith('(?!', this.i) || s.startsWith('(?<=', this.i) || s.startsWith('(?<!', this.i)) {
      const behind = s[this.i + 2] === '<';
      this.i += behind ? 4 : 3;
      const body = this.disjunction();
      this.expect(')');
      const look: Node = { type: 'look', body, behind, from, to: this.i };
      // A lookahead may be quantified outside Unicode mode; it matches nothing all the same.
      if (!behind && !this.unicode) this.quantifier();
      return look;
    }
    let atom: Node;
    if (c === '(') atom = this.group();
    else if (c === '[') atom = { type: 'char', set: this.cased(this.charClass()), from, to: this.i };
    else if (c === '.') {
      this.i++;
      atom = { type: 'char', set: this.flags.s ? [[0, this.max]] : complement(LINE_TERMINATORS, this.max), from, to: this.i };
    } else if (c === '\\') atom = this.atomEscape();
    else {
      if ('*+?)'.includes(c) || (this.unicode && '{}]'.includes(c))) throw new Unread(`"${c}" where a character belongs`);
      atom = { type: 'char', set: this.cased(one(this.literal())), from, to: this.i };
    }
    const q = this.quantifier();
    return q ? { type: 'quant', body: atom, min: q[0], max: q[1], from, to: this.i } : atom;
  }

  private group(): Node {
    const from = this.i;
    const s = this.s;
    const saved = this.flags;
    if (s.startsWith('(?:', this.i)) this.i += 3;
    else if (s.startsWith('(?<', this.i)) {
      const end = s.indexOf('>', this.i);
      if (end < 0) throw new Unread('a group name without its ">"');
      this.i = end + 1;
    } else if (s.startsWith('(?', this.i)) {
      // Modifiers for the group: (?i:…), (?-i:…), (?s-i:…).
      const m = /^\(\?([ims]*)(?:-([ims]*))?:/.exec(s.slice(this.i));
      if (!m) throw new Unread('a group of a kind this check does not know');
      const on = m[1] ?? '';
      const off = m[2] ?? '';
      this.flags = { i: (this.flags.i || on.includes('i')) && !off.includes('i'), s: (this.flags.s || on.includes('s')) && !off.includes('s') };
      this.i += m[0].length;
    } else this.i++;
    const body = this.disjunction();
    this.expect(')');
    this.flags = saved;
    return { type: 'group', body, from, to: this.i };
  }

  /** `[min, max]` of a quantifier at the reading position, or null when none is there. */
  private quantifier(): [number, number] | null {
    const s = this.s;
    const c = s[this.i];
    let q: [number, number] | null = null;
    if (c === '*') q = [0, Infinity];
    else if (c === '+') q = [1, Infinity];
    else if (c === '?') q = [0, 1];
    if (q) this.i++;
    else if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(s.slice(this.i, this.i + 40));
      if (!m) return null; // outside Unicode mode, a brace that starts no quantifier is a character
      const min = Number(m[1]);
      q = [min, m[2] === undefined ? min : m[3] ? Number(m[3]) : Infinity];
      this.i += m[0].length;
    }
    if (q && s[this.i] === '?') this.i++;
    return q;
  }

  private atomEscape(): Node {
    const from = this.i;
    const s = this.s;
    const e = s[this.i + 1];
    if (e === undefined) throw new Unread('a pattern that ends in "\\"');
    const backref = (text: string): never => {
      throw new Refused(`"${text}" refers back to a group, which matching can only check by trying every way to split the text: match the text itself`);
    };
    if (/[1-9]/.test(e)) backref(/^\\\d+/.exec(s.slice(this.i))![0]);
    if (e === 'k' && (this.unicode || this.named)) backref(/^\\k(?:<[^>]*>)?/.exec(s.slice(this.i))![0]);
    const set = this.classEscape();
    if (set) return { type: 'char', set: this.cased(set), from, to: this.i };
    return { type: 'char', set: this.cased(one(this.characterEscape())), from, to: this.i };
  }

  /** The set of a class escape at the reading position (`\d`, `\W`, `\p{L}`), read past it; null for none. */
  private classEscape(): Chars | null {
    const s = this.s;
    const e = s[this.i + 1];
    const sets: Record<string, Chars> = { d: DIGITS, w: this.unicode && this.flags.i ? union(WORD, one(0x17f), one(0x212a)) : WORD, s: SPACES };
    if (e && 'dwsDWS'.includes(e)) {
      this.i += 2;
      const base = sets[e.toLowerCase()]!;
      return e === e.toLowerCase() ? base : complement(base, this.max);
    }
    if ((e === 'p' || e === 'P') && this.unicode) {
      const m = /^\\[pP]\{[^}]*\}/.exec(s.slice(this.i));
      if (!m) throw new Unread('a property escape without its "}"');
      this.i += m[0].length;
      return propertyChars(m[0], `${this.sets ? 'v' : 'u'}${this.flags.i ? 'i' : ''}`);
    }
    return null;
  }

  /** The code point of a character escape at the reading position (`\n`, `\x41`, `\u{1F600}`, `\/`), read past it. */
  private characterEscape(): number {
    const s = this.s;
    const e = s[this.i + 1]!;
    const hex = (from: number, n: number): number | null => {
      const t = s.slice(from, from + n);
      return t.length === n && /^[0-9a-fA-F]+$/.test(t) ? parseInt(t, 16) : null;
    };
    const simple: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };
    if (e in simple) {
      this.i += 2;
      return simple[e]!;
    }
    if (e === 'c') {
      if (/[A-Za-z]/.test(s[this.i + 2] ?? '')) {
        this.i += 3;
        return s.charCodeAt(this.i - 1) % 32;
      }
      // Outside Unicode mode, "\c" with no letter after it is a backslash, and the "c" a character of its own.
      this.i += 1;
      return 0x5c;
    }
    if (e === '0' && !/\d/.test(s[this.i + 2] ?? '')) {
      this.i += 2;
      return 0;
    }
    if (/[0-7]/.test(e) && !this.unicode) {
      // An old octal escape, outside Unicode mode: \0 followed by digits, or inside a class.
      const m = /^[0-7]{1,3}/.exec(s.slice(this.i + 1))!;
      const digits = parseInt(m[0], 8) > 0o377 ? m[0].slice(0, 2) : m[0];
      this.i += 1 + digits.length;
      return parseInt(digits, 8);
    }
    if (e === 'x') {
      const v = hex(this.i + 2, 2);
      if (v !== null) {
        this.i += 4;
        return v;
      }
    }
    if (e === 'u') {
      if (s[this.i + 2] === '{' && this.unicode) {
        const end = s.indexOf('}', this.i);
        const v = parseInt(s.slice(this.i + 3, end), 16);
        this.i = end + 1;
        return v;
      }
      const v = hex(this.i + 2, 4);
      if (v !== null) {
        this.i += 6;
        // A surrogate pair written as two escapes is one character in Unicode mode.
        if (this.unicode && v >= 0xd800 && v <= 0xdbff && s.startsWith('\\u', this.i)) {
          const low = hex(this.i + 2, 4);
          if (low !== null && low >= 0xdc00 && low <= 0xdfff) {
            this.i += 6;
            return 0x10000 + ((v - 0xd800) << 10) + (low - 0xdc00);
          }
        }
        return v;
      }
    }
    // Any other escaped character stands for itself.
    this.i += 1;
    return this.literal();
  }

  /** The character at the reading position, as itself: a code point in Unicode mode, a code unit outside it. */
  private literal(): number {
    const cp = this.unicode ? this.s.codePointAt(this.i)! : this.s.charCodeAt(this.i);
    this.i += cp > 0xffff ? 2 : 1;
    return cp;
  }

  /** A character class at the reading position (`[a-z\d]`, `[^"]`, a nested one with `v`), read past it. */
  private charClass(): Chars {
    const s = this.s;
    this.i++;
    const negated = s[this.i] === '^';
    if (negated) this.i++;
    const parts: Chars[] = [];
    while (this.i < s.length && s[this.i] !== ']') {
      if (this.sets) {
        // Unicode sets: nested classes, ranges, and the set operators, read as joining their sides,
        // which holds every character the class can match.
        if (s.startsWith('--', this.i) || s.startsWith('&&', this.i)) {
          this.i += 2;
          continue;
        }
        if (s[this.i] === '[') {
          parts.push(this.charClass());
          continue;
        }
        if (s.startsWith('\\q{', this.i)) throw new Refused('"\\q{…}" sets out strings, which this check does not read: write them as alternatives (a|bc)');
      }
      const a = this.classAtom();
      if (s[this.i] === '-' && s[this.i + 1] !== ']' && s[this.i + 1] !== undefined && !(this.sets && s[this.i + 1] === '-')) {
        this.i++;
        const b = this.classAtom();
        if (typeof a === 'number' && typeof b === 'number') {
          parts.push([[a, b]]);
          continue;
        }
        // A range with a class escape at either end: its three parts, outside Unicode mode.
        parts.push(typeof a === 'number' ? one(a) : a, one(0x2d), typeof b === 'number' ? one(b) : b);
        continue;
      }
      parts.push(typeof a === 'number' ? one(a) : a);
    }
    if (s[this.i] !== ']') throw new Unread('a class without its "]"');
    this.i++;
    const set = union(...parts);
    return negated ? complement(set, this.max) : set;
  }

  /** A character, or a class escape's set, in a class. */
  private classAtom(): number | Chars {
    const s = this.s;
    if (s[this.i] !== '\\') return this.literal();
    if (s[this.i + 1] === 'b') {
      this.i += 2;
      return 8;
    }
    if (s[this.i + 1] === '-') {
      this.i += 2;
      return 0x2d;
    }
    return this.classEscape() ?? this.characterEscape();
  }

  /** A set as the case-insensitive flag, when in force, reads it. */
  private cased(set: Chars): Chars {
    return this.flags.i ? caseClosed(set) : set;
  }

  private expect(c: string): void {
    if (this.s[this.i] !== c) throw new Unread(`"${c}" missing`);
    this.i++;
  }
}

// ---- reading what can follow what ----

interface Info {
  nullable: boolean;
  first: Chars;
}

/** A choice the next character doesn't settle, outside a repeated part. */
interface Unsettled {
  node: Node;
  loop: boolean;
}

class Checker {
  private readonly memo = [new Map<Node, Info>(), new Map<Node, Info>()];

  constructor(private readonly source: string) {}

  /** Whether `n` can match nothing, and the characters it can start with; read right to left with `rev`. */
  info(n: Node, rev: boolean): Info {
    const memo = this.memo[rev ? 1 : 0]!;
    const known = memo.get(n);
    if (known) return known;
    let out: Info;
    switch (n.type) {
      case 'char':
        out = { nullable: false, first: n.set };
        break;
      case 'empty':
      case 'look':
        out = { nullable: true, first: EMPTY };
        break;
      case 'group':
        out = this.info(n.body, rev);
        break;
      case 'quant': {
        const body = this.info(n.body, rev);
        out = n.max === 0 ? { nullable: true, first: EMPTY } : { nullable: n.min === 0 || body.nullable, first: body.first };
        break;
      }
      case 'alt': {
        const all = n.branches.map((b) => this.info(b, rev));
        out = { nullable: all.some((b) => b.nullable), first: union(...all.map((b) => b.first)) };
        break;
      }
      case 'seq': {
        const firsts: Chars[] = [];
        let nullable = true;
        for (const item of rev ? [...n.items].reverse() : n.items) {
          const i = this.info(item, rev);
          firsts.push(i.first);
          if (!i.nullable) {
            nullable = false;
            break;
          }
        }
        out = { nullable, first: union(...firsts) };
        break;
      }
    }
    memo.set(n, out);
    return out;
  }

  /**
   * Reads `n`, which `after` can follow, inside the repeated parts `loops`: refuses a choice the next
   * character doesn't settle in one of them, and keeps the others in `unsettled`.
   */
  walk(n: Node, after: Chars, loops: Node[], rev: boolean, unsettled: Unsettled[]): void {
    switch (n.type) {
      case 'char':
      case 'empty':
        return;
      case 'group':
        return this.walk(n.body, after, loops, rev, unsettled);
      case 'look': {
        // Matched on its own, and never tried again once it has: its choices count apart.
        const own: Unsettled[] = [];
        this.walk(n.body, EMPTY, [], n.behind, own);
        this.limit(own);
        return;
      }
      case 'seq': {
        const items = rev ? [...n.items].reverse() : n.items;
        let follow = after;
        for (let k = items.length - 1; k >= 0; k--) {
          this.walk(items[k]!, follow, loops, rev, unsettled);
          const i = this.info(items[k]!, rev);
          follow = i.nullable ? union(i.first, follow) : i.first;
        }
        return;
      }
      case 'alt': {
        const options = n.branches.map((b) => {
          const i = this.info(b, rev);
          return { node: b, starts: i.nullable ? union(i.first, after) : i.first };
        });
        let seen: Chars = EMPTY;
        for (const [k, o] of options.entries()) {
          const shared = intersection(seen, o.starts);
          if (shared.length) {
            const other = options.slice(0, k).find((p) => intersection(p.starts, o.starts).length)!;
            if (loops.length) throw new Refused(`the alternatives "${this.shown(other.node)}" and "${this.shown(o.node)}" can both start with ${charName(intersection(other.starts, o.starts)[0]![0])} inside "${this.shown(loops[loops.length - 1]!)}", which repeats them, so they can split the same text in exponentially many ways: start them differently, or join them into one part ([ab] for a|b)`);
            unsettled.push({ node: n, loop: false });
            break;
          }
          seen = union(seen, o.starts);
        }
        for (const b of n.branches) this.walk(b, after, loops, rev, unsettled);
        return;
      }
      case 'quant': {
        if (n.max === 0) return;
        const body = this.info(n.body, rev);
        if (n.min !== n.max) {
          const shared = intersection(body.first, after);
          if (loops.length) {
            const around = this.shown(loops[loops.length - 1]!);
            if (body.nullable) throw new Refused(`"${this.shown(n)}" repeats a part that can match nothing inside "${around}", which repeats too, so the two can split the same text in exponentially many ways: make the inner part match at least one character`);
            if (shared.length) throw new Refused(`"${this.shown(n)}" can stop or go on at ${charName(shared[0]![0])} inside "${around}", which repeats too, so the two can split the same text in exponentially many ways: end the inner part at a character it can't take itself (\\w+\\. rather than \\w+), or repeat only one of them`);
          } else if (body.nullable || shared.length) unsettled.push({ node: n, loop: n.max > 1 });
        }
        const repeats = n.max > 1;
        this.walk(n.body, repeats ? union(body.first, after) : after, repeats ? [...loops, n] : loops, rev, unsettled);
        return;
      }
    }
  }

  /**
   * The repeated parts that multiply the time as an unsettled one does, though the next character
   * settles them: one that follows, in the same sequence, a part that repeats unsettled and can take
   * its characters, with something after it that can fail (`[a-z]*[a-z]*!`, `[^b]*a[^b]*b`). When
   * that something fails, the earlier part tries every place to stop and this one every length after
   * it: the cube of the text's length, as two unsettled parts take. A part the pattern ends with
   * (`\w+\s*\w+`) has nothing after it to fail, and multiplies nothing. Groups are seen through;
   * the inside of a repeated part and of a lookaround are read apart, as walk reads them.
   */
  chained(n: Node, after: Chars, unsettled: readonly Unsettled[], out: Unsettled[], rev = false): void {
    const marked = new Set(unsettled.map((u) => u.node));
    const flat = (x: Node): Node[] => (x.type === 'group' ? flat(x.body) : x.type === 'seq' ? x.items.flatMap(flat) : [x]);
    const visit = (x: Node, follow: Chars): void => {
      if (x.type === 'group') return visit(x.body, follow);
      if (x.type === 'alt') {
        for (const b of x.branches) visit(b, follow);
        return;
      }
      // A repeated part's inside, and a lookaround's, are walked apart; their loops are refused there or not at all.
      if (x.type !== 'seq') return;
      const items = rev ? [...flat(x)].reverse() : flat(x);
      // What can follow each item, right to left, as walk reads it.
      const follows: Chars[] = new Array<Chars>(items.length);
      let next = follow;
      for (let k = items.length - 1; k >= 0; k--) {
        follows[k] = next;
        const i = this.info(items[k]!, rev);
        next = i.nullable ? union(i.first, next) : i.first;
      }
      let earlier: Chars = EMPTY;
      items.forEach((item, k) => {
        if (item.type === 'alt') {
          for (const b of item.branches) visit(b, follows[k]!);
          return;
        }
        if (item.type !== 'quant' || item.max <= 1 || item.min === item.max) return;
        const body = this.info(item.body, rev);
        if (marked.has(item)) earlier = union(earlier, body.first);
        else if (earlier.length && intersection(body.first, earlier).length && follows[k]!.length) out.push({ node: item, loop: true });
      });
    };
    visit(n, after);
  }

  /** Refuses more unsettled choices outside repeated parts than LIMIT allows. */
  limit(unsettled: Unsettled[]): void {
    const loops = unsettled.filter((u) => u.loop);
    if (loops.length > AMBIGUOUS_LOOPS) {
      const named = `${loops.slice(0, 3).map((u) => `"${this.shown(u.node)}"`).join(', ')}${loops.length > 3 ? ', …' : ''}`;
      throw new Refused(`${loops.length} of its repeated parts (${named}) can each stop or go on at a character that can come after them, so matching tries every way to share the text among them, in time that grows with the text's length to the power of ${loops.length}: anchor them, separate them with characters they can't take, or bound them ({0,200})`);
    }
    if (unsettled.length > AMBIGUOUS_CHOICES) throw new Refused(`it holds ${unsettled.length} optional or alternative parts that the next character doesn't settle, so matching can try 2^${unsettled.length} ways at each place: make them start differently, or drop some`);
  }

  /** A part of the pattern as written, short. */
  shown(n: Node): string {
    const text = this.source.slice(n.from, n.to);
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  }
}

/** A character for a message: itself when it is plain to read, else its escape. */
function charName(cp: number): string {
  if (cp === 0x20) return 'a space';
  if (cp > 0x20 && cp < 0x7f) return `"${String.fromCharCode(cp)}"`;
  return cp > 0xffff ? `\\u{${cp.toString(16).toUpperCase()}}` : `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Why a regular expression's source and flags can't be a rule's pattern, in words; null when they can. */
export function regexProblem(source: string, flags: string): string | null {
  if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length || (flags.includes('u') && flags.includes('v'))) return `its flags "${flags}" aren't flags a regular expression takes (d, g, i, m, s, u or v, y; each once, and not u with v)`;
  try {
    new RegExp(source, flags);
  } catch (err) {
    // The engine's words, without the pattern it repeats ("Invalid regular expression: /(/g: …").
    const words = (err instanceof Error ? err.message : String(err)).replace(/^Invalid regular expression: \/.*\/[a-z]*: /s, '');
    return `it isn't a regular expression: ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
  }
  try {
    const root = new Reader(source, flags).read();
    const checker = new Checker(source);
    const unsettled: Unsettled[] = [];
    checker.walk(root, EMPTY, [], false, unsettled);
    // Settled parts that follow an unsettled one they overlap multiply its time too (chained).
    const chained: Unsettled[] = [];
    checker.chained(root, EMPTY, unsettled, chained);
    checker.limit([...unsettled, ...chained]);
    return null;
  } catch (err) {
    if (err instanceof Refused) return `matching it could take too long: ${err.message}`;
    if (err instanceof Unread) return `it uses syntax the pattern check doesn't read (${err.message}), so it isn't run`;
    throw err;
  }
}

const checked = new Map<string, string | null>();

/**
 * Why a rule's pattern (a named pattern, or a `/regex/flags` literal) is refused, in words starting
 * with the pattern itself; null when it is fine. Remembered for the process, since every rule is
 * compiled again for each string it is applied to.
 */
export function patternProblem(pattern: string, named: readonly string[]): string | null {
  const known = checked.get(pattern);
  if (known !== undefined) return known;
  const shown = pattern.length > 60 ? `${pattern.slice(0, 59)}…` : pattern;
  let problem: string | null = null;
  if (pattern.length > PATTERN_MAX) problem = `${shown} is ${pattern.length} characters long, over the ${PATTERN_MAX} a pattern may be`;
  else if (!named.includes(pattern)) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
    if (!m) problem = `unknown pattern "${shown}": use one of ${named.join(', ')} or a /regex/ literal`;
    else {
      const why = regexProblem(m[1]!, m[2]!);
      if (why) problem = `${shown}: ${why}`;
    }
  }
  if (checked.size > 10_000) checked.clear();
  checked.set(pattern, problem);
  return problem;
}

// ---- the time budget every document's rules run within ----

/** How long one document's rules may run before they are stopped: far past what any rule this check takes needs on a real request. */
export const PATTERN_BUDGET_MS = 5_000;
/**
 * A document this many characters long or shorter runs its rules without a budget: even a pattern
 * whose time grows with the square of the text ends on it within a few milliseconds, and budgeting
 * costs a tenth of a millisecond.
 */
const UNBUDGETED_CHARS = 8 * 1024;

let budgetMs = PATTERN_BUDGET_MS;

/**
 * The budget, shorter for a test; Infinity for none, where something else stops the thread (the
 * dashboard's redaction preview ends its own at its hard limit); null puts back PATTERN_BUDGET_MS.
 */
export function setPatternBudget(ms: number | null): void {
  budgetMs = ms ?? PATTERN_BUDGET_MS;
}

/** Rules a document's text took longer than the budget to run, stopped: named, with what to change. */
export class PatternBudgetError extends Error {
  constructor(
    readonly patterns: readonly string[],
    readonly ms: number,
  ) {
    const named = patterns.slice(0, 3).map((p) => (p.length > 60 ? `${p.slice(0, 59)}…` : p)).join(', ');
    super(`a rule's pattern ran longer than ${ms / 1000} s on one document and was stopped (${named || 'its rules'}): a pattern that reads a long text from every place it could start, such as .*x, takes time that grows with the square of the text; anchor it or bound it, such as [^\\n]{0,200}x`);
    this.name = 'PatternBudgetError';
  }
}

type Vm = typeof import('node:vm');
let vm: Vm | null | undefined;
let runner: { context: { run: (() => unknown) | null }; script: import('node:vm').Script } | null = null;
let inside = false;

/** Node's vm module, read when first needed: none in a browser, where these rules never run on a recording. */
function vmModule(): Vm | null {
  if (vm === undefined) vm = typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:vm') : null;
  return vm;
}

/**
 * Runs `fn`, which applies rules to one document of `chars` characters, within the time budget:
 * past it the script running it is stopped where it is, inside a match if need be, and a
 * PatternBudgetError names `patterns()`. A short document, or one inside a budget already, runs as it
 * is. JavaScript's regular expressions can't be stopped part way any other way, and a check of a
 * pattern's shape can't bound every pattern's time on every text.
 */
export function withinPatternBudget<T>(chars: number, patterns: () => readonly string[], fn: () => T): T {
  if (inside || chars <= UNBUDGETED_CHARS || budgetMs === Infinity) return fn();
  const v = vmModule();
  if (!v) return fn();
  if (!runner) {
    const context = v.createContext({ run: null }) as { run: (() => unknown) | null };
    runner = { context, script: new v.Script('run()') };
  }
  const r = runner;
  inside = true;
  r.context.run = fn;
  try {
    return r.script.runInContext(r.context, { timeout: budgetMs }) as T;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new PatternBudgetError(patterns(), budgetMs);
    throw err;
  } finally {
    r.context.run = null;
    inside = false;
  }
}

/** The characters of every string in a JSON-like value, keys included: what its rules read. */
export function textSize(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length;
  if (value === null || typeof value !== 'object' || depth > 64 || ArrayBuffer.isView(value)) return 0;
  let n = 0;
  if (Array.isArray(value)) for (const x of value) n += textSize(x, depth + 1);
  else for (const [k, x] of Object.entries(value)) n += k.length + textSize(x, depth + 1);
  return n;
}
