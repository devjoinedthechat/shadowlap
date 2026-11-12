import { setOwn } from './canonical.js';
import { cloneExact, isRawNumber } from './json-exact.js';
import { keptWhole, patternFor } from './kept-canaries.js';
import { patternProblem, textSize, withinPatternBudget } from './safe-regex.js';
import type { CallKind, Normalizer } from './types.js';

/**
 * Normalizers rewrite a copy of a request before it is fingerprinted. They never alter what is
 * stored. They are the only way two different requests can match.
 */

export type Segment = { type: 'key'; key: string } | { type: 'index'; index: number } | { type: 'wild' };

const NAMED_PATTERNS: Record<string, RegExp> = {
  'iso-datetime': /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  'iso-date': /\d{4}-\d{2}-\d{2}/g,
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  ulid: /[0-9A-HJKMNP-TV-Z]{26}/g,
  number: /-?\d+(?:\.\d+)?/g,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
};

export function namedPatterns(): string[] {
  return Object.keys(NAMED_PATTERNS);
}

/**
 * A rule's pattern as a global regular expression: a named pattern, or a `/regex/flags` literal. A
 * literal is read before it is compiled, wherever it came from (the config, the dashboard, a pack,
 * the team store), and refused with the reason when it isn't one, is too long, or could take time
 * that grows exponentially with the text it reads (safe-regex.ts).
 */
export function compilePattern(pattern: string): RegExp {
  const named = NAMED_PATTERNS[pattern];
  if (named) return patternFor(named.source, named.flags);
  const problem = patternProblem(pattern, namedPatterns());
  if (problem) throw new Error(problem);
  const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern)!;
  const flags = m[2]!.includes('g') ? m[2]! : m[2]! + 'g';
  return patternFor(m[1]!, flags);
}

