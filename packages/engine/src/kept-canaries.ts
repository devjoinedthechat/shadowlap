import { isObject } from './is-object.js';

/**
 * Copies that keep a run's own canaries (an injection attempt's, docs/injection.md): a pack, an
 * exported page or a team share, a dataset, pairs, and the previews that count what such a copy
 * masks.
 *
 * keepingTexts rewrites one value with every canary left as it was. keepingWhile does it for all a
 * copy rewrites: while it runs, a rule's pattern compiled then (compilePattern) reads each text with
 * the canaries hidden, and a path rule that replaces a whole string, or in a request a whole value,
 * keeps the canaries it held (keptWhole). Either way a secret beside a canary is masked as ever.
 */

/** A canary's mark: private-use characters no rule's pattern is written to match. */
const MARKS = /+/g;
const markOf = (i: number) => `${''.repeat(i + 1)}`;

/** Every canary mark in a value's strings and keys, in order. */
function marksIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(...(v.match(MARKS) ?? []));
  else if (Array.isArray(v)) v.forEach((x) => marksIn(x, out));
  else if (isObject(v)) for (const [k, x] of Object.entries(v)) marksIn(x, marksIn(k, out));
  return out;
}

/** `v` with `f` applied to each of its strings and keys. */
function deep(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => deep(x, f));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), deep(x, f)]));
  return v;
}

/** The texts as one pattern, the longest first, case aside; null for none. */
function finder(texts: readonly string[]): RegExp | null {
  const sorted = [...new Set(texts.filter(Boolean))].sort((a, b) => b.length - a.length);
  return sorted.length ? new RegExp(sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi') : null;
}

/** How many times `find` (global) occurs in a value's strings and keys. */
function countIn(v: unknown, find: RegExp): number {
  let n = 0;
  deep(v, (s) => {
    n += s.match(find)?.length ?? 0;
    return s;
  });
  return n;
}

/**
 * A copy of `value` rewritten by `rewrite` (the project's normalizers or redaction rules) with each of
 * `texts` (a canary's forms) left as it was: each occurrence is swapped for a mark before the
 * rewrite, and back after it. A rule that replaces a whole value (a path rule, or a pattern that
 * matches all of it) loses the marks with it, so they are put back: a value that was a canary and
 * nothing else is the canary again; one that held more keeps what the rule made of it, with its
 * canaries after. Marks the value holds already (an outer copy's) are left to it.
 */
export function keepingTexts<T>(value: T, texts: readonly string[], rewrite: (v: T) => T): T {
  const pattern = finder(texts);
  if (!pattern) return rewrite(value);
  const base = Math.max(0, ...marksIn(value).map((m) => m.length - 2));
  const originals: string[] = [];
  const hidden = deep(value, (s) =>
    s.replace(pattern, (m) => {
      originals.push(m);
      return markOf(base + originals.length - 1);
    }),
  ) as T;
  // Where a rule took marks with what it replaced, the canaries go back.
  const restore = (before: unknown, after: unknown): unknown => {
    if (typeof before === 'string' && !(before.match(MARKS) ?? []).length) return after;
    if (Array.isArray(before) && Array.isArray(after)) return (after as unknown[]).map((x, i) => (i < before.length ? restore(before[i], x) : x));
    if (isObject(before) && isObject(after)) return Object.fromEntries(Object.entries(after).map(([k, x]) => [k, Object.hasOwn(before, k) ? restore(before[k], x) : x]));
    const held = marksIn(before);
    if (!held.length) return after;
    const left = marksIn(after);
    const lost = held.filter((m) => !left.includes(m));
    if (!lost.length) return after;
    if (typeof before === 'string' && !before.replace(MARKS, '').trim()) return before;
    return `${typeof after === 'string' ? after : (JSON.stringify(after) ?? '')} ${lost.join(' ')}`;
  };
  const out = restore(hidden, rewrite(hidden));
  return deep(out, (s) => s.replace(/(+)/g, (m, run: string) => originals[run.length - 1 - base] ?? m)) as T;
}

/** The copy keepingWhile runs: its canaries' texts, them as one pattern, and how many a rule would have masked. */
interface Keeping {
  texts: readonly string[];
  find: RegExp;
  kept: number;
}

let keeping: Keeping | null = null;

/** Whether `find` (global) occurs in `text`. */
function holds(find: RegExp, text: string): boolean {
  find.lastIndex = 0;
  const found = find.test(text);
  find.lastIndex = 0;
  return found;
}

/** How many of the canaries in `text` a match of `rule` reaches. */
function reached(text: string, find: RegExp, rule: RegExp): number {
  const spans = [...text.matchAll(find)].map((m) => [m.index, m.index + m[0].length] as const);
  const matches = rule.global ? [...text.matchAll(rule)] : [rule.exec(text)].filter((m): m is RegExpExecArray => m !== null);
  const hit = new Set<number>();
  for (const m of matches) {
    spans.forEach(([from, to], i) => {
      if (m[0].length && m.index < to && m.index + m[0].length > from) hit.add(i);
    });
  }
  return hit.size;
}

type Replacer = (substring: string, ...args: unknown[]) => string;

/**
 * A rule's pattern while a copy keeps canaries: a replace reads the text with them hidden
 * (keepingTexts), and so does a count of what it matches (countMatches), so neither touches one. What
 * it derives (a split, matchAll) is a plain pattern.
 */
class KeptPattern extends RegExp {
  static override get [Symbol.species](): RegExpConstructor {
    return RegExp;
  }

  private readonly scope: Keeping;

  constructor(source: string, flags: string, scope: Keeping) {
    super(source, flags);
    this.scope = scope;
  }

  override [Symbol.replace](text: string, replace: string | Replacer): string {
    if (!holds(this.scope.find, text)) return super[Symbol.replace](text, replace as string);
    this.scope.kept += reached(text, this.scope.find, new RegExp(this.source, this.flags));
    return keepingTexts(text, this.scope.texts, (t) => super[Symbol.replace](t, replace as string));
  }

  override [Symbol.match](text: string): RegExpMatchArray | null {
    return super[Symbol.match](holds(this.scope.find, text) ? text.replace(this.scope.find, markOf(0)) : text);
  }
}

/** A rule's pattern as compilePattern makes it: one that keeps canaries while a copy keeps them (keepingWhile). */
export function patternFor(source: string, flags: string): RegExp {
  return keeping ? new KeptPattern(source, flags, keeping) : new RegExp(source, flags);
}

/**
 * What a path rule that replaces a whole value leaves there: `replace`, or while a copy keeps
 * canaries and the value holds one, the canary as it was, or `replace` with its canaries after
 * (keepingTexts).
 */
export function keptWhole(before: string, replace: string): string;
export function keptWhole(before: unknown, replace: string): unknown;
export function keptWhole(before: unknown, replace: string): unknown {
  const scope = keeping;
  if (!scope) return replace;
  const held = countIn(before, scope.find);
  if (!held) return replace;
  scope.kept += held;
  return keepingTexts(before, scope.texts, () => replace);
}

/**
 * `copy()` keeping the canaries in `texts` wherever its rules rewrite (see above), and how many a rule
 * would have masked, which a preview leaves out of the values it counts. `copy` is synchronous; with
 * no texts it runs as it is.
 */
export function keepingWhile<T>(texts: readonly string[], copy: () => T): { value: T; kept: number } {
  const find = finder(texts);
  if (!find) return { value: copy(), kept: 0 };
  const outer = keeping;
  const scope: Keeping = { texts, find, kept: 0 };
  keeping = scope;
  try {
    return { value: copy(), kept: scope.kept };
  } finally {
    keeping = outer;
  }
}
