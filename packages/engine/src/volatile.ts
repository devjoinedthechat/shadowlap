import { hintsFor } from './diff.js';
import { BUILTIN_STRIPPED_KEYS } from './fingerprint.js';
import { applyNormalizers, compilePattern, parsePath } from './normalize.js';
import type { DiffEntry, DivergenceReport, Hint, Normalizer } from './types.js';

/**
 * Values an agent makes anew on every run (a UUID, a ULID, a timestamp, a request id) diverge the
 * first time a recording replays. Re-recording the golden only moves the problem, because the next
 * run makes another one; a normalizer fixes it for good. These are the changes in a divergence that
 * look like such values, each with the normalizer that masks it.
 *
 * An id is only taken for one when it looks generated, or its key names a request, a trace, a span,
 * a session, a nonce or an idempotency key. Any other id that changed (a customer's number, an
 * order's code) is listed as one that may be a real change: the agent acting on another customer is
 * exactly what a golden is there to catch, and a normalizer would hide it from every later test.
 */

export interface VolatileValue {
  /** Where the value is in the request, as a normalizer path: `$.metadata.user_id`. */
  path: string;
  /** What it looks like: `a UUID`, `a ULID`, `a date`, `a timestamp`, `a generated id`, `an id`. */
  looks: string;
  /**
   * `changed`: the recording has a value here too, so the normalizer alone makes the replay match.
   * `added`: the request now carries a value the recording never had; re-recording is still needed,
   * and without the normalizer the run after that diverges again.
   */
  op: 'changed' | 'added';
  /**
   * It surely changes every run (it looks generated, or its key says it is a request's or a trace's).
   * False for an id that may be a real change: a normalizer for it is offered, never recommended.
   */
  certain: boolean;
  normalizer: Normalizer;
}

