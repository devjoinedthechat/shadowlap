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

export function compilePattern(pattern: string): RegExp {
  const named = NAMED_PATTERNS[pattern];
  if (named) return new RegExp(named.source, named.flags);
  const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  if (!m) throw new Error(`unknown pattern "${pattern}": use one of ${namedPatterns().join(', ')} or a /regex/ literal`);
  const flags = m[2]!.includes('g') ? m[2]! : m[2]! + 'g';
  return new RegExp(m[1]!, flags);
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
  reached?(rule: number, value: unknown): void;
  /** A rule changed a value: `count` matches replaced, or 1 for a whole value. */
  changed?(rule: number, before: unknown, after: unknown, count: number): void;
  /**
   * A rule's pattern matches something the rules leave as it is, so a copy carries it as recorded:
   * a number, which a pattern never rewrites; a key where keys stay (a request's, an error's); or a
   * number or object at a path rule's path, which its pattern can't apply to. Reported once every
   * rule has applied, at `path` in the value (a key's own name last), with the text matched and how
   * many matches it holds.
   */
  unmasked?(rule: number, text: string, at: UnmaskedAt, count: number): void;
}

/** Where a value the rules leave as it is sits: its path, and whether it is a key there (the key's own name ends the path). */
export interface UnmaskedAt {
  path: Array<string | number>;
  key: boolean;
}

/** Returns a deep copy of `value` with every applicable normalizer applied. */
export function applyNormalizers(value: unknown, normalizers: Normalizer[], kind: CallKind, name: string, observer?: RewriteObserver): unknown {
  let copy: unknown = value;
  let cloned = false;
  normalizers.forEach((n, i) => {
    if (!normalizerApplies(n, kind, name)) return;
    if (!cloned) {
      copy = structuredClone(value);
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
      (parent as Record<string | number, unknown>)[key] = rewriteLeaf(leaf, regex, n.replace, changed);
    });
  });
  if (observer?.unmasked) reportUnmasked(copy, normalizers, (n) => normalizerApplies(n, kind, name), observer.unmasked);
  return copy;
}

/**
 * What each rule's pattern matches in `value` (a request or an error, as JSON values, with every
 * rule already applied) that the rules leave as it is: for a rule without a path, every number and
 * every key, since only string values are rewritten; for a rule with a path and a pattern, a number,
 * object or list at its path, since a pattern applies to a string there. (true, false and null hold
 * nothing to mask.) `applies` says which rules apply here, `prefix` where `value` sits.
 */
export function reportUnmasked(value: unknown, rules: readonly Normalizer[], applies: (rule: Normalizer) => boolean, report: NonNullable<RewriteObserver['unmasked']>, prefix: Array<string | number> = []): void {
  rules.forEach((rule, i) => {
    if (rule.pattern === undefined || !applies(rule)) return;
    const regex = compilePattern(rule.pattern);
    // `path` is the walk's own, changed as it goes: copied when it is reported.
    const test = (text: string, path: Array<string | number>, key: boolean) => {
      const count = countMatches(text, regex);
      if (count) report(i, text, { path: [...path], key }, count);
    };
    if (rule.path === undefined) {
      walkLeft(value, [...prefix], test);
      return;
    }
    visitPaths(value, parsePath(rule.path), prefix, (leaf, path) => {
      if (typeof leaf === 'number' || (leaf !== null && typeof leaf === 'object')) test(JSON.stringify(leaf), path, false);
    });
  });
}

/** Every number and every key in `value`, in order: what a rule without a path leaves as it is. */
function walkLeft(value: unknown, path: Array<string | number>, test: (text: string, path: Array<string | number>, key: boolean) => void): void {
  if (ArrayBuffer.isView(value)) return;
  if (typeof value === 'number') test(JSON.stringify(value), path, false);
  else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      path.push(i);
      walkLeft(v, path, test);
      path.pop();
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      path.push(k);
      test(k, path, true);
      walkLeft(v, path, test);
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

/** Applies a pattern to every string value in a (JSON-like) value. Bytes (a request sent as a binary body) hold no string, and stay as they are. */
export function rewriteStringsDeep(value: unknown, regex: RegExp, replace: string, onChange?: (before: string, after: string, count: number) => void): unknown {
  if (ArrayBuffer.isView(value)) return value;
  if (typeof value === 'string') {
    regex.lastIndex = 0;
    const out = value.replace(regex, replace);
    if (onChange && out !== value) onChange(value, out, countMatches(value, regex));
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteStringsDeep(v, regex, replace, onChange));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = rewriteStringsDeep(v, regex, replace, onChange);
    return out;
  }
  return value;
}

/** Applies every pathless pattern rule to raw text (responses are stored as bytes, not JSON). */
export function rewriteText(text: string, rules: Normalizer[], observer?: RewriteObserver): string {
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
    if (onChange && leaf !== replace) onChange(leaf, replace, 1);
    return replace;
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
  if (node === null || typeof node !== 'object' || ArrayBuffer.isView(node)) return [];
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
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripKeysDeep(v, keys));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(k)) continue;
    out[k] = stripKeysDeep(v, keys);
  }
  return out;
}
