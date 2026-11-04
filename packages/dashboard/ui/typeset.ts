/**
 * Line breaks, worked out as a page renders, for the parts in components/Copy.tsx. Every line the
 * dashboard shows breaks where a careful typesetter would break it, at every width, by six rules:
 *
 * 1. Sentences stay whole in short copy: a line breaks between them before it breaks inside one.
 * 2. No orphans: a block of two lines balances them, a longer one wraps pretty.
 * 3. What belongs together stays together: a number and its unit, a tally, a separator and the word
 *    before it, an operator, a small word and the word after it, a compound noun, a flag and its
 *    value, a sentence's last two words (`glue`).
 * 4. Short identifiers never split: a run id, a model, a flag, a path, a golden's name.
 * 5. Controls never wrap (the stylesheet's).
 * 6. Commands and code break only between their arguments (`codePieces`, and cmdline.ts).
 *
 * React owns its text, so nothing here reads or writes the page: a component measures (a canvas, in
 * each element's own font) and passes what it measured in. No DOM here: the tests import it.
 */

// ---------------------------------------------------------------------------------------------- sentences

/** A sentence stop's closers: a quote or a bracket the sentence's stop sits inside. */
const CLOSERS = '”’"\')]';
/** What starts a sentence: a capital, a digit, an opening quote or bracket, a sign, or code set apart. */
const STARTS = /^[A-Z0-9“‘"'([$#≈€£`]/;
/** An abbreviation's stop is no sentence's end. */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|No|cf|approx)\.$/;

