import { hintsFor } from './diff.js';
import { BUILTIN_STRIPPED_KEYS } from './fingerprint.js';
import { applyNormalizers, compilePattern, parsePath } from './normalize.js';
import type { DiffEntry, DivergenceReport, Normalizer } from './types.js';

/**
 * Values an agent makes anew on every run (a UUID, a ULID, a timestamp, a request id) diverge the
 * first time a recording replays. Re-recording the golden only moves the problem, because the next
 * run makes another one; a normalizer fixes it for good. These are the changes in a divergence that
 * look like such values, each with the normalizer that masks it.
 */

export interface VolatileValue {
  /** Where the value is in the request, as a normalizer path: `$.metadata.user_id`. */
  path: string;
  /** What it looks like: `a UUID`, `a ULID`, `a date`, `a timestamp`, `an id`. */
  looks: string;
  /**
   * `changed`: the recording has a value here too, so the normalizer alone makes the replay match.
   * `added`: the request now carries a value the recording never had; re-recording is still needed,
   * and without the normalizer the run after that diverges again.
   */
  op: 'changed' | 'added';
  normalizer: Normalizer;
}

export interface VolatileValues {
  values: VolatileValue[];
  /** Every change in the divergence is a changed value of this kind: a normalizer is the whole fix. */
  explainsAll: boolean;
}

const PATTERNS: Array<{ pattern: string; placeholder: string; looks: string }> = [
  { pattern: 'iso-datetime', placeholder: '<DATETIME>', looks: 'a timestamp' },
  { pattern: 'iso-date', placeholder: '<DATE>', looks: 'a date' },
  { pattern: 'uuid', placeholder: '<UUID>', looks: 'a UUID' },
  { pattern: 'ulid', placeholder: '<ULID>', looks: 'a ULID' },
];

/** The last key of a normalizer path: `user_id` for `$.metadata.user_id`, `request-id` for `$["request-id"]`. */
function lastKey(path: string): string {
  const quoted = /\["((?:[^"\\]|\\.)*)"\]$/.exec(path);
  if (quoted) return quoted[1]!;
  const dotted = /\.([^.[\]]+)$/.exec(path);
  return dotted ? dotted[1]! : '';
}

/**
 * A key that names an identifier: `id`, `user_id`, `request-id`, `traceId`, `requestID`, `nonce`.
 * The camel-case form is matched case by case, so `paid`, `valid` and `android` are not ids.
 */
const ID_KEY = /^(?:id|uuid|guid|nonce)$|[_-](?:id|uuid|guid|nonce)$/i;
const ID_KEY_CAMEL = /[a-z0-9](?:Id|ID|Uuid|UUID|Guid|GUID|Nonce)$/;
/** A value shaped like an identifier: one token of letters, digits and joiners, with a digit in it. */
const ID_VALUE = /^(?=[^\s]*\d)[A-Za-z0-9][A-Za-z0-9_.:-]{3,127}$/;

function idLike(entry: DiffEntry, value: unknown): boolean {
  const key = lastKey(entry.path);
  if (!key || !(ID_KEY.test(key) || ID_KEY_CAMEL.test(key))) return false;
  if (typeof value === 'number') return Number.isInteger(value);
  return typeof value === 'string' && ID_VALUE.test(value);
}

function scoped(d: Pick<DivergenceReport, 'kind' | 'name'>, n: Normalizer): Normalizer {
  return { kind: d.kind, ...(d.kind === 'tool' ? { name: d.name } : {}), ...n };
}

