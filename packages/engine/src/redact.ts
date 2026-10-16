import { createHash } from 'node:crypto';
import { encodeEventStreamFrame, eventStreamFrames, type EventStreamFrame } from './eventstream.js';
import { loadApiRequest, storeApiRequest, type RequestManifest } from './manifest.js';
import { applyNormalizers, compilePattern, normalizerApplies, parsePath, rewriteStringsDeep, rewriteText, type RewriteObserver } from './normalize.js';
import { maskJsonChunks, maskSseStream, maskStreamed } from './redact-stream.js';
import { redactRunFacts } from './run-facts.js';
import type { Store } from './store.js';
import type { CallEndRow, CallKind, CallMeta, CallRecord, DiffEntry, DivergenceReport, Normalizer, RunMeta, RunRecord, SerializedError } from './types.js';

/**
 * Redaction: a copy of a run whose stored requests and responses have the rules applied.
 * Path-scoped rules apply to requests (they are JSON); pathless pattern rules apply to every
 * string of a request, to the raw text of a response, and to an attempt's error. The copy records
 * the rules in its run metadata so a replay applies them as normalizers and still matches (a rule
 * must therefore be idempotent: its replacement must not match its own pattern).
 *
 * What the run record itself repeats of that content is masked too: the flags that made a fork
 * (an `--override` carries a whole tool result), the divergence report's diff and reason, the
 * checks' details, and each call's error, injected failure and response headers. The run's command
 * line, labels and notes are copied as they are: a replay of the copy runs that command. A copy that
 * is only ever read (`export html`) masks them too: redactRunWithDetails.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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

/** What `pack` writes for a call's request: the rules applied to a copy of it. `export dataset` reads requests through this too. */
export function redactedRequest(src: Store, call: CallRecord, rules: Normalizer[], observer?: RewriteObserver): unknown {
  return applyNormalizers(storedRequest(src, call), rules, call.kind, call.name, observer);
}

/**
 * What `pack` writes for a response: every pathless rule applied as redactBytes applies it, across a
 * streamed response's events too. `export dataset` reads responses through this too.
 */
export function redactedResponse(bytes: Buffer, rules: Normalizer[]): Buffer {
  return redactBytes(bytes, rules);
}

/** What the pathless rules match in a response's text as it was recorded, for the preview; binary is skipped. */
function observeResponse(bytes: Buffer, rules: Normalizer[], observer: RewriteObserver): void {
  const text = asText(bytes);
  if (text !== null) rewriteText(text, rules, observer);
}

/** A string in a JSON document's text: in valid JSON, a quote opens one and the next unescaped quote closes it. */
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;

/**
 * A JSON document's text (a response, a tool's result, a clock or random read) with the pathless
 * rules applied to its strings alone, as they apply to a request's strings. Numbers and the
 * document's layout stay byte for byte, so a recorded timestamp whose 13 digits a card-number
 * pattern matches still reads as that number when the copy replays. Null when the text is not one
 * JSON document.
 */
function rewriteJsonText(text: string, rules: Normalizer[]): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return text.replace(JSON_STRING, (literal) => {
    const value = JSON.parse(literal) as string;
    const masked = rewriteText(value, rules);
    return masked === value ? literal : JSON.stringify(masked);
  });
}

/** An attempt's error as `pack` keeps it: the pathless rules applied to every string in it, as to the response it came with. */
function redactedError(error: SerializedError, rules: Normalizer[], observer?: RewriteObserver): SerializedError {
  let out: unknown = error;
  rules.forEach((n, i) => {
    if (n.path !== undefined || n.pattern === undefined) return;
    const changed = observer?.changed ? (before: string, after: string, count: number) => observer.changed!(i, before, after, count) : undefined;
    out = rewriteStringsDeep(out, compilePattern(n.pattern), n.replace, changed);
  });
  return out as SerializedError;
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
  return dst.putBlob(redactBytes(bytes, rules));
}

/** The bytes as a string when they are text (UTF-8 that round-trips), else null. */
function asText(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/** Every string inside a JSON value with the pathless rules applied. */
function rewriteDeep(value: unknown, rules: Normalizer[]): unknown {
  if (typeof value === 'string') return rewriteText(value, rules);
  if (Array.isArray(value)) return value.map((v) => rewriteDeep(v, rules));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteDeep(v, rules)]));
  return value;
}

