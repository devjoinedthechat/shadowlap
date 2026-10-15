import { createHash } from 'node:crypto';
import { loadApiRequest, storeApiRequest } from './manifest.js';
import { applyNormalizers, compilePattern, normalizerApplies, parsePath, rewriteText, type RewriteObserver } from './normalize.js';
import type { Store } from './store.js';
import type { CallEndRow, CallRecord, Normalizer, RunRecord } from './types.js';

/**
 * Redaction: a copy of a run whose stored requests and responses have the rules applied.
 * Path-scoped rules apply to requests (they are JSON); pathless pattern rules apply to every
 * string of a request and to the raw text of a response. The copy records the rules in its run
 * metadata so a replay applies them as normalizers and still matches (a rule must therefore be
 * idempotent: its replacement must not match its own pattern).
 */

/** A call's request as it is stored: a model request is rebuilt from its manifest, a tool's is JSON. */
function storedRequest(src: Store, call: CallRecord): unknown {
  return call.kind === 'api' ? loadApiRequest(src, call.requestRef!) : src.getJson(call.requestRef!);
}

/**
 * The store, reading each JSON blob once. Every model request carries the whole conversation, so
 * the same message blobs are read again for each call; the rules apply to a copy of each request,
 * so sharing what was parsed changes nothing they see.
 */
function readingOnce(store: Store): Store {
  const parsed = new Map<string, unknown>();
  return Object.create(store, {
    getJson: {
      value: (hash: string) => {
        if (!parsed.has(hash)) parsed.set(hash, store.getJson(hash));
        return parsed.get(hash);
      },
    },
  }) as Store;
}

/** What `pack` writes for a call's request: the rules applied to a copy of it. */
function redactedRequest(src: Store, call: CallRecord, rules: Normalizer[], observer?: RewriteObserver): unknown {
  return applyNormalizers(storedRequest(src, call), rules, call.kind, call.name, observer);
}

/** What `pack` writes for a response: the pathless rules applied to its text. Binary stays as it is. */
function redactedResponse(bytes: Buffer, rules: Normalizer[], observer?: RewriteObserver): Buffer {
  const text = bytes.toString('utf8');
  // Only rewrite what round-trips as text; binary responses stay as they are.
  return Buffer.from(text, 'utf8').equals(bytes) ? Buffer.from(rewriteText(text, rules, observer), 'utf8') : bytes;
}

function redactRequest(src: Store, call: CallRecord, rules: Normalizer[], dst: Store): string | null {
  if (!call.requestRef) return null;
  const body = redactedRequest(src, call, rules);
  return call.kind === 'api' ? storeApiRequest(dst, body) : dst.putJson(body);
}

function redactResponse(src: Store, ref: string | null, rules: Normalizer[], dst: Store): string | null {
  if (!ref) return null;
  const bytes = src.getBlob(ref);
  if (!bytes) return null;
  return dst.putBlob(redactedResponse(bytes, rules));
}

/** Copies `runId` from `src` into `dst` with `rules` applied. The copy keeps the run id. */
export function redactRun(src: Store, runId: string, rules: Normalizer[], dst: Store): RunRecord {
  const run = src.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const existing = run.meta?.redactions ?? [];
  const copy: RunRecord = { ...run, parentRunId: run.parentRunId && dst.getRun(run.parentRunId) ? run.parentRunId : null, meta: { ...run.meta, redactions: [...existing, ...rules] } };
  dst.transaction(() => {
    dst.importRun(copy);
    for (const call of src.getCalls(runId)) {
      const { end, attempts, ...start } = call;
      dst.appendCallStart({ ...start, requestRef: redactRequest(src, call, rules, dst) });
      const identity = { kind: call.kind, name: call.name, fingerprint: call.fingerprint, occurrence: call.occurrence };
      const redactEnd = (e: CallEndRow): CallEndRow => ({ ...e, responseRef: redactResponse(src, e.responseRef, rules, dst) });
      for (const a of attempts) dst.appendCallEnd(identity, redactEnd(a));
      if (end) dst.appendCallEnd(identity, redactEnd(end));
    }
  });
  return copy;
}

// ---- the preview ----

/** One rule in a redaction preview. */
export interface RedactionRulePreview {
  /** Position in the project's rules, from 1, as `shadowlap redact ls` numbers them. */
  n: number;
  rule: Normalizer;
  /** Matches the rule would mask. A value repeated in every later request of a conversation counts once. */
  count: number;
  /** Up to two values before and after, cut to the change and a little around it. */
  samples: Array<{ before: string; after: string }>;
  /** For a rule with a path: the distinct values found at it, changed or not. Null for a rule without one. */
  reached: number | null;
  /** Why the count is 0, in words; null when it isn't. */
  note: string | null;
}

export interface RedactionPreview {
  runId: string;
  /** Calls whose requests and responses were read. */
  calls: number;
  /** Calls left out because a stored request or response could not be read. */
  unreadable: number;
  /** Everything the rules would mask, summed over the rules. */
  total: number;
  rules: RedactionRulePreview[];
}

const SAMPLES = 2;
const CONTEXT = 32;
const SAMPLE_MAX = 160;