/** The volatile value in one change of a divergence, or null. */
export function volatileValue(entry: DiffEntry, d: Pick<DivergenceReport, 'kind' | 'name'>): VolatileValue | null {
  if (entry.op === 'changed') {
    const hint = hintsFor(entry, d.kind, d.name)[0];
    if (hint?.normalizer) {
      const looks = /looks like ([^;]+);/.exec(hint.message)?.[1] ?? 'a value that changes every run';
      return { path: entry.path, looks, op: 'changed', normalizer: hint.normalizer };
    }
    if (idLike(entry, entry.before) && idLike(entry, entry.after) && typeof entry.before === typeof entry.after) {
      return { path: entry.path, looks: 'an id', op: 'changed', normalizer: scoped(d, { path: entry.path, replace: '<ID>' }) };
    }
    return null;
  }
  if (entry.op === 'added') {
    if (typeof entry.after === 'string') {
      for (const { pattern, placeholder, looks } of PATTERNS) {
        const re = compilePattern(pattern);
        const m = re.exec(entry.after);
        // The value is the pattern, or the pattern is most of it: a date inside a sentence is a prompt change.
        if (m && m[0].length >= entry.after.trim().length * 0.6) return { path: entry.path, looks, op: 'added', normalizer: scoped(d, { path: entry.path, pattern, replace: placeholder }) };
      }
    }
    if (idLike(entry, entry.after)) return { path: entry.path, looks: 'an id', op: 'added', normalizer: scoped(d, { path: entry.path, replace: '<ID>' }) };
  }
  return null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A field the request carries for the first time, whole (`+ $.metadata {"user_id": "…"}`), as one
 * added entry per value inside it, with paths as the diff writes them. Only a field added by name:
 * an element appended to an array is the conversation growing, and the ids inside it (a tool call's,
 * a message's) were recorded rather than made anew. Nested objects are followed, arrays are not.
 */
function addedLeaves(entry: DiffEntry): DiffEntry[] {
  if (entry.op !== 'added' || !isPlainObject(entry.after) || entry.path.endsWith(']')) return [entry];
  const out: DiffEntry[] = [];
  const walk = (value: Record<string, unknown>, path: string, depth: number) => {
    for (const key of Object.keys(value).sort()) {
      if (out.length >= 50) return;
      const child = value[key];
      if (isPlainObject(child)) {
        if (depth < 4) walk(child, `${path}.${key}`, depth + 1);
      } else if (!Array.isArray(child)) {
        out.push({ path: `${path}.${key}`, op: 'added', after: child });
      }
    }
  };
  walk(entry.after, entry.path, 1);
  return out;
}

/**
 * A change that matching already ignores: the normalizers in force read both sides the same, or it
 * is in a key fingerprints leave out. A divergence report lists every change in the request as sent,
 * these too, so they say nothing about why it diverged.
 */
export function maskedChange(entry: DiffEntry, normalizers: readonly Normalizer[], d: Pick<DivergenceReport, 'kind' | 'name'>): boolean {
  let segs: ReturnType<typeof parsePath>;
  try {
    segs = parsePath(entry.path);
  } catch {
    return false;
  }
  if (segs.some((s) => s.type === 'key' && BUILTIN_STRIPPED_KEYS.includes(s.key))) return true;
  if (entry.op !== 'changed' || !normalizers.length || segs.some((s) => s.type === 'wild' || (s.type === 'index' && (s.index < 0 || s.index > 10_000)))) return false;
  // Each side alone at its path, so a rule's path and pattern apply as they do to the whole request.
  const place = (leaf: unknown): unknown =>
    segs.reduceRight<unknown>((inner, seg) => {
      if (seg.type === 'key') return { [seg.key]: inner };
      const arr: unknown[] = [];
      arr[(seg as { index: number }).index] = inner;
      return arr;
    }, leaf);
  try {
    const before = applyNormalizers(place(entry.before), [...normalizers], d.kind, d.name);
    const after = applyNormalizers(place(entry.after), [...normalizers], d.kind, d.name);
    return JSON.stringify(before) === JSON.stringify(after);
  } catch {
    return false;
  }
}

/**
 * The changes in a divergence that look like values made anew on every run. `normalizers`, the ones
 * in force when it diverged, leave out what they already mask: such a change is listed in the report
 * but did not make the replay diverge.
 */
export function volatileValues(d: DivergenceReport, normalizers: readonly Normalizer[] = []): VolatileValues {
  const entries = (d.type === 'request_changed' ? (d.diff ?? []) : []).filter((e) => !maskedChange(e, normalizers, d));
  const values: VolatileValue[] = [];
  for (const entry of entries) {
    for (const one of addedLeaves(entry)) {
      const v = volatileValue(one, d);
      if (v && !values.some((x) => x.path === v.path)) values.push(v);
    }
  }
  const explainsAll = entries.length > 0 && entries.every((e) => values.some((v) => v.path === e.path && v.op === 'changed'));
  return { values, explainsAll };
}

/** The `shadowlap` arguments that add a normalizer: `['normalize', 'add', '--kind', 'api', '--path', …]`. */
export function normalizeAddArgs(n: Normalizer): string[] {
  return [
    'normalize',
    'add',
    ...(n.kind ? ['--kind', n.kind] : []),
    ...(n.name ? ['--name', n.name] : []),
    ...(n.path !== undefined ? ['--path', n.path] : []),
    ...(n.pattern ? ['--pattern', n.pattern] : []),
    '--replace',
    n.replace,
  ];
}

const shellQuote = (s: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The command that adds a normalizer, as a person would type it. */
export function normalizeAddCommand(n: Normalizer): string {
  return ['shadowlap', ...normalizeAddArgs(n)].map(shellQuote).join(' ');
}