/**
 * One event stream payload with the pathless rules applied, or null when nothing in it changed (or it
 * is not text). InvokeModelWithResponseStream wraps the provider's own event in base64 `bytes`, which
 * is decoded, masked and encoded again; ConverseStream's events are JSON as they are.
 */
function redactEventPayload(payload: Buffer, rules: Normalizer[]): Buffer | null {
  const text = asText(payload);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (isObject(parsed) && typeof parsed.bytes === 'string') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key === 'bytes') {
        const inner = asText(Buffer.from(value as string, 'base64'));
        const masked = inner === null ? null : rewriteText(inner, rules);
        if (masked !== null && masked !== inner) {
          changed = true;
          out[key] = Buffer.from(masked, 'utf8').toString('base64');
        } else out[key] = value;
      } else {
        const masked = rewriteDeep(value, rules);
        if (JSON.stringify(masked) !== JSON.stringify(value)) changed = true;
        out[key] = masked;
      }
    }
    return changed ? Buffer.from(JSON.stringify(out), 'utf8') : null;
  }
  const masked = rewriteText(text, rules);
  return masked === text ? null : Buffer.from(masked, 'utf8');
}

/**
 * One frame's event, parsed, and how to write the frame's payload again once the event has changed.
 * InvokeModelWithResponseStream wraps the provider's own event in base64 `bytes`. Null when the
 * payload is no JSON.
 */