/** The two versions of a value cut to where they differ, with a little context around the change. */
export function clipChange(before: string, after: string, context = CONTEXT, max = SAMPLE_MAX): { before: string; after: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  // Start and end the context on a word boundary where there is one close by.
  let from = Math.max(0, start - context);
  if (from > 0 && /\S/.test(before[from - 1]!)) {
    const space = before.slice(from, start).search(/\s/);
    if (space >= 0) from += space + 1;
  }
  const cut = (text: string): string => {
    let to = Math.min(text.length, text.length - tail + context);
    if (to < text.length && /\S/.test(text[to]!)) {
      const space = text.slice(text.length - tail, to).search(/\s[^\s]*$/);
      if (space >= 0) to = text.length - tail + space;
    }
    let piece = text.slice(from, to);
    const clipped = piece.length > max;
    if (clipped) piece = piece.slice(0, max - 1);
    return `${from > 0 ? '…' : ''}${piece}${clipped || to < text.length ? '…' : ''}`;
  };
  return { before: cut(before), after: cut(after) };
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : v instanceof Uint8Array ? `<${v.length} bytes>` : (JSON.stringify(v) ?? String(v)));
const digest = (v: unknown): string => createHash('sha1').update(asText(v)).digest('base64');

/**
 * What `shadowlap pack` would mask in one run, without writing anything: each rule applied to the
 * run's stored requests and responses exactly as pack applies it (path rules on requests, pathless
 * rules on every string of a request and on the text of every response, retries included), with a
 * count per rule and two samples. The local store is never modified. A run still recording is
 * refused: its calls are still arriving, so the count would be out of date before it was read.
 */
export function previewRedaction(store: Store, runId: string, rules: Normalizer[]): RedactionPreview {
  const run = store.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  if (run.status === 'running') throw new Error(`${runId.slice(0, 10)} is still recording; preview it once it has ended`);
  // A broken rule would fail every call; name it instead.
  rules.forEach((rule, i) => {
    try {
      if (rule.pattern !== undefined) compilePattern(rule.pattern);
      if (rule.path !== undefined) parsePath(rule.path);
    } catch (err) {
      throw new Error(`redaction rule #${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  const per = rules.map(() => ({ count: 0, reached: 0, scoped: 0, seen: new Set<string>(), reachedSeen: new Set<string>(), samples: [] as Array<{ before: string; after: string }> }));
  const observer: RewriteObserver = {
    reached(i, value) {
      const r = per[i]!;
      const key = digest(value);
      if (r.reachedSeen.has(key)) return;
      r.reachedSeen.add(key);
      r.reached++;
    },
    changed(i, before, after, count) {
      const r = per[i]!;
      // A conversation sends its earlier messages again with every request: count each value once.
      const key = digest(before);
      if (r.seen.has(key)) return;
      r.seen.add(key);
      r.count += count;
      if (r.samples.length < SAMPLES) r.samples.push(clipChange(asText(before), asText(after)));
    },
  };
  const calls = store.getCalls(runId);
  const reader = readingOnce(store);
  let unreadable = 0;
  for (const call of calls) {
    rules.forEach((rule, i) => {
      if (normalizerApplies(rule, call.kind, call.name)) per[i]!.scoped++;
    });
    try {
      if (call.requestRef) redactedRequest(reader, call, rules, observer);
      for (const end of [...call.attempts, ...(call.end ? [call.end] : [])]) {
        const bytes = end.responseRef ? store.getBlob(end.responseRef) : null;
        if (bytes) redactedResponse(bytes, rules, observer);
      }
    } catch {
      unreadable++;
    }
  }
  const previews = rules.map((rule, i): RedactionRulePreview => {
    const r = per[i]!;
    return { n: i + 1, rule, count: r.count, samples: r.samples, reached: rule.path === undefined ? null : r.reached, note: r.count ? null : zeroNote(rule, r.scoped, r.reached) };
  });
  return { runId, calls: calls.length - unreadable, unreadable, total: previews.reduce((s, p) => s + p.count, 0), rules: previews };
}

function zeroNote(rule: Normalizer, scoped: number, reached: number): string {
  if (rule.path === undefined && rule.pattern === undefined) return 'it has neither a path nor a pattern, so it changes nothing';
  // A response is matched by every rule without a path, whatever its scope, so a scope only rules out requests.
  if (rule.path === undefined) return 'no matches in this run';
  if (scoped === 0) return `no ${rule.kind ? `${rule.kind} call` : 'call'}${rule.name ? ` named ${rule.name}` : ''} in this run`;
  if (reached === 0) return `no request in this run has ${rule.path}`;
  if (rule.pattern === undefined) return `${rule.path} already reads ${rule.replace}`;
  return `${rule.path} is in ${reached === 1 ? 'a request' : `${reached} requests`}, but nothing there matches ${rule.pattern}`;
}

// ---- where the rules apply ----

/** An export a run can leave the machine by, and which redaction rules it applies. */
export interface RedactionExport {
  id: 'pack' | 'html' | 'har' | 'dataset' | 'pairs' | 'otel';
  command: string;
  /** `all`: every rule; `messages`: rules without a path, and path rules on the message fields it keeps; `attributes`: every rule, on the attributes it keeps. */
  applies: 'all' | 'messages' | 'attributes';
  /** The same, in words for the Settings page. */
  note: string;
}

/**
 * Where the project's redaction rules apply: every way a run's content leaves this machine. The
 * local store is never modified, and API keys and authorization headers are never stored at all.
 */
export const REDACTION_EXPORTS: readonly RedactionExport[] = [
  { id: 'pack', command: 'shadowlap pack', applies: 'all', note: 'every rule' },
  { id: 'html', command: 'shadowlap export html', applies: 'all', note: 'every rule' },
  { id: 'har', command: 'shadowlap export har', applies: 'all', note: 'every rule' },
  { id: 'dataset', command: 'shadowlap export dataset', applies: 'messages', note: 'rules without a path, and path rules on the message fields it keeps' },
  { id: 'pairs', command: 'shadowlap export pairs', applies: 'messages', note: 'rules without a path, and path rules on the message fields it keeps' },
  { id: 'otel', command: 'shadowlap export otel', applies: 'attributes', note: 'no prompt text; every rule on the attributes it keeps' },
];