export function parsePath(path: string): Segment[] {
  if (!path.startsWith('$')) throw new Error(`path must start with "$": ${path}`);
  const segs: Segment[] = [];
  let i = 1;
  while (i < path.length) {
    const c = path[i]!;
    if (c === '.') {
      i++;
      if (path[i] === '*') {
        segs.push({ type: 'wild' });
        i++;
        continue;
      }
      let j = i;
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
      const key = path.slice(i, j);
      if (!key) throw new Error(`empty key in path: ${path}`);
      segs.push({ type: 'key', key });
      i = j;
    } else if (c === '[') {
      const close = path.indexOf(']', i);
      if (close < 0) throw new Error(`unterminated [ in path: ${path}`);
      const inner = path.slice(i + 1, close).trim();
      if (inner === '*') segs.push({ type: 'wild' });
      else if (/^-?\d+$/.test(inner)) segs.push({ type: 'index', index: Number(inner) });
      else if (/^(['"]).*\1$/s.test(inner)) segs.push({ type: 'key', key: inner.slice(1, -1) });
      else throw new Error(`bad bracket segment "[${inner}]" in path: ${path}`);
      i = close + 1;
    } else {
      throw new Error(`unexpected "${c}" at ${i} in path: ${path}`);
    }
  }
  return segs;
}

export function normalizerApplies(n: Normalizer, kind: CallKind, name: string): boolean {
  if (n.kind && n.kind !== kind) return false;
  if (n.name && n.name !== name) return false;
  return true;
}

/**
 * Watches what rules do to a value. The redaction preview uses it to count, without writing
 * anything, exactly what `shadowlap pack` would mask. `rule` is the position in the list of rules
 * passed in.
 */
export interface RewriteObserver {
  /** A path rule found a value at its path, whether or not it changed it. */
  reached?: (rule: number, value: unknown) => void;
  /** A rule changed a value: `count` matches replaced, or 1 for a whole value. */
  changed?: (rule: number, before: unknown, after: unknown, count: number) => void;
  /**
   * A rule's pattern matches something the rules leave as it is, so a copy carries it as recorded:
   * a number, which a pattern never rewrites; a key where keys stay (a request's, an error's); or,
   * for a rule with a path, a number at its path, or a string, number or key inside an object or
   * list at its path, since its pattern applies only to a string there. Reported once every rule has
   * applied, at `path` in the value (a key's own name last), with the text matched and how many
   * matches it holds.
   */
  unmasked?: (rule: number, text: string, at: UnmaskedAt, count: number) => void;
  /**
   * A rule's pattern (or a path rule's path) reaches into signed reasoning that a copy which can be
   * replayed keeps as recorded (signed.ts): a thinking block, its signature, encrypted reasoning.
   * Told with the text there and how many matches it holds (1 for a path rule that would have
   * replaced it whole).
   */
  signed?: (rule: number, text: string, at: UnmaskedAt, count: number) => void;
}

/** Where a value the rules leave as it is sits, and what it is. */
export interface UnmaskedAt {
  /** Its path in the document (a key's own name ends it); in a stream, in its event. */
  path: Array<string | number>;
  /** A number; a key; or a string inside an object or list at the path of a rule with a pattern, which applies only at its path. */
  what: 'number' | 'key' | 'string';
  /** In a streamed response, the event it is in, from 1. */
  event?: number;
  /** In signed reasoning, which a copy that can be replayed keeps as recorded (RewriteObserver.signed). */
  signed?: true;
}

/**
 * Returns a deep copy of `value` with every applicable normalizer applied, within the time budget
 * when any applies a pattern (withinPatternBudget): rules from a pack or the team store run here, on
 * every request a replay matches.
 */
export function applyNormalizers(value: unknown, normalizers: Normalizer[], kind: CallKind, name: string, observer?: RewriteObserver): unknown {
  const patterned = normalizers.filter((n) => n.pattern !== undefined && normalizerApplies(n, kind, name));
  if (!patterned.length) return applyNormalizersNow(value, normalizers, kind, name, observer);
  return withinPatternBudget(
    textSize(value),
    () => patterned.map((n) => n.pattern!),
    () => applyNormalizersNow(value, normalizers, kind, name, observer),
  );
}

function applyNormalizersNow(value: unknown, normalizers: Normalizer[], kind: CallKind, name: string, observer?: RewriteObserver): unknown {
  let copy: unknown = value;
  let cloned = false;
  normalizers.forEach((n, i) => {
    if (!normalizerApplies(n, kind, name)) return;
    if (!cloned) {
      // A number kept as written (parseJsonExact) is copied as it is: no rule rewrites a number.
      copy = cloneExact(value);
      cloned = true;
    }
    const regex = n.pattern === undefined ? null : compilePattern(n.pattern);
    const changed = observer?.changed ? (before: unknown, after: unknown, count: number) => observer.changed!(i, before, after, count) : undefined;
    if (n.path === undefined) {
      // No path: the pattern applies to every string in the document.
      if (regex) copy = rewriteStringsDeep(copy, regex, n.replace, changed);
      return;
    }
    const segs = parsePath(n.path);
    if (segs.length === 0) {
      // Whole-document normalizer: only meaningful with a pattern on a string root.
      observer?.reached?.(i, copy);
      copy = rewriteLeaf(copy, regex, n.replace, changed);
      return;
    }
    visit(copy, segs, 0, (parent, key) => {
      const leaf = (parent as Record<string | number, unknown>)[key];
      observer?.reached?.(i, leaf);
      const rewritten = rewriteLeaf(leaf, regex, n.replace, changed);
      if (typeof key === 'string') setOwn(parent as Record<string, unknown>, key, rewritten);
      else (parent as unknown[])[key] = rewritten;
    });
  });
  if (observer?.unmasked) reportUnmasked(copy, normalizers, (n) => normalizerApplies(n, kind, name), observer.unmasked);
  return copy;
}

/**
 * What each rule's pattern matches in `value` (a request or an error, as JSON values, with every
 * rule already applied) that the rules leave as it is: for a rule without a path, every number and
 * every key, since only string values are rewritten; for a rule with a path and a pattern, a number
 * at its path, and in an object or list at its path each string, number and key inside, since its
 * pattern applies only to a string at its path. (true, false and null hold nothing to mask.)
 * `applies` says which rules apply here, `prefix` where `value` sits.
 */
export function reportUnmasked(value: unknown, rules: readonly Normalizer[], applies: (rule: Normalizer) => boolean, report: NonNullable<RewriteObserver['unmasked']>, prefix: Array<string | number> = []): void {
  rules.forEach((rule, i) => {
    if (rule.pattern === undefined || !applies(rule)) return;
    const regex = compilePattern(rule.pattern);
    // `path` is the walk's own, changed as it goes: copied when it is reported.
    const test = (text: string, path: Array<string | number>, what: UnmaskedAt['what']) => {
      const count = countMatches(text, regex);
      if (count) report(i, text, { path: [...path], what }, count);
    };
    if (rule.path === undefined) {
      walkLeft(value, [...prefix], test, false);
      return;
    }
    visitPaths(value, parsePath(rule.path), prefix, (leaf, path) => {
      if (typeof leaf === 'number' || isRawNumber(leaf)) test(numberText(leaf), path, 'number');
      else if (leaf !== null && typeof leaf === 'object') walkLeft(leaf, [...path], test, true);
    });
  });
}

/**
 * Every number and every key in `value`, in order, and with `strings` every string too: what a rule
 * without a path leaves as it is, or what a rule with a pattern leaves in an object at its path.
 */
function walkLeft(value: unknown, path: Array<string | number>, test: (text: string, path: Array<string | number>, what: UnmaskedAt['what']) => void, strings: boolean): void {
  if (ArrayBuffer.isView(value)) return;
  if (typeof value === 'number' || isRawNumber(value)) test(numberText(value), path, 'number');
  else if (typeof value === 'string') {
    if (strings) test(value, path, 'string');
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      path.push(i);
      walkLeft(v, path, test, strings);
      path.pop();
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      path.push(k);
      test(k, path, 'key');
      walkLeft(v, path, test, strings);
      path.pop();
    }
  }
}

/** Each value a path reaches in `node`, as `visit` finds them, with where it is. */
function visitPaths(node: unknown, segs: Segment[], path: Array<string | number>, onLeaf: (leaf: unknown, path: Array<string | number>) => void): void {
  if (segs.length === 0) {
    onLeaf(node, path);
    return;
  }
  const down = (at: unknown, depth: number, where: Array<string | number>): void => {
    for (const key of childKeys(at, segs[depth]!)) {
      const child = (at as Record<string | number, unknown>)[key];
      if (depth === segs.length - 1) onLeaf(child, [...where, key]);
      else down(child, depth + 1, [...where, key]);
    }
  };
  down(node, 0, path);
}

/** A number's text as a rule's pattern is tested against it: as it was written, for one kept so (parseJsonExact). */
function numberText(value: unknown): string {
  return isRawNumber(value) ? value.rawJSON : JSON.stringify(value);
}

/** Applies a pattern to every string value in a (JSON-like) value, within the time budget. Bytes (a request sent as a binary body) hold no string, and stay as they are, as does a number kept as written. */
export function rewriteStringsDeep(value: unknown, regex: RegExp, replace: string, onChange?: (before: string, after: string, count: number) => void): unknown {
  return withinPatternBudget(
    textSize(value),
    () => [`/${regex.source}/${regex.flags}`],
    () => rewriteStringsDeepNow(value, regex, replace, onChange),
  );
}

function rewriteStringsDeepNow(value: unknown, regex: RegExp, replace: string, onChange?: (before: string, after: string, count: number) => void): unknown {
  if (ArrayBuffer.isView(value)) return value;
  if (typeof value === 'string') {
    regex.lastIndex = 0;
    const out = value.replace(regex, replace);
    if (onChange && out !== value) onChange(value, out, countMatches(value, regex));
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteStringsDeepNow(v, regex, replace, onChange));
  if (value && typeof value === 'object' && !isRawNumber(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) setOwn(out, k, rewriteStringsDeepNow(v, regex, replace, onChange));
    return out;
  }
  return value;
}

/** Applies every pathless pattern rule to raw text (responses are stored as bytes, not JSON), within the time budget. */
export function rewriteText(text: string, rules: Normalizer[], observer?: RewriteObserver): string {
  const patterned = rules.filter((n) => n.path === undefined && n.pattern !== undefined);
  if (!patterned.length) return text;
  return withinPatternBudget(
    text.length,
    () => patterned.map((n) => n.pattern!),
    () => rewriteTextNow(text, rules, observer),
  );
}

function rewriteTextNow(text: string, rules: Normalizer[], observer?: RewriteObserver): string {
  let out = text;
  rules.forEach((n, i) => {
    if (n.path !== undefined || n.pattern === undefined) return;
    const regex = compilePattern(n.pattern);
    const next = out.replace(regex, n.replace);
    if (observer?.changed && next !== out) observer.changed(i, out, next, countMatches(out, regex));
    out = next;
  });
  return out;
}

/** How many matches `replace` rewrites in `text`: every one for a global pattern, else the first. */
export function countMatches(text: string, regex: RegExp): number {
  regex.lastIndex = 0;
  const n = regex.global ? (text.match(regex)?.length ?? 0) : regex.test(text) ? 1 : 0;
  regex.lastIndex = 0;
  return n;
}

function rewriteLeaf(leaf: unknown, regex: RegExp | null, replace: string, onChange?: (before: unknown, after: unknown, count: number) => void): unknown {
  if (regex === null) {
    // A copy that keeps canaries keeps those the value held (keptWhole).
    const out = keptWhole(leaf, replace);
    if (onChange && leaf !== out) onChange(leaf, out, 1);
    return out;
  }
  if (typeof leaf !== 'string') return leaf;
  regex.lastIndex = 0;
  const out = leaf.replace(regex, replace);
  if (onChange && out !== leaf) onChange(leaf, out, countMatches(leaf, regex));
  return out;
}

function visit(node: unknown, segs: Segment[], depth: number, onLeaf: (parent: object, key: string | number) => void): void {
  const last = depth === segs.length - 1;
  for (const key of childKeys(node, segs[depth]!)) {
    if (last) onLeaf(node as object, key);
    else visit((node as Record<string | number, unknown>)[key], segs, depth + 1, onLeaf);
  }
}

/** The keys of `node` one segment of a path names: every one for a wildcard, else the one there is. */
function childKeys(node: unknown, seg: Segment): Array<string | number> {
  if (node === null || typeof node !== 'object' || ArrayBuffer.isView(node) || isRawNumber(node)) return [];
  if (seg.type === 'wild') return Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
  if (seg.type === 'index') {
    if (!Array.isArray(node)) return [];
    const idx = seg.index < 0 ? node.length + seg.index : seg.index;
    return idx >= 0 && idx < node.length ? [idx] : [];
  }
  if (Array.isArray(node)) return [];
  return Object.prototype.hasOwnProperty.call(node, seg.key) ? [seg.key] : [];
}

/** Deep-removes the named keys from a copy of `value`. Used for the built-in `cache_control` exclusion. */
export function stripKeysDeep(value: unknown, keys: readonly string[]): unknown {
  if (value === null || typeof value !== 'object' || isRawNumber(value)) return value;
  if (Array.isArray(value)) return value.map((v) => stripKeysDeep(v, keys));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(k)) continue;
    setOwn(out, k, stripKeysDeep(v, keys));
  }
  return out;
}