function frameEvent(payload: Buffer): { event: unknown; encode: () => Buffer } | null {
  const parse = (bytes: Buffer): unknown => {
    const text = asText(bytes);
    if (text === null) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const outer = parse(payload);
  if (outer === undefined) return null;
  if (isObject(outer) && typeof outer.bytes === 'string') {
    const inner = parse(Buffer.from(outer.bytes, 'base64'));
    if (inner === undefined) return null;
    return { event: inner, encode: () => Buffer.from(JSON.stringify({ ...outer, bytes: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }), 'utf8') };
  }
  return { event: outer, encode: () => Buffer.from(JSON.stringify(outer), 'utf8') };
}

/**
 * A Bedrock event stream with every frame's payload masked: first the text the model streamed in
 * pieces, across frames, then each payload as text. A frame nothing matched stays byte for byte.
 */
function redactEventStream(frames: EventStreamFrame[], rules: Normalizer[]): Buffer {
  const events = frames.map((f) => frameEvent(f.payload));
  const across = maskStreamed(
    events.map((e) => e?.event),
    rules,
  );
  return Buffer.concat(
    frames.map((f, i) => {
      const payload = across.has(i) ? events[i]!.encode() : f.payload;
      const masked = redactEventPayload(payload, rules) ?? payload;
      return masked.equals(f.payload) ? f.raw : encodeEventStreamFrame(f.headers, masked);
    }),
  );
}

/**
 * A stored response, or any bytes, with every pathless rule applied to its text. A streamed response
 * (server-sent events, Gemini's array of chunks, or Bedrock's AWS event stream) is first masked
 * across its events, since the model's text arrives in pieces a rule never sees whole (see
 * redact-stream.ts). An event stream's frames are rebuilt with new checksums. Other bytes that are
 * not text stay as they are.
 */
export function redactBytes(bytes: Buffer, rules: Normalizer[]): Buffer {
  if (!rules.some((n) => n.path === undefined && n.pattern !== undefined)) return bytes;
  const frames = eventStreamFrames(bytes);
  if (frames) return redactEventStream(frames, rules);
  const text = asText(bytes);
  if (text === null) return bytes;
  const streamed = maskSseStream(text, rules) ?? maskJsonChunks(text, rules) ?? text;
  // A JSON document gets the rules on its strings; other text (an event stream, plain text) as text.
  return Buffer.from(rewriteJsonText(streamed, rules) ?? rewriteText(streamed, rules), 'utf8');
}

/**
 * A diff entry's value with the rules applied as if it were still in the request at `path`: the path
 * rules for that place, the pathless rules everywhere. A path that can't be read gets the pathless rules.
 */
function redactAt(path: string, value: unknown, rules: Normalizer[], kind: CallKind, name: string): unknown {
  if (value === undefined) return value;
  const pathless = () => applyNormalizers(value, rules.filter((r) => r.path === undefined), kind, name);
  let segs: ReturnType<typeof parsePath>;
  try {
    segs = parsePath(path);
  } catch {
    return pathless();
  }
  const keys: Array<string | number> = [];
  for (const seg of segs) {
    if (seg.type === 'wild') return pathless();
    keys.push(seg.type === 'index' ? Math.max(0, seg.index) : seg.key);
  }
  // The value at its path in an otherwise empty request.
  const root: Record<string, unknown> = {};
  let holder: Record<string | number, unknown> = root;
  let slot: string | number = 'doc';
  for (const key of keys) {
    const node: Record<string | number, unknown> = typeof key === 'number' ? (new Array(key + 1) as unknown as Record<number, unknown>) : {};
    holder[slot] = node;
    holder = node;
    slot = key;
  }
  holder[slot] = value;
  let node: unknown = applyNormalizers(root.doc, rules, kind, name);
  for (const key of keys) {
    // A rule on an ancestor replaced the whole value: that replacement is what the copy shows.
    if (node === null || typeof node !== 'object') return node;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

function redactDivergence(d: DivergenceReport, rules: Normalizer[]): DivergenceReport {
  const entry = (e: DiffEntry): DiffEntry => ({
    ...e,
    ...('before' in e ? { before: redactAt(e.path, e.before, rules, d.kind, d.name) } : {}),
    ...('after' in e ? { after: redactAt(e.path, e.after, rules, d.kind, d.name) } : {}),
  });
  return { ...d, ...(d.diff ? { diff: d.diff.map(entry) } : {}), ...(d.reason !== undefined ? { reason: rewriteText(d.reason, rules) } : {}) };
}

/**
 * The run's own record of its content, masked. A fork's flags keep only their display form: `args`
 * can carry a whole `--override` result, and a copy is never made again from its record anyway, so
 * the `--expect` it was judged by goes too. Each flag is rebuilt from the fields a flag has, so a
 * record from someone else's pack carries nothing else along. Checks keep their verdicts, with their
 * details masked. A record that isn't a list is left for the read side, which skips it.
 */
function redactMeta(meta: RunMeta | undefined, rules: Normalizer[]): RunMeta {
  const { expect: _expect, ...rest } = meta ?? {};
  const out: RunMeta = { ...rest, redactions: [...(meta?.redactions ?? []), ...rules] };
  const text = (v: unknown): string => (typeof v === 'string' ? rewriteText(v, rules) : '');
  if (Array.isArray(meta?.interventions)) out.interventions = meta.interventions.filter(isObject).map((i) => ({ kind: i.kind, at: i.at, flag: text(i.flag) }));
  if (Array.isArray(meta?.checks)) out.checks = meta.checks.filter(isObject).map((c) => ({ ...c, label: text(c.label), detail: c.detail === null ? null : text(c.detail) }));
  return out;
}

/** A call's metadata with what it repeats of the content masked: its error, an injected failure's message, the response headers. */
function redactCallMeta(meta: CallMeta, rules: Normalizer[]): CallMeta {
  const out: CallMeta = { ...meta };
  if (meta.error) out.error = redactedError(meta.error, rules);
  if (isObject(meta.failure) && typeof meta.failure.message === 'string') out.failure = { ...meta.failure, message: rewriteText(meta.failure.message, rules) };
  if (meta.headers) out.headers = Object.fromEntries(Object.entries(meta.headers).map(([k, v]) => [k, rewriteText(v, rules)]));
  return out;
}

/** Copies `runId` from `src` into `dst` with `rules` applied. The copy keeps the run id. */
export function redactRun(src: Store, runId: string, rules: Normalizer[], dst: Store): RunRecord {
  const run = src.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const copy: RunRecord = {
    ...run,
    parentRunId: run.parentRunId && dst.getRun(run.parentRunId) ? run.parentRunId : null,
    divergence: run.divergence ? redactDivergence(run.divergence, rules) : null,
    // The run page's facts in the metadata (the hosts the guard named) are masked too.
    meta: redactRunFacts(redactMeta(run.meta, rules), rules),
  };
  dst.transaction(() => {
    dst.importRun(copy);
    for (const call of src.getCalls(runId)) {
      const { end, attempts, ...start } = call;
      dst.appendCallStart({ ...start, requestRef: redactRequest(src, call, rules, dst) });
      const identity = { kind: call.kind, name: call.name, fingerprint: call.fingerprint, occurrence: call.occurrence };
      const redactEnd = (e: CallEndRow): CallEndRow => ({ ...e, meta: redactCallMeta(e.meta, rules), responseRef: redactResponse(src, e.responseRef, rules, dst) });
      for (const a of attempts) dst.appendCallEnd(identity, redactEnd(a));
      if (end) dst.appendCallEnd(identity, redactEnd(end));
    }
  });
  return copy;
}

// ---- the run's own record ----

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A run's own record with the rules without a path applied to what a person or a command line
 * wrote in it, outside its calls: the command line and its folder, labels, notes, outcome checks,
 * the file or golden it came from, its author, what blame changed, and the divergence report's
 * values and words. Ids, times and Shadowlap's own words stay as they are.
 */
export function redactRunDetails(run: RunRecord, rules: Normalizer[]): RunRecord {
  if (!rules.some((r) => r.path === undefined && r.pattern !== undefined)) return run;
  const text = (value: string) => rewriteText(value, rules);
  const deep = (value: unknown): unknown => (typeof value === 'string' ? text(value) : Array.isArray(value) ? value.map(deep) : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)])) : value);
  const out: RunRecord = { ...run, command: { ...run.command, argv: run.command.argv.map(text), cwd: text(run.command.cwd) } };
  const meta = run.meta;
  if (meta) {
    const m: RunMeta = { ...meta };
    if (meta.labels) m.labels = meta.labels.map(text);
    if (meta.notes) m.notes = meta.notes.map((n) => ({ ...n, text: text(n.text) }));
    if (meta.checks) m.checks = meta.checks.map((c) => ({ ...c, label: text(c.label), detail: c.detail === null ? null : text(c.detail) }));
    if (meta.imported) m.imported = { ...meta.imported, from: text(meta.imported.from) };
    if (meta.test) m.test = { ...meta.test, golden: text(meta.test.golden) };
    if (typeof meta.author === 'string') m.author = text(meta.author);
    if (meta.blame) m.blame = { ...meta.blame, fields: deep(meta.blame.fields) as Record<string, unknown>, oracle: meta.blame.oracle.map(text) };
    out.meta = m;
  }
  const d = run.divergence;
  if (d) {
    out.divergence = {
      ...d,
      ...(d.diff ? { diff: d.diff.map((e) => ({ ...e, ...('before' in e ? { before: deep(e.before) } : {}), ...('after' in e ? { after: deep(e.after) } : {}) })) } : {}),
      ...(d.hints ? { hints: d.hints.map((h) => ({ ...h, message: text(h.message) })) } : {}),
      ...(typeof d.reason === 'string' ? { reason: text(d.reason) } : {}),
    };
  }
  return out;
}

