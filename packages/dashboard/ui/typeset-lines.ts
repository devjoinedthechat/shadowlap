import {
  capRuns,
  flatten,
  glueJoins,
  joined,
  keptWords,
  LONG,
  ownSpace,
  sentenceGaps,
  sentenceRanges,
  trimRange,
  WEAK,
  type CopyPart,
  type Flat,
  type KeptWord,
} from './typeset.js';

/**
 * Copy set at the width it has (rules 1 to 4, typeset.ts states them): which sentences stay whole,
 * which balance and which flow, where a sentence breaks after a clause, which joins hold and which
 * give way, and which words and elements keep whole. The same decisions the mock's typeset() pass
 * makes over the page (tsSettle, tsCap, tsCost, tsWidow, tsClauses, tsSplitSents), made here over
 * copy's text and what a canvas measured of it, before React draws it. No DOM here: the tests import it.
 */

/** What copy is measured with: a line's width, a text's width in the block's font, an element's in its own. */
export interface CopyMeasure {
  width: number;
  text: (s: string) => number;
  atom: (i: number) => number;
}

/** How a sentence of short copy sets: whole on its line, its two lines balanced on a line of their own, or flowing as prose does. */
export type SentenceSet = 'whole' | 'balanced' | 'flow';

/** A sentence, or a piece of one broken at a clause, set as one: its range, how it sets, and whether it goes on a sentence (`cont`) or the sentence goes on after it (`open`). */
export interface CopyUnit {
  from: number;
  to: number;
  set: SentenceSet;
  cont?: boolean;
  open?: boolean;
}

/** What `Copy` draws. */
export interface CopyPlan {
  /** The copy's text, a no-break space where a join holds. */
  text: string;
  /** The block's wrap: two lines at most balance (`ts-bal`), more wrap pretty. */
  wrap: 'ts-bal' | 'ts-pretty' | null;
  /** Its sentences, or the pieces of one broken at a clause; null for copy set as one. */
  units: CopyUnit[] | null;
  /** Its words kept whole. */
  words: KeptWord[];
  /** Whether each long name (by where it starts) is whole on its line, null where nothing measured it. */
  long: ReadonlyMap<number, boolean | null>;
  /** The elements wider than a line, which wrap inside themselves. */
  wide: ReadonlySet<number>;
}

// ---------------------------------------------------------------------------------------------- the line model

/** A word, a space or an element as a greedy line breaker sees it: its width, and whether a line may break there. */
export interface Tok {
  i: number;
  len: number;
  sp: boolean;
  brk: boolean;
  w: number;
  own: boolean;
}

/** Copy's tokens: each run of its own spaces (a line may break there), of no-break spaces, or of anything else, and each element whole. */
export function tokens(f: Flat, m: CopyMeasure): Tok[] {
  const out: Tok[] = [];
  const space = m.text(' ');
  const { str, atoms } = f;
  let k = 0;
  for (let i = 0; i < str.length || k < atoms.length; ) {
    const a = atoms[k];
    if (a && a.from <= i) {
      out.push({ i: a.from, len: a.to - a.from, sp: false, brk: false, w: m.atom(a.atom), own: false });
      i = Math.max(i, a.to);
      k++;
      continue;
    }
    const stop = a ? a.from : str.length;
    let j = i + 1;
    if (ownSpace(f, i)) {
      while (j < stop && ownSpace(f, j)) j++;
      out.push({ i, len: j - i, sp: true, brk: true, w: space, own: true });
    } else {
      const nb = str[i] === '\u00a0';
      while (j < stop && !ownSpace(f, j) && (str[j] === '\u00a0') === nb) j++;
      out.push({ i, len: j - i, sp: nb, brk: false, w: m.text(str.slice(i, j)), own: true });
    }
    i = j;
  }
  return out;
}

/**
 * How many lines a greedy breaker sets tokens in at width `width` (`n`), and how far into its last
 * line they end (`x`), starting `x0` into a line after a space of `gap0`; `open` says whether a line
 * may break at a space.
 */
