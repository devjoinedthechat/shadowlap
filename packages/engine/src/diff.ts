import { compilePattern } from './normalize.js';
import type { DiffEntry, Hint, Normalizer } from './types.js';
import { isObject } from './is-object.js';

/**
 * Structural diff between two JSON values, for divergence reports.
 * Arrays are compared by index; an appended message shows as `added` at the end, which is the
 * common shape of an agent's history and reads well without an LCS.
 */
export function structuralDiff(before: unknown, after: unknown, path = '$'): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(before, after, path, out);
  return out;
}

function walk(a: unknown, b: unknown, path: string, out: DiffEntry[]): void {
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const p = `${path}.${k}`;
      // Members of their own: an inherited one (`toString`, `constructor`) is no member of the request.
      if (!Object.hasOwn(a, k)) out.push({ path: p, op: 'added', after: b[k] });
      else if (!Object.hasOwn(b, k)) out.push({ path: p, op: 'removed', before: a[k] });
      else walk(a[k], b[k], p, out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length) out.push({ path: p, op: 'added', after: b[i] });
      else if (i >= b.length) out.push({ path: p, op: 'removed', before: a[i] });
      else walk(a[i], b[i], p, out);
    }
    return;
  }
  if (!deepEqual(a, b)) out.push({ path, op: 'changed', before: a, after: b });
}

/**
 * The request headers a model call's fingerprint includes (`anthropic-beta`, `openai-beta`, …), as
 * diff entries at `headers.<name>`: no JSON path, since they are not in the body and no normalizer
 * reaches them.
 */
export function headerDiff(before: Record<string, string> | undefined, after: Record<string, string> | undefined): DiffEntry[] {
  const out: DiffEntry[] = [];
  const names = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  for (const name of names) {
    const [b, a] = [before?.[name], after?.[name]];
    if (b === a) continue;
    const path = `headers.${name}`;
    out.push(b === undefined ? { path, op: 'added', after: a } : a === undefined ? { path, op: 'removed', before: b } : { path, op: 'changed', before: b, after: a });
  }
  return out;
}

/**
 * A model call's query parameters (as `queryPairs` reads them, from both sides as matching read
 * them), as diff entries at `query.<name>`: a value, or the values of a name sent more than once.
 */
export function queryDiff(before: ReadonlyArray<readonly [string, string]>, after: ReadonlyArray<readonly [string, string]>): DiffEntry[] {
  const group = (pairs: ReadonlyArray<readonly [string, string]>) => {
    const out = new Map<string, string[]>();
    for (const [name, value] of pairs) out.set(name, [...(out.get(name) ?? []), value]);
    return out;
  };
  const [b, a] = [group(before), group(after)];
  const shown = (values: string[]) => (values.length === 1 ? values[0] : values);
  const out: DiffEntry[] = [];
  for (const name of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const [was, now] = [b.get(name), a.get(name)];
    if (was && now && was.length === now.length && was.every((v, i) => v === now[i])) continue;
    const path = `query.${name}`;
    out.push(!was ? { path, op: 'added', after: shown(now!) } : !now ? { path, op: 'removed', before: shown(was) } : { path, op: 'changed', before: shown(was), after: shown(now) });
  }
  return out;
}

/**
 * Whether a diff entry is a header's (headerDiff, `headers.<name>`) or a query parameter's
 * (queryDiff, `query.<name>`) rather than a place in the body, which a normalizer's path reaches.
 */
export const isHeaderEntry = (entry: DiffEntry): boolean => entry.path.startsWith('headers.') || isQueryEntry(entry);

/** Whether a diff entry is a query parameter's (queryDiff). */
export const isQueryEntry = (entry: DiffEntry): boolean => entry.path.startsWith('query.');

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Where two strings first differ, for compact display. */
export function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

const HINT_PATTERNS: Array<{ pattern: string; placeholder: string; what: string }> = [
  { pattern: 'iso-datetime', placeholder: '<DATETIME>', what: 'a timestamp' },
  { pattern: 'iso-date', placeholder: '<DATE>', what: 'a date' },
  { pattern: 'uuid', placeholder: '<UUID>', what: 'a UUID' },
  { pattern: 'ulid', placeholder: '<ULID>', what: 'a ULID' },
];

/**
 * Hints for a changed string: if the two versions become identical once a known volatile pattern
 * is masked, propose the normalizer that would have matched them.
 */
export function hintsFor(entry: DiffEntry, kind: Normalizer['kind'], name?: string): Hint[] {
  if (entry.op !== 'changed' || typeof entry.before !== 'string' || typeof entry.after !== 'string') return [];
  const before: string = entry.before;
  const after: string = entry.after;
  for (const { pattern, placeholder, what } of HINT_PATTERNS) {
    const re = compilePattern(pattern);
    const a: string = before.replace(re, placeholder);
    re.lastIndex = 0;
    const b: string = after.replace(re, placeholder);
    if (a === b && a !== before) {
      const normalizer: Normalizer = { path: entry.path, pattern, replace: placeholder };
      if (kind) normalizer.kind = kind;
      if (name && kind === 'tool') normalizer.name = name;
      return [{ message: `this looks like ${what}; to ignore it in matching, add a normalizer`, normalizer }];
    }
  }
  return [];
}