/** `src` as a copy that is only read sees it: each run's own record masked (redactRunDetails). */
function withRunDetailsRedacted(src: Store, rules: Normalizer[]): Store {
  return Object.create(src, {
    getRun: {
      value: (runId: string) => {
        const run = src.getRun(runId);
        return run && redactRunDetails(run, rules);
      },
    },
  }) as Store;
}

/**
 * The copy `export html` and the dashboard's download make: what `pack` copies (redactRun), and the
 * run's own record masked as well (redactRunDetails), since this copy is read, never replayed.
 */
export function redactRunWithDetails(src: Store, runId: string, rules: Normalizer[], dst: Store): RunRecord {
  return redactRun(withRunDetailsRedacted(src, rules), runId, rules, dst);
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
  /**
   * Set when a limit stopped the preview early (PreviewLimits): how many of the run's calls it read,
   * and which limit it reached.
   */
  partial: { read: number; of: number; stopped: 'calls' | 'bytes' | 'time' } | null;
  /** Everything the rules would mask in what `pack` copies, summed over the rules. */
  total: number;
  rules: RedactionRulePreview[];
  /**
   * The run's details: matches of the rules without a path in its command line, labels and notes,
   * with up to two samples and the rules (numbered from 1) that match. Exports that only show a run
   * (export html, dataset, otel) mask them; pack copies them as recorded, since a replay runs the
   * command. Not part of `total`.
   */
  details: { count: number; samples: Array<{ before: string; after: string }>; rules: number[] };
}

/**
 * Where a preview stops before the end of a long run, for a caller that must answer while someone
 * waits (the dashboard). It stops between calls: the first limit reached ends it, and `partial`
 * says which. The CLI's `redact preview` sets none and reads every call.
 */