/** How far into quotes and brackets each character is: what is inside one is a piece of the sentence around it. */
function depthAt(text: string): number[] {
  const out: number[] = [];
  let depth = 0;
  let straight = false;
  for (const ch of text) {
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

/**
 * A short piece of copy's sentences, in order, without the one space between each: a stop (`.`,
 * `!`, `?`, a closing quote or bracket after it), a space, then what starts a sentence. Never after
 * an abbreviation (`e.g.`, `vs.`), nor inside a quotation or brackets (a model's answer quoted in a
 * sentence is one piece of it). Joined with a space, they are the text as it was.
 */
export function sentences(text: string): string[] {
  const depth = depthAt(text);
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (!'.!?'.includes(text[i]!)) continue;
    let end = i + 1;
    while (end < text.length && CLOSERS.includes(text[end]!)) end++;
    // The stop is the sentence's own: outside every quote and bracket once its closers are counted.
    if ((depth[end - 1] ?? 0) !== 0 || (end === i + 1 && (depth[i] ?? 0) !== 0)) continue;
    if (text[end] !== ' ' || !STARTS.test(text.slice(end + 1)) || ABBREVIATION.test(text.slice(from, i + 1))) continue;
    out.push(text.slice(from, end));
    from = end + 1;
    i = end;
  }
  out.push(text.slice(from));
  return out.filter((s) => s !== '');
}

/** Short copy, as rule 1 counts it: two to four sentences in at most 640 characters (one sentence is short too). */
export const isShortCopy = (text: string): boolean => text.length <= 640 && sentences(text).length <= 4;

// ---------------------------------------------------------------------------------------------- glue

/** The small words a line shouldn't end on (rule 3): each holds the word after it. */
const SMALL = new Set(
  'a an the of to in on at by for and or with from as is its your no not than into per via vs if so be until unless while because whether once since that which whose when where before after over under through across against within without between are was were been has have had can could will would should may might must'.split(
    ' ',
  ),
);
/** An article or a possessive, which holds its word more than the other small words do. */
const ARTICLES = new Set(['a', 'an', 'the', 'its', 'your', 'their', 'our', 'his', 'her', 'my', 'this', 'these', 'those']);
/** Nouns of two words, and of three, that read as one. */
const COMPOUNDS = ['working tree', 'pull request', 'request field', 'tool rewrites', 'tool descriptions', 'system prompt', 'system message', 'judge check', 'prompt and tools'];
/** A word that names the number after it: `call 1`, `HTTP 529`, `Oct 1`, `attempt 2`, `against 0.94`. */
const NAMES_NUMBER = /^(?:calls?|attempts?|probes?|steps?|runs?|sessions?|goldens?|version|v|rev|against|HTTP|PR|#|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)$/;
/** A figure: a count, a price, a rate, a share or a call's number. */
const NUMBER = /^[≈~$€£#−-]*\d[\d.,:]*[%×kKmMs]?$|^(?:one|two|three|four|five|six|seven|eight|nine|ten)$/i;
const OPERATOR = /^(?:[<>]=?|!?==?|≥|≤|≠)$/;
const SEPARATOR = /^[·→↳—…]/;
const SIGN = /^[≈~$€£]$/;

/** How strongly each join holds, strongest first (rule 3's order), as `glue` breaks the weakest when a run outgrows its line. */
export const JOIN = { sign: 9, last: 8, figure: 7, operator: 6, compound: 5, article: 4, small: 3, after: 2, smalls: 1 } as const;

/** A word as rule 3 reads it: without the punctuation that ends a sentence or a clause. */
const bare = (w: string) => w.replace(/[.,;:!?”’"')\]]+$/, '');
/** Whether a word ends its sentence: a stop, and closers after it. */
const endsSentence = (w: string) => /[.!?][”’"')\]]*$/.test(w);

/** Whether the space after word `i` joins a figure: a number and its unit or noun, a tally (`3 of 4`), a word and the number it names. */
function figureJoin(words: readonly string[], i: number): boolean {
  const a = words[i]!;
  const b = words[i + 1]!;
  // never a number and a small word after it, but the "of" of a tally
  if (NUMBER.test(a)) return b === 'of' ? NUMBER.test(bare(words[i + 2] ?? '')) : /^[a-z]/i.test(b) && !SMALL.has(bare(b).toLowerCase());
  if (a === 'of') return NUMBER.test(bare(b)) && NUMBER.test(words[i - 1] ?? '');
  return NAMES_NUMBER.test(a) && NUMBER.test(bare(b));
}

/** How strongly a space joins two words that are no figure: an operator, a compound noun or a flag, an article, a small word. */
function wordJoin(a: string, b: string): number {
  const al = bare(a).toLowerCase();
  const bl = bare(b).toLowerCase();
  if (OPERATOR.test(b)) return JOIN.operator;
  if (COMPOUNDS.some((c) => ` ${c} `.includes(` ${al} ${bl} `)) || (/^--?[a-z][\w-]*$/.test(a) && !b.startsWith('-'))) return JOIN.compound;
  if (ARTICLES.has(al)) return JOIN.article;
  if (SMALL.has(al)) return SMALL.has(bl) ? JOIN.smalls : JOIN.small;
  return OPERATOR.test(a) ? JOIN.after : 0;
}

/** How strongly the space after word `i` holds the two words, 0 for a space that breaks freely. */
function joinOf(words: readonly string[], i: number): number {
  const a = words[i]!;
  const b = words[i + 1]!;
  if (SEPARATOR.test(b) || SIGN.test(a)) return JOIN.sign;
  // A line may always break after a clause's or a sentence's end.
  if (/[,;:]$/.test(a) || endsSentence(a)) return 0;
  if ((i + 1 === words.length - 1 || endsSentence(b)) && bare(b).length <= 24) return JOIN.last;
  return figureJoin(words, i) ? JOIN.figure : wordJoin(a, b);
}

/** Measures what `glue` needs to cap a run: whether a piece fits on one line of the block, and how many lines a text sets in. */
export interface GlueMeasure {
  /** Whether the text fits on one line of the block, with the 4% the run cap leaves (rule 3: a run wider than 96% gives way). */
  fits: (text: string) => boolean;
  /** The lines the whole text sets in at the block's width. */
  lines?: (text: string) => number;
}

const joined = (words: readonly string[], joins: readonly number[]) => words.map((w, i) => (i ? (joins[i - 1]! > 0 ? '\u00a0' : ' ') + w : w)).join('');

/** Breaks the weakest join of each run that outgrows its line, nearest its middle among equals, one that lets both sides fit first. */
function capRuns(words: readonly string[], joins: number[], fits: (text: string) => boolean): void {
  for (let guard = 0; guard < words.length; guard++) {
    let changed = false;
    for (let s = 0; s < words.length; ) {
      let e = s;
      while (e < words.length - 1 && joins[e]! > 0) e++;
      const run = words.slice(s, e + 1).join(' ');
      if (e > s && !fits(run)) {
        const mid = (s + e) / 2;
        const cands = Array.from({ length: e - s }, (_, k) => s + k).sort((x, y) => joins[x]! - joins[y]! || Math.abs(x + 0.5 - mid) - Math.abs(y + 0.5 - mid));
        const both = cands.find((k) => fits(words.slice(s, k + 1).join(' ')) && fits(words.slice(k + 1, e + 1).join(' ')));
        joins[both ?? cands[0]!] = 0;
        changed = true;
      }
      s = e + 1;
    }
    if (!changed) return;
  }
}

/**
 * Rule 3: the text with a no-break space (U+00A0) where its words belong together, so no line
 * ends on a small word, starts with a separator or an operator, or splits a number from its unit,
 * a tally, a compound noun, or the last two words of a sentence. For prose only: never code, a
 * command, JSON or anything a user copies to run, where the no-break space would be copied.
 * Measured (`m`), a run of joined words never outgrows its line (the weakest join in it gives way),
 * and a small word's join never costs a short block a line.
 */
export function glue(text: string, m?: GlueMeasure): string {
  const words = text.split(' ');
  if (words.length < 2) return text;
  const joins = words.slice(0, -1).map((_, i) => (words[i] === '' || words[i + 1] === '' ? 0 : joinOf(words, i)));
  if (m) capRuns(words, joins, m.fits);
  if (m?.lines) {
    const loose = joins.map((j) => (j <= JOIN.small ? 0 : j));
    const want = m.lines(joined(words, loose));
    if (want <= 2) {
      const weak = joins.map((j, i) => ({ j, i })).filter((x) => x.j > 0 && x.j <= JOIN.small).sort((x, y) => x.j - y.j);
      for (const w of weak) {
        if (m.lines(joined(words, joins)) <= want) break;
        joins[w.i] = 0;
      }
    }
  }
  return joined(words, joins);
}

// ---------------------------------------------------------------------------------------------- lines

/**
 * How many lines a text sets in at `width`, broken greedily at its plain spaces as a browser does
 * (a no-break space holds), each word measured by `measure` in the block's font.
 */
export function greedyLines(text: string, width: number, measure: (s: string) => number): number {
  if (width <= 0) return 1;
  const words = text.split(' ');
  const space = measure(' ');
  let lines = 1;
  let x = 0;
  for (const w of words) {
    const ww = measure(w);
    if (x > 0 && x + space + ww > width) {
      lines++;
      x = ww;
    } else x += (x > 0 ? space : 0) + ww;
    // A word wider than the line is broken by the browser inside it, as it overflows: count what it takes.
    if (ww > width) {
      lines += Math.ceil(ww / width) - 1;
      x = ww % width;
    }
  }
  return lines;
}

/** How a sentence of short copy sets (rule 1): whole on a line of its own, its two lines balanced, or flowing as prose. */
export type SentenceSet = 'whole' | 'balanced' | 'flow';

/**
 * Each sentence's setting, from its width on one line (`widths`) against the line's: one that fits a
 * line is whole, an inline block that starts a line when it can't sit beside the one before; one of
 * two lines starts a line too, balanced, unless the line before it would be left less than half
 * full, where it flows; one of three lines or more flows. "Fits" is measured to the fraction of a pixel.
 */
export function setSentences(widths: readonly number[], lines: readonly number[], width: number, space: number): SentenceSet[] {
  let x = 0;
  return widths.map((w, i) => {
    const n = lines[i] ?? 1;
    if (n <= 1) {
      x = x > 0 && x + space + w <= width ? x + space + w : w;
      return 'whole';
    }
    if (n === 2 && !(x > 0 && x < width / 2)) {
      x = w / 2;
      return 'balanced';
    }
    x = (x + space + w) % width;
    return 'flow';
  });
}

/** The stops a sentence may break after, the strongest first: a semicolon, a colon or a dash, then a comma. */
const CLAUSE = /([;:]| [—–]|,) (?=\S)/g;

/**
 * Where a sentence of two lines breaks after a clause (rule 2): after a semicolon, a colon or a
 * dash where the shorter side holds a quarter of the line, after a comma where it holds a third,
 * the strongest stop first and then the most even, both sides fitting a line. Never at a stop inside
 * a quotation or brackets. The index where the second side starts, or null where no stop will do.
 */
export function clauseBreak(text: string, width: number, measure: (s: string) => number): number | null {
  const depth = depthAt(text);
  const cands = [...text.matchAll(CLAUSE)]
    .filter((m) => (depth[m.index] ?? 0) === 0)
    .map((m) => {
      const at = m.index + m[0].length;
      const [a, b] = [measure(text.slice(0, at - 1)), measure(text.slice(at))];
      return { at, strong: m[1] !== ',', a, b };
    })
    .filter((c) => c.a <= width && c.b <= width && Math.min(c.a, c.b) >= width * (c.strong ? 1 / 4 : 1 / 3));
  const best = (strong: boolean) => cands.filter((c) => c.strong === strong).sort((x, y) => Math.abs(x.a - x.b) - Math.abs(y.a - y.b))[0];
  return (best(true) ?? best(false))?.at ?? null;
}

// ---------------------------------------------------------------------------------------------- code

/** A piece of code or a command: text kept on one line (`whole`) or free to wrap, or a place it may break. */
export type Piece = { text: string; whole: boolean } | { wbr: true };

const WBR: Piece = { wbr: true };

/** A <wbr> right before a space offers a break the space already offers; where a block balances its lines, Chromium crashes on one. */
function wbrSafe(pieces: Piece[]): Piece[] {
  return pieces.filter((p, i) => !('wbr' in p) || !(pieces[i + 1] && !('wbr' in pieces[i + 1]!) && (pieces[i + 1] as { text: string }).text.startsWith(' ')));
}

/** Whether a space in code holds: what follows is an operator that ends there, or a number the word before it names. */
const HOLDS = /^ (?:(?:[<>!=]=?|→)(?: |$)|[#−-]?\d[\d.,]*(?![^\s),;:\]}]))/;

/**
 * Code shown as text (a failure line, a model's tool call, a decision's step), cut where it may
 * wrap: at a space, after a comma or a run of opening braces and brackets, between the words of a
 * quoted value longer than 24 characters, and nowhere else. A JSON key keeps a value short enough
 * to share a narrow line with it, a field or a call its number (`amount 240`, `issue_refund #6:`),
 * an operator the word before it, so no line starts with `>`; an object of 30 characters or fewer
 * stays whole. Joined, the pieces are the code as written.
 */
export function codePieces(s: string): Piece[] {
  // short code with no space in it, and a short object or call however it is spaced, stays whole
  if (s.length <= 30 && (!/\s/.test(s) || /[{[]/.test(s))) return [{ text: s, whole: true }];
  const out: Piece[] = [];
  let cur = '';
  const flush = () => {
    if (cur) out.push({ text: cur, whole: true });
    cur = '';
  };
  const parts = s.split(/("[^"]*")/);
  parts.forEach((part, i) => {
    if (i % 2 && part.length > 24) {
      part.split(' ').forEach((w, j) => {
        if (j) {
          flush();
          out.push({ text: ' ', whole: false });
        }
        cur += w;
      });
      return;
    }
    if (i % 2) {
      cur += part;
      return;
    }
    for (let k = 0; k < part.length; k++) {
      const ch = part.charAt(k);
      const key = k === 1 && part[0] === ':' && i > 0 ? parts[i - 1]! : null;
      const value = k + 1 < part.length ? (/^[^,}\]\s]*/.exec(part.slice(k + 1))?.[0] ?? '') : (parts[i + 1] ?? '');
      const keeps = key !== null && key.length + 2 + value.length <= 32;
      if (ch === ' ' && !keeps && !HOLDS.test(part.slice(k))) {
        flush();
        out.push({ text: ' ', whole: false });
        continue;
      }
      cur += ch;
      if (/[,{[]/.test(ch) && !/[{[]/.test(part.charAt(k + 1))) {
        flush();
        out.push(WBR);
      }
    }
  });
  flush();
  return wbrSafe(out);
}

/**
 * Inline code as rule 4 sets it: up to 32 characters one piece that never breaks; a longer path or
 * host may break only after a slash or a dot, a longer hyphenated name after a hyphen, a longer
 * phrase only between its words. Joined, the pieces are the code as written.
 */
export function inlineCodePieces(s: string): Piece[] {
  if (s.length <= 32) return [{ text: s, whole: true }];
  if (/\s/.test(s)) return s.split(' ').flatMap((w, i): Piece[] => (i ? [{ text: ' ', whole: false }, { text: w, whole: true }] : [{ text: w, whole: true }]));
  const cut = /[/.]/.test(s) ? /(?<=[/.])(?=[^/.])/ : /(?<=-)(?=[^-])/;
  return s.split(cut).flatMap((x, i): Piece[] => (i ? [WBR, { text: x, whole: true }] : [{ text: x, whole: true }]));
}