export function greedy(toks: readonly Tok[], width: number, open: (t: Tok) => boolean = (t) => t.brk, x0 = 0, gap0 = 0): { n: number; x: number } {
  let n = 1;
  let x = x0 ? x0 : -1;
  let chunk = 0;
  let gap = gap0;
  const place = () => {
    if (x < 0) x = chunk;
    else if (x + gap + chunk <= width) x += gap + chunk;
    else {
      n++;
      x = chunk;
    }
    chunk = 0;
  };
  for (const t of toks) {
    if (t.sp && open(t)) {
      if (chunk > 0) place();
      gap = t.w;
    } else chunk += t.w;
  }
  if (chunk > 0) place();
  return { n, x: Math.max(0, x) };
}

/** The tokens inside a range, the spaces at its ends left out. */
const within = (toks: readonly Tok[], a: number, z: number): Tok[] => {
  const out = toks.filter((t) => t.i >= a && t.i + t.len <= z);
  while (out.length && out[0]!.sp) out.shift();
  while (out.length && out[out.length - 1]!.sp) out.pop();
  return out;
};
/** A range's width on one line: each word, element and space in it. */
const widthOf = (toks: readonly Tok[], a: number, z: number): number => within(toks, a, z).reduce((s, t) => s + t.w, 0);

// ---------------------------------------------------------------------------------------------- sentences