export interface PreviewLimits {
  /** Calls to read at most. */
  maxCalls?: number;
  /** Bytes of stored requests and responses to read at most (each stored part counted once). */
  maxBytes?: number;
  /** A time (ms since the epoch) after which no further call is read. */
  deadline?: number;
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

const shownText = (v: unknown): string => (typeof v === 'string' ? v : v instanceof Uint8Array ? `<${v.length} bytes>` : (JSON.stringify(v) ?? String(v)));
const digest = (v: unknown): string => createHash('sha1').update(shownText(v)).digest('base64');

/**
 * Whether a rule sees a request's system prompt, its tools, its list of messages or one whole
 * message as a single value, or counts messages from the end. Such a rule needs every request
 * whole; any other rule sees the same values in a part that is repeated from an earlier request.
 */
function seesWholeParts(rule: Normalizer): boolean {
  if (rule.path === undefined) return false;
  const segs = parsePath(rule.path);
  if (segs.length === 0 || segs.some((g) => g.type === 'index' && g.index < 0)) return true;
  const first = segs[0]!;
  const at = (key: string) => first.type === 'wild' || (first.type === 'key' && first.key === key);
  return (segs.length === 1 && (at('system') || at('tools') || at('messages'))) || (segs.length === 2 && at('messages'));
}

/**
 * A model request with the parts already read for an earlier request of the same call name left
 * out (as null): the system prompt, the tools, and each message at its place in the conversation.
 */
function unseenParts(store: Store, call: CallRecord, seen: Set<string>): unknown {
  const manifest = store.getJson<RequestManifest>(call.requestRef!);
  if (!manifest || manifest.kind !== 'chunked') return storedRequest(store, call);
  const part = (where: string, hash: string): unknown => {
    const key = `${call.name}\u0000${where}\u0000${hash}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return store.getJson(hash);
  };
  const body: Record<string, unknown> = { ...manifest.fields };
  if (manifest.system !== null) body.system = part('system', manifest.system);
  if (manifest.tools !== null) body.tools = part('tools', manifest.tools);
  body.messages = manifest.messages.map((hash, j) => part(`messages.${j}`, hash));
  return body;
}

/**
 * What `shadowlap pack` would mask in one run, without writing anything: each rule applied to the
 * run's stored requests and responses exactly as pack applies it (path rules on requests, pathless
 * rules on every string of a request, on the text of every response and on an attempt's error,
 * retries included), with a count per rule and two samples. The local store is never modified. A
 * run still recording is refused: its calls are still arriving, so the count would be out of date
 * before it was read (a run its process abandoned is not recording).
 *
 * Every request of a conversation sends the earlier messages again, and a value repeated that way
 * counts once; so a message already read at the same place in an earlier request is not read
 * again, and the preview takes time in proportion to the run, not to the square of its length.
 * Limits stop it between calls, for a caller that must answer quickly (PreviewLimits); `partial`
 * then says how far it got and why it stopped.
 */
export function previewRedaction(store: Store, runId: string, rules: Normalizer[], options: PreviewLimits = {}): RedactionPreview {
  const run = store.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  // A run its process abandoned can be previewed: nothing will add to it.
  if (run.status === 'running' && store.recordingRuns().live.some((r) => r.run.runId === run.runId)) throw new Error(`${runId.slice(0, 10)} is still recording; preview it once it has ended`);
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
      if (r.samples.length < SAMPLES) r.samples.push(clipChange(shownText(before), shownText(after)));
    },
  };
  const all = store.getCalls(runId);
  // Every stored part is read through here, each once (readingOnce), so `bytes` is what was read.
  let bytes = 0;
  const counting = Object.create(store, {
    getBlob: {
      value: (hash: string) => {
        const blob = store.getBlob(hash);
        bytes += blob?.length ?? 0;
        return blob;
      },
    },
  }) as Store;
  const reader = readingOnce(counting);
  const skipSeen = !rules.some(seesWholeParts);
  const seen = new Set<string>();
  let read = 0;
  let unreadable = 0;
  let stopped: NonNullable<RedactionPreview['partial']>['stopped'] | null = null;
  for (const call of all) {
    if (options.maxCalls !== undefined && read >= options.maxCalls) stopped = 'calls';
    else if (options.maxBytes !== undefined && bytes >= options.maxBytes) stopped = 'bytes';
    else if (options.deadline !== undefined && Date.now() >= options.deadline) stopped = 'time';
    if (stopped) break;
    read++;
    rules.forEach((rule, i) => {
      if (normalizerApplies(rule, call.kind, call.name)) per[i]!.scoped++;
    });
    try {
      if (call.requestRef) {
        const request = call.kind === 'api' && skipSeen ? unseenParts(reader, call, seen) : storedRequest(reader, call);
        applyNormalizers(request, rules, call.kind, call.name, observer);
      }
      for (const end of [...call.attempts, ...(call.end ? [call.end] : [])]) {
        const response = end.responseRef ? counting.getBlob(end.responseRef) : null;
        if (response) observeResponse(response, rules, observer);
        if (end.meta.error) redactedError(end.meta.error, rules, observer);
      }
    } catch {
      unreadable++;
    }
  }
  const previews = rules.map((rule, i): RedactionRulePreview => {
    const r = per[i]!;
    return { n: i + 1, rule, count: r.count, samples: r.samples, reached: rule.path === undefined ? null : r.reached, note: r.count ? null : zeroNote(rule, r.scoped, r.reached) };
  });
  // The run's details, as the exports that carry them mask them (redactRunDetails): the command line as one text, each label and each note.
  const details: RedactionPreview['details'] = { count: 0, samples: [], rules: [] };
  const detailObserver: RewriteObserver = {
    changed(i, before, after, count) {
      details.count += count;
      if (!details.rules.includes(i + 1)) details.rules.push(i + 1);
      if (details.samples.length < SAMPLES) details.samples.push(clipChange(shownText(before), shownText(after)));
    },
  };
  for (const text of [run.command.argv.join(' '), ...(run.meta?.labels ?? []), ...(run.meta?.notes ?? []).map((n) => n.text)]) rewriteText(text, rules, detailObserver);
  details.rules.sort((a, b) => a - b);
  return { runId, calls: read - unreadable, unreadable, partial: stopped ? { read, of: all.length, stopped } : null, total: previews.reduce((s, p) => s + p.count, 0), rules: previews, details };
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

/** An export a run can leave the machine by, and which redaction rules it applies (decision 6). */
export interface RedactionExport {
  id: 'pack' | 'html' | 'har' | 'dataset' | 'pairs' | 'otel';
  command: string;
  /**
   * `all`: every rule, on every request and response it copies and the errors with them, as `pack`
   * applies them. `messages`: the rules on the conversations and answers it keeps (path rules on
   * the message fields there), then the rules without a path on every string it writes.
   * `attributes`: it carries no prompt text; the rules without a path apply to the names, command
   * line and errors it keeps.
   */
  applies: 'all' | 'messages' | 'attributes';
  /**
   * The run's details (its command line, labels and notes; RedactionPreview.details): `masked` by
   * the rules without a path, `kept` as recorded (pack: a replay runs the command), or `absent`
   * from what it writes.
   */
  details: 'masked' | 'kept' | 'absent';
  /** The same, in words for the Settings page. */
  note: string;
}

/**
 * Where the project's redaction rules apply: every way a run's content leaves this machine, as
 * decision 6 has it (packages/cli/test/redaction-exports.test.ts holds each export this build has
 * to its entry). The local store is never modified, and API keys and authorization headers are
 * never stored at all.
 */
export const REDACTION_EXPORTS: readonly RedactionExport[] = [
  { id: 'pack', command: 'shadowlap pack', applies: 'all', details: 'kept', note: 'every rule, on every request and response it copies and the errors with them; the command line, labels and notes are copied as recorded, since a replay runs the command' },
  { id: 'html', command: 'shadowlap export html', applies: 'all', details: 'masked', note: 'every rule, as pack applies them, and the rules without a path on the command line, labels and notes too' },
  { id: 'har', command: 'shadowlap export har', applies: 'all', details: 'absent', note: 'every rule on the model calls it holds: the whole request, and the rules without a path on URLs, headers and responses; it holds no tool calls and no command line' },
  { id: 'dataset', command: 'shadowlap export dataset', applies: 'messages', details: 'masked', note: 'every rule on the conversations and answers it keeps, as pack applies them, and the rules without a path on the rest of each row: command line, labels and notes' },
  { id: 'pairs', command: 'shadowlap export pairs', applies: 'messages', details: 'absent', note: 'the rules on the conversations and answers it keeps: path rules on the request and on tool arguments and results, and the rules without a path on every string' },
  { id: 'otel', command: 'shadowlap export otel', applies: 'attributes', details: 'masked', note: 'no prompt text leaves; the rules without a path on the names, command line and errors it keeps' },
];