export interface VolatileValues {
  values: VolatileValue[];
  /** Every change in the divergence is a changed value that surely changes every run: a normalizer is the whole fix. */
  explainsAll: boolean;
  /**
   * Every change is a changed value listed here, ids that may be real changes included: rules for all
   * of them would make the replay match. That is the fix only if those ids change every run too.
   */
  coversAll: boolean;
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
 * A key's words, lowercased: `user_id` is user, id; `requestID` is request, id; `x-request-id` is x,
 * request, id. Camel case is split where it changes case, so `paid`, `valid` and `android` stay one
 * word, and are not ids.
 */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** A key that names an identifier: `id`, `user_id`, `traceUuid`, `nonce`, `idempotency_key`, `traceparent`. */
function idKey(words: readonly string[]): boolean {
  const last = words.at(-1);
  return !!last && (['id', 'uuid', 'guid', 'nonce', 'traceparent'].includes(last) || (last === 'key' && words.includes('idempotency')));
}

/** Ids that are made for one run by nature: a request's, a trace's or span's, a session's, a nonce, an idempotency key. */
const PER_RUN_WORDS = ['request', 'req', 'trace', 'span', 'session', 'nonce', 'idempotency', 'correlation', 'traceparent'];

/** A value shaped like an identifier: an integer, or one token of letters, digits and joiners with a digit in it. */
const ID_VALUE = /^(?=[^\s]*\d)[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idShaped = (v: unknown) => (typeof v === 'number' ? Number.isInteger(v) : typeof v === 'string' && ID_VALUE.test(v));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const HEX = /^(?:0x)?[0-9a-f]{16,}$/i;
/** A short prefix, then a random tail of ten or more letters and digits: `req_8f3a2c1d9e7b`, `msg_01HZX3M7Q2AB`. */
const PREFIXED = /^[A-Za-z][A-Za-z0-9]{0,15}[_-]([A-Za-z0-9]{10,})$/;
/** A long token mixing upper case, lower case and digits, as nanoid and base62 ids do. */
const TOKEN = /^[A-Za-z0-9_-]{16,}$/;

/** A value that looks generated rather than chosen: a UUID, a ULID, 16 or more hex digits, a prefix with a random tail, a long random token. */
export function looksGenerated(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  if (UUID.test(v) || ULID.test(v) || HEX.test(v)) return true;
  const tail = PREFIXED.exec(v)?.[1];
  if (tail && /\d/.test(tail) && /[A-Za-z]/.test(tail)) return true;
  return TOKEN.test(v) && /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v);
}

/** How sure it is that an id changes every run, or null when the key or the values aren't an id's. */
function idChange(path: string, values: readonly unknown[]): { certain: boolean } | null {
  const words = keyWords(lastKey(path));
  if (!idKey(words) || !values.every(idShaped)) return null;
  return { certain: words.some((w) => PER_RUN_WORDS.includes(w)) || values.every(looksGenerated) };
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
      return { path: entry.path, looks, op: 'changed', certain: true, normalizer: hint.normalizer };
    }
    const id = typeof entry.before === typeof entry.after ? idChange(entry.path, [entry.before, entry.after]) : null;
    if (id) return { path: entry.path, looks: id.certain ? 'a generated id' : 'an id', op: 'changed', certain: id.certain, normalizer: scoped(d, { path: entry.path, replace: '<ID>' }) };
    return null;
  }
  if (entry.op === 'added') {
    if (typeof entry.after === 'string') {
      for (const { pattern, placeholder, looks } of PATTERNS) {
        const re = compilePattern(pattern);
        const m = re.exec(entry.after);
        // The value is the pattern, or the pattern is most of it: a date inside a sentence is a prompt change.
        if (m && m[0].length >= entry.after.trim().length * 0.6) return { path: entry.path, looks, op: 'added', certain: true, normalizer: scoped(d, { path: entry.path, pattern, replace: placeholder }) };
      }
    }
    // A new field holding an id that may be a real one is just part of the change: the update records it.
    if (idChange(entry.path, [entry.after])?.certain) return { path: entry.path, looks: 'a generated id', op: 'added', certain: true, normalizer: scoped(d, { path: entry.path, replace: '<ID>' }) };
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
 * A divergence's hints without those for a change the rules in force mask: the report lists every
 * change in the request as sent, but a masked one didn't make it diverge, and "add a normalizer" for
 * a rule the config has is advice already taken. A hint with no rule (the clock's) stays.
 */
export function unmaskedHints(d: DivergenceReport, rules: readonly Normalizer[]): NonNullable<DivergenceReport['hints']> {
  return (d.hints ?? []).filter((h) => {
    const path = h.normalizer?.path;
    if (path === undefined) return true;
    const at = (d.diff ?? []).filter((e) => e.path === path);
    return !at.length || !at.every((e) => maskedChange(e, rules, d));
  });
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
  const covered = (sure: boolean) => entries.length > 0 && entries.every((e) => values.some((v) => v.path === e.path && v.op === 'changed' && (v.certain || !sure)));
  return { values, explainsAll: covered(true), coversAll: covered(false) };
}

/**
 * Hints for the values in a divergence that the engine's own hints (dates, UUIDs, ULIDs) don't name,
 * each with its normalizer, so the report says what to do about every value it lists: an id made
 * anew on every run, an id that may be a real change, and such a value the request newly carries.
 */
export function valueHints(d: DivergenceReport, normalizers: readonly Normalizer[] = []): Hint[] {
  const named = new Set((d.hints ?? []).map((h) => h.normalizer?.path).filter((p): p is string => !!p));
  return volatileValues(d, normalizers)
    .values.filter((v) => !named.has(v.path))
    .map((v) => ({
      message:
        v.op === 'added'
          ? `${v.path} is new in the request and looks like ${v.looks}: if the change is meant, add this normalizer as well as updating the golden, or the next run diverges on it`
          : v.certain
            ? `${v.path} looks like ${v.looks}, made anew on every run; to ignore it in matching, add a normalizer`
            : `${v.path} is an id, and a changed id may be a real change (another customer, another order); only if this one is made anew on every run, add a normalizer`,
      normalizer: v.normalizer,
    }));
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