/** Whether a sentence's tail is a short one with no stop of its own (a link: "Training tasks →"): two words at most. */
const shortTail = (s: string): boolean => !/[.!?][”’"')\]]*$/.test(s) && s.split(/[\s\u00a0]+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length <= 2;

/**
 * Short copy's sentences (rule 1), two to four, or null: a short tail with no stop of its own stays
 * with the sentence before it where the two fit a line together (`toks`, measured; else it is a
 * sentence of its own).
 */
export function sentenceUnits(f: Flat, toks: readonly Tok[] | null, width: number): CopyUnit[] | null {
  const ranges = sentenceRanges(f);
  if (toks && ranges.length > 1) {
    const [a] = ranges[ranges.length - 2]!;
    const [b, z] = ranges[ranges.length - 1]!;
    if (shortTail(f.str.slice(b, z)) && widthOf(toks, a, z) <= width) ranges.splice(-2, 2, [a, z]);
  }
  return ranges.length >= 2 && ranges.length <= 4 ? ranges.map(([from, to]) => ({ from, to, set: 'whole' })) : null;
}

/**
 * How each sentence sets (`tsSettle`): one that fits a line is kept whole. One that sets in two
 * lines starts a line of its own too, its two lines balanced, unless that would leave the line
 * before it less than half full, or the short sentence after it could end its last line; there,
 * and wherever a sentence sets in more, it flows on as prose does, and so does one after it that
 * ends that prose's last line or would otherwise leave it less than half full, so no line ends far
 * short of the measure. Where each line ends is reckoned as the sentences are laid down, greedily,
 * with the joins the block will have: a balanced sentence fills its line. A piece of a sentence
 * broken at its clauses starts a line of its own, as the whole sentence would.
 */
export function settle(units: CopyUnit[], toks: readonly Tok[], joins: ReadonlyMap<number, number>, width: number, space: number): void {
  const open = (t: Tok) => t.brk && t.own && !joins.has(t.i);
  const owns = units.map((u) => within(toks, u.from, u.to));
  const widths = owns.map((own) => own.reduce((s, t) => s + t.w, 0));
  let x = 0;
  let flow = false;
  units.forEach((u, i) => {
    const own = owns[i]!;
    const w = widths[i]!;
    let x0 = x >= width ? 0 : x;
    if (x0 && u.open && !u.cont) x0 = 0;
    const next = units[i + 1]?.open ? undefined : widths[i + 1];
    const along = () => {
      u.set = 'flow';
      x = greedy(own, width, open, x0, space).x;
      flow = true;
    };
    u.set = 'whole';
    if (w <= width) {
      if (x0 && x0 + space + w <= width) {
        x = x0 + space + w;
        if (flow) u.set = 'flow';
      } else if (x0 && flow && x0 < width / 2) along();
      else {
        x = w;
        flow = false;
      }
    } else if ((!x0 || x0 >= width / 2) && greedy(own, width, open).n <= 2 && !(next !== undefined && next <= width && greedy(own, width, open, x0, space).x + space + next <= width)) {
      u.set = 'balanced';
      x = width;
      flow = false;
    } else along();
  });
}

/** Whether a token is a space a line may break at, the whole sentences' own kept whole: what `cost` and `widow` set. */
const freeAt = (units: readonly CopyUnit[] | null) => {
  const whole = (units ?? []).filter((u) => u.set !== 'flow');
  return (t: Tok) => t.brk && t.own && !whole.some((u) => t.i >= u.from && t.i < u.to);
};

/**
 * A weak join (a small word's, an operator's with what follows it) never costs a short block a line
 * (`tsCost`): where the block would set in two lines without them and its joins take more, the weak
 * join in the widest run of joined words gives way, then the next, and any that needn't have is
 * held again. A longer block keeps its joins: its pretty wrapping takes up the slack.
 */
export function cost(toks: readonly Tok[], joins: Map<number, number>, units: readonly CopyUnit[] | null, width: number): void {
  const weak = [...joins].filter(([, p]) => p <= WEAK).map(([i]) => i);
  if (!weak.length) return;
  const free = freeAt(units);
  const open = (off: ReadonlySet<number>) => (t: Tok) => free(t) && (!joins.has(t.i) || off.has(t.i));
  const target = greedy(toks, width, open(new Set(weak))).n;
  const none = new Set<number>();
  let cur = greedy(toks, width, open(none)).n;
  if (target > 2 || cur <= target) return;
  // the width of the run of joined words each weak join is in
  const run = new Map<number, number>();
  const open0 = open(none);
  for (let k = 0; k < toks.length; ) {
    const a = k;
    let w = 0;
    const js: number[] = [];
    while (k < toks.length && !(open0(toks[k]!) && k > a)) {
      if (toks[k]!.sp && joins.has(toks[k]!.i)) js.push(toks[k]!.i);
      w += toks[k]!.w;
      k++;
    }
    for (const i of js) run.set(i, w);
    if (k === a) k++;
  }
  const order = weak.sort((p, q) => (run.get(q) ?? 0) - (run.get(p) ?? 0));
  const off = new Set<number>();
  for (let n = 0; n < order.length && cur > target; n++) {
    off.add(order[n]!);
    cur = greedy(toks, width, open(off)).n;
  }
  for (const i of [...off].reverse()) {
    off.delete(i);
    if (greedy(toks, width, open(off)).n > target) off.add(i);
  }
  for (const i of off) joins.delete(i);
}

/**
 * The last line of a block that wraps pretty holds a third of its measure where it can (`tsWidow`):
 * where the block, set greedily, ends on a shorter line, the words before its last pull down onto
 * it, one at a time, each joined to the next, while the block keeps its count of lines and the
 * joined words take at most four fifths of a line. A block ending on a sentence kept whole is left.
 */
export function widow(toks: readonly Tok[], joins: Map<number, number>, units: readonly CopyUnit[] | null, width: number): void {
  const last = units?.[units.length - 1];
  if (last && last.set !== 'flow') return;
  const free = freeAt(units);
  const open = (t: Tok) => free(t) && !joins.has(t.i);
  const lines = greedy(toks, width, open).n;
  if (lines < 2) return;
  for (let tries = 0; greedy(toks, width, open).x < width / 3 && tries < 6; tries++) {
    let k = toks.length - 1;
    while (k >= 0 && !(toks[k]!.sp && open(toks[k]!))) k--;
    if (k < 0 || toks[k]!.len !== 1) return;
    let j = k - 1;
    while (j >= 0 && !(toks[j]!.sp && open(toks[j]!))) j--;
    const w = toks.slice(j + 1).reduce((s, t) => s + t.w, 0);
    if (w > width * 0.8) return;
    joins.set(toks[k]!.i, 5);
    if (greedy(toks, width, open).n !== lines) {
      joins.delete(toks[k]!.i);
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------- clauses and phrases

/** A stop a sentence may break after, and the copy's own space after it. */
const STOP = /^[;:,—][ \t\n\r]+(?=\S)/;
/** A word that starts a phrase, a break ranked under every stop: a conjunction, a quoted name, a phrase that completes what is before it. */
const PHRASE = /^[ \t\n\r]+(?=(?:and|but|or|until|unless|while|whose|which|where|wherever|whenever|whether|why|when|because|if|so(?![ \t\n\r]+far\b)|that|with|from|for(?![ \t\n\r]+real\b)|under|before|after|once(?![,.;:])|than|instead|answering|replayed)\b|“)/;
/** A preposition before what it governs: "to your working tree", "in the same reads", never "to review". */
const PREP = /^[ \t\n\r]+(?=(?:to|in|on|at|into|onto|over|through|across|against|within|without)[ \t\n\r]+(?:the|a|an|your|its|their|our|my|this|these|those|each|every|all|any|one|no)\b)/;
/** A phrase that completes the word before it ("the golden that guards", "judged on your recordings"): it gives way to a comma on its line. */
const WEAK_PHRASE = /^[ \t\n\r]+(?:that|with|from|for|under|than)\b/;

/** The space before a phrase, at the start of `after`, unless it is inside one noun (`prompt and tool rewrites`). */
export function phraseAt(before: string, after: string): string | null {
  const m = PHRASE.exec(after) ?? PREP.exec(after);
  return m && !(/\bprompts?$/i.test(before) && /^[ \t\n\r]+and[ \t\n\r]+tools?\b/i.test(after)) ? m[0] : null;
}

interface Cut {
  at: number;
  sep: number;
  rank: number;
  left: number;
  weak?: boolean;
}

/** The rank of a stop: a semicolon 3, a colon or a dash 2, a comma 1. */
const stopRank = (c: string) => (c === ';' ? 3 : c === ',' ? 1 : 2);

/** How far into quotes and brackets copy is, character by character: inside brackets nothing breaks, inside a quotation only a quoted name's phrase. */
class Depth {
  curly = 0;
  straight = 0;
  paren = 0;
  see(c: string): void {
    if (c === '“') this.curly++;
    else if (c === '”') this.curly--;
    else if (c === '"') this.straight++;
    else if (c === '(' || c === '[') this.paren++;
    else if (c === ')' || c === ']') this.paren--;
  }
  get quoted(): boolean {
    return this.curly > 0 || this.straight % 2 === 1;
  }
}

/** Where an element that ends on a stop breaks after it, as its text would: where the copy's own space follows it. */
function afterElement(f: Flat, toks: readonly Tok[], a: number, z: number, p: number, d: Depth): Cut | null {
  const c = f.str.charAt(p);
  if (!f.atoms.some((x) => x.to === p + 1) || !/[;:,—]/.test(c) || d.paren > 0 || d.quoted || !ownSpace(f, p + 1)) return null;
  const gap = /^[ \t\n\r]+(?=\S)/.exec(f.str.slice(p + 1, z));
  return gap ? { at: p + 1, sep: gap[0].length, rank: stopRank(c), left: widthOf(toks, a, p + 1) } : null;
}

/** Where copy's own text may break at `p`: after a stop, or before a phrase (`phrases`). */
function cutAt(f: Flat, toks: readonly Tok[], a: number, z: number, p: number, d: Depth, phrases: boolean): Cut | null {
  const rest = f.str.slice(p, z);
  const m = STOP.exec(rest);
  const stop = m && ownSpace(f, p + 1) ? m : null;
  const ph = !stop && phrases && p > a ? phraseAt(f.str.slice(a, p), rest) : null;
  if ((!stop && !ph) || d.paren > 0 || (d.quoted && !ph)) return null;
  const rank = d.quoted ? -1 : ph ? 0 : stopRank(f.str.charAt(p));
  if (stop) return { at: p + 1, sep: stop[0].length - 1, rank, left: widthOf(toks, a, p + 1) };
  return { at: p, sep: ph!.length, rank, left: widthOf(toks, a, p), weak: !d.quoted && (WEAK_PHRASE.test(rest) || PREP.test(rest)) };
}

/** Each place a range of copy may break after a clause or, `phrases`, before a phrase: outside brackets, a quotation's only before a quoted name. */
function cutsOf(f: Flat, toks: readonly Tok[], a: number, z: number, phrases: boolean): Cut[] {
  const cands: Cut[] = [];
  const d = new Depth();
  for (let p = a; p < z; p++) {
    d.see(f.str.charAt(p));
    const c = f.own[p] ? cutAt(f, toks, a, z, p, d, phrases) : afterElement(f, toks, a, z, p, d);
    if (!c) continue;
    const was = cands[cands.length - 1];
    if (was?.at !== c.at) cands.push(c);
    else if (c.rank > was.rank) cands[cands.length - 1] = c;
  }
  return cands;
}

interface Best {
  cuts: Cut[];
  tier: number;
  rank: number;
  with_: number;
  even: number;
  sum?: number;
}

/**
 * Where copy of one sentence that sets in two lines breaks after a clause (`tsClauses`): after a
 * semicolon, a colon, a dash or a comma in the copy's own text (not in a quotation, brackets or an
 * element), where each side fits a line and the shorter is at least a quarter of it (a third after
 * a comma); the strongest stop first, the most even among equals. In a dialog's lead, a card or a
 * setup step (`phrases`) it may also break before a phrase where no stop can, ranked under every
 * stop, a phrase that completes the word before it giving way to a comma; and copy of three lines
 * breaks twice where once leaves a side its line can't hold. `tail`, what follows on the last
 * line (the docs link that ends a lead). The pieces, each a range of the text, or null.
 */
export function clauses(f: Flat, toks: readonly Tok[], range: readonly [number, number], width: number, phrases: boolean, tail = 0, space = 0): CopyUnit[] | null {
  const [a, z] = range;
  const room = phrases ? width - 0.5 : width * 0.96;
  const total = widthOf(toks, a, z);
  const cands = cutsOf(f, toks, a, z, phrases);
  const least = (rank: number) => width / (rank > 1 || !rank ? 4 : 3);
  const last = (w: number) => (tail && w + space + tail <= room ? w + space + tail : w);
  const tier = (c: Cut) => (c.rank >= 2 ? c.rank : c.weak ? 0.5 : c.rank >= 0 ? 1 : c.rank);
  // the strongest break first, a semicolon, a colon or a dash over a comma or a phrase; between a comma and a phrase, the one
  // after which what follows still fits its line, then the comma, then the most even
  let best = null as Best | null;
  for (const c of cands) {
    const right = total - c.left - space;
    const even = Math.abs(c.left - right);
    const with_ = tail && right + space + tail <= room ? 1 : 0;
    if (c.left > room || right > room || Math.min(c.left, last(right)) < least(c.rank)) continue;
    const t = tier(c);
    if (!best || t > best.tier || (t === best.tier && (with_ > best.with_ || (with_ === best.with_ && (c.rank > best.rank || (c.rank === best.rank && even < best.even)))))) best = { cuts: [c], tier: t, rank: c.rank, with_, even };
  }
  if ((!best || best.tier === 0.5) && phrases && total <= room * 2.9) best = twice(cands, best, { total, room, width, space, last });
  if (!best) return null;
  const out: CopyUnit[] = [];
  let from = a;
  for (const c of best.cuts) {
    const [x, y] = trimRange(f.str, from, c.at);
    out.push({ from: x, to: y, set: 'whole' });
    from = c.at + c.sep;
  }
  const [x, y] = trimRange(f.str, from, z);
  out.push({ from: x, to: y, set: 'whole' });
  return out;
}

/** Copy of three lines that one break can't set: the two breaks, the strongest first, then the most even lines; a weak break alone gives way to two that aren't. */
function twice(cands: readonly Cut[], one: Best | null, m: { total: number; room: number; width: number; space: number; last: (w: number) => number }): Best | null {
  const weakOne = one && one.tier === 0.5 ? one : null;
  let best = one;
  cands.forEach((a, i) => {
    for (const b of cands.slice(i + 1)) {
      if (weakOne && (a.weak || b.weak)) continue;
      const w = [a.left, b.left - a.left - m.space, m.total - b.left - m.space];
      const low = Math.min(a.rank, b.rank);
      const sum = a.rank + b.rank;
      const even = Math.max(...w) - Math.min(...w);
      if (w.some((x) => x > m.room) || Math.min(w[0]!, w[1]!, m.last(w[2]!)) < m.width / 5) continue;
      if (!best || best === weakOne || low > best.rank || (low === best.rank && (sum > (best.sum ?? -Infinity) || (sum === best.sum && even < best.even)))) best = { cuts: [a, b], tier: low, rank: low, with_: 0, even, sum };
    }
  });
  return best;
}

/**
 * A sentence of a dialog's lead, a card or a setup step too long for its line breaks between its
 * clauses or before a phrase (`tsSplitSents`), its docs link or the next sentence aside: each piece
 * a sentence of its own, so what follows may end the last one's line.
 */
function splitUnits(f: Flat, toks: readonly Tok[], units: readonly CopyUnit[], width: number, space: number): CopyUnit[] {
  return units.flatMap((u, i) => {
    const w = widthOf(toks, u.from, u.to);
    const nx = units[i + 1];
    const tail = nx ? widthOf(toks, nx.from, nx.to) : 0;
    const parts = w > width && w <= width * 2.9 ? clauses(f, toks, [u.from, u.to], width, true, tail, space) : null;
    return parts ? parts.map((p, j) => ({ ...p, cont: j > 0, open: j < parts.length - 1 })) : [u];
  });
}

// ---------------------------------------------------------------------------------------------- the plan

/** Whether every word in a range is a piece kept whole: such a block never balances, which crashed Chromium. */
function allKept(toks: readonly Tok[], words: readonly KeptWord[], a: number, z: number): boolean {
  const kept = (t: Tok) => !t.own || words.some((w) => t.i >= w.from && t.i + t.len <= w.to);
  const inside = toks.filter((t) => !t.sp && t.i >= a && t.i + t.len <= z);
  return inside.length > 0 && inside.every(kept);
}

/** Copy's tokens unmeasured: each word one character wide, where nothing can be measured (the tests' renderer). */
const UNMEASURED: CopyMeasure = { width: 0, text: (s) => s.length, atom: () => 1 };

/**
 * How `Copy` sets a piece of copy (rules 1 to 4): its sentences found and each set, its joins, its
 * words kept whole, and the block's wrap, at `m`'s width. Unmeasured (`m` null), short copy's
 * sentences are each kept whole, a run of joined words gives way past 30 characters, and every word
 * with a hyphen or a dot is held. `heading`: a heading's wrap is its stylesheet's. `phrases`: a
 * dialog's lead, a row's value, a card or a setup step, which break before a phrase too.
 */
export function planCopy(parts: readonly CopyPart[], m: CopyMeasure | null, opts: { heading?: boolean; phrases?: boolean } = {}): CopyPlan {
  const f = flatten(parts);
  const at: At | null = m && m.width > 0 ? { m, toks: tokens(f, m), width: m.width, space: m.text(' ') } : null;
  const toks = at ? at.toks : tokens(f, UNMEASURED);
  const lines = at ? greedy(at.toks, at.width).n : null;
  let wrap: CopyPlan['wrap'] = lines === null || opts.heading ? null : lines <= 2 ? 'ts-bal' : 'ts-pretty';
  const units = unitsOf(f, at, lines, !!opts.phrases);
  const joins = joinsOf(f, at, units);
  if (at && wrap === 'ts-pretty') widow(at.toks, joins, units, at.width);
  const room = at ? at.width * 0.96 : 0;
  const fitsWord = at ? (w: string) => at.m.text(w) <= room : null;
  const words = keptWords(f, fitsWord);
  const long = new Map(words.filter((w) => w.kind === 'long').map((w) => [w.from, fitsWord ? fitsWord(f.str.slice(w.from, w.to)) : null] as const));
  const wide = new Set(at ? f.atoms.filter((a) => at.m.atom(a.atom) > at.width).map((a) => a.atom) : []);
  // never balance a block, nor a sentence, whose words are each kept whole: set it pretty, which outranks a stylesheet's balance
  if (wrap === 'ts-bal' && allKept(toks, words, 0, f.str.length)) wrap = 'ts-pretty';
  for (const u of units ?? []) if (u.set === 'balanced' && allKept(toks, words, u.from, u.to)) u.set = 'flow';
  return { text: joined(f.str, joins), wrap, units, words, long, wide };
}

/** Copy measured at a width: its tokens, the width of its lines and of a space. */
interface At {
  m: CopyMeasure;
  toks: Tok[];
  width: number;
  space: number;
}

/**
 * Copy's sentences, two to four, in short copy with a sentence's stop in it (or a dialog's, set so
 * even without one); else, measured, the pieces of copy of one sentence of two lines (three, in a
 * dialog) broken after a clause, and a dialog's sentences too long for a line broken so too.
 */
function unitsOf(f: Flat, at: At | null, lines: number | null, phrases: boolean): CopyUnit[] | null {
  const boxed = f.str.length <= 640 && (/[.!?]/.test(f.str) || phrases);
  if (!boxed) return null;
  const units = sentenceUnits(f, at ? at.toks : null, at?.width ?? 0);
  if (!at) return units;
  if (!units) return lines === 2 || (phrases && lines === 3) ? clauses(f, at.toks, trimRange(f.str, 0, f.str.length), at.width, phrases, 0, at.space) : null;
  return phrases ? splitUnits(f, at.toks, units, at.width, at.space) : units;
}

/**
 * Copy's joins (rule 3), each run of joined words fitting its line, a long name that can't ending a
 * run where it may break, then, measured, each sentence set by them, and no weak join costing a
 * short block a line.
 */
function joinsOf(f: Flat, at: At | null, units: CopyUnit[] | null): Map<number, number> {
  const gaps = units ? sentenceGaps(units.map((u): [number, number] => [u.from, u.to])) : { free: new Set<number>(), ends: [] };
  const joins = glueJoins(f, gaps.free, gaps.ends);
  if (!at) {
    capRuns(f, joins, (a, z) => z - a <= 30);
    return joins;
  }
  const room = at.width * 0.96;
  // a long name its line can't hold whole may break after a dot or a hyphen, so a run may end there too
  const soft = new Set<number>();
  for (const x of f.str.matchAll(/[^\s\u00a0]{24,}/g))
    if (LONG.test(x[0]) && at.m.text(x[0]) > room) for (const d of x[0].matchAll(/\w[.-](?=\w)/g)) soft.add(x.index + d.index + 2);
  capRuns(f, joins, (a, z) => widthOf(at.toks, a, z) <= room, soft);
  if (units) settle(units, at.toks, joins, at.width, at.space);
  cost(at.toks, joins, units, at.width);
  return joins;
}
