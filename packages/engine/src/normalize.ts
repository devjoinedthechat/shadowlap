import type { CallKind, Normalizer } from './types.js';

/**
 * Normalizers rewrite a copy of a request before it is fingerprinted. They never alter what is
 * stored. They are the only way two different requests can match.
 */

type Segment = { type: 'key'; key: string } | { type: 'index'; index: number } | { type: 'wild' };

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
  return copy;
}

/** Applies a pattern to every string value in a (JSON-like) value. */
export function rewriteStringsDeep(value: unknown, regex: RegExp, replace: string, onChange?: (before: string, after: string, count: number) => void): unknown {
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
function countMatches(text: string, regex: RegExp): number {
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
  if (node === null || typeof node !== 'object') return;
  const seg = segs[depth]!;
  const last = depth === segs.length - 1;
  const children: Array<string | number> = [];
  if (seg.type === 'wild') {
    if (Array.isArray(node)) for (let i = 0; i < node.length; i++) children.push(i);
    else children.push(...Object.keys(node));
  } else if (seg.type === 'index') {
    if (!Array.isArray(node)) return;
    const idx = seg.index < 0 ? node.length + seg.index : seg.index;
    if (idx >= 0 && idx < node.length) children.push(idx);
  } else {
    if (Array.isArray(node)) return;
    if (Object.prototype.hasOwnProperty.call(node, seg.key)) children.push(seg.key);
  }
  for (const key of children) {
    if (last) onLeaf(node, key);
    else visit((node as Record<string | number, unknown>)[key], segs, depth + 1, onLeaf);
  }
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
