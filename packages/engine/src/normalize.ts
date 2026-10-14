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

/** Returns a deep copy of `value` with every applicable normalizer applied. */
export function applyNormalizers(value: unknown, normalizers: Normalizer[], kind: CallKind, name: string): unknown {
  const applicable = normalizers.filter((n) => normalizerApplies(n, kind, name));
  if (applicable.length === 0) return value;
  let copy = structuredClone(value);
  for (const n of applicable) {
    const regex = n.pattern === undefined ? null : compilePattern(n.pattern);
    if (n.path === undefined) {
      // No path: the pattern applies to every string in the document.
      if (regex) copy = rewriteStringsDeep(copy, regex, n.replace);
      continue;
    }
    const segs = parsePath(n.path);
    if (segs.length === 0) {
      // Whole-document normalizer: only meaningful with a pattern on a string root.
      copy = rewriteLeaf(copy, regex, n.replace);
      continue;
    }
    visit(copy, segs, 0, (parent, key) => {
      const leaf = (parent as Record<string | number, unknown>)[key];
      (parent as Record<string | number, unknown>)[key] = rewriteLeaf(leaf, regex, n.replace);
    });
  }
  return copy;
}

/** Applies a pattern to every string value in a (JSON-like) value. */
export function rewriteStringsDeep(value: unknown, regex: RegExp, replace: string): unknown {
  if (typeof value === 'string') {
    regex.lastIndex = 0;
    return value.replace(regex, replace);
  }
  if (Array.isArray(value)) return value.map((v) => rewriteStringsDeep(v, regex, replace));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = rewriteStringsDeep(v, regex, replace);
    return out;
  }
  return value;
}

/** Applies every pathless pattern rule to raw text (responses are stored as bytes, not JSON). */
export function rewriteText(text: string, rules: Normalizer[]): string {
  let out = text;
  for (const n of rules) {
    if (n.path !== undefined || n.pattern === undefined) continue;
    const regex = compilePattern(n.pattern);
    out = out.replace(regex, n.replace);
  }
  return out;
}

function rewriteLeaf(leaf: unknown, regex: RegExp | null, replace: string): unknown {
  if (regex === null) return replace;
  if (typeof leaf !== 'string') return leaf;
  regex.lastIndex = 0;
  return leaf.replace(regex, replace);
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
