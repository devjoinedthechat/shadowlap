import { createHash } from 'node:crypto';
import { encodeEventStreamFrame, eventStreamFrames, type EventStreamFrame } from './eventstream.js';
import { reachesResultsOf, rewriteJsonDocument, untouched, type CallScope } from './json-doc.js';
import { loadApiRequest, storeApiRequest, type RequestManifest } from './manifest.js';
import { applyNormalizers, compilePattern, countMatches, normalizerApplies, parsePath, reportUnmasked, rewriteStringsDeep, rewriteText, type RewriteObserver, type Segment, type UnmaskedAt } from './normalize.js';
import { inEvent, maskJsonChunks, maskSseStream, maskStreamed } from './redact-stream.js';
import { redactRunFacts } from './run-facts.js';
import type { Store } from './store.js';
import { quoteArgv } from './text.js';
import type { CallEndRow, CallKind, CallMeta, CallRecord, DiffEntry, DivergenceReport, Normalizer, RunMeta, RunNote, RunRecord, SerializedError } from './types.js';

type RunCheck = NonNullable<RunMeta['checks']>[number];

/**
 * Redaction: a copy of a run whose stored requests and responses have the rules applied. Rules
 * without a path apply to every string of a request, to every string of a response or tool result
 * that is one JSON document (keys included; its numbers and layout stay byte for byte), to each
 * event of a streamed response the same way, to the raw text of any other response, and to an
 * attempt's error. Rules with a path apply to requests (they are JSON). The copy records the rules in
 * its run metadata so a replay applies them as normalizers and still matches (a rule must therefore
 * be idempotent: its replacement must not match its own pattern).
 *
 * What a call got back is what a replay of the copy hands the agent, so a pack keeps it as recorded
 * apart from those strings: a value masked whole there (a number turned into a string) would make
 * the replayed agent act on it differently and fork. A copy that is only ever read, never replayed
 * (export html, har and dataset), also applies a path rule to what a call got back when the path
 * starts with a key or a position (`$.result.card`): a response or tool result that is one JSON
 * document, and an attempt's error read as a tool stores it (`{ "error": … }`). That is how a number
 * there is masked, which no pattern rewrites (json-doc.ts). A clock or random read is never reached,
 * by a rule with a path or without one: it is the run's own time and randomness, which every copy
 * keeps as recorded (keptAsRecorded), or a replay of a pack would hand the agent `<REDACTED>` for
 * the uuid it read.
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
 * A response as a copy writes it, as redactBytes applies the rules, across a streamed response's
 * events too. With `call`, as a copy that is only read writes it (`export dataset`, which reads
 * responses through this): the path rules that reach what that call got back apply as well.
 */
export function redactedResponse(bytes: Buffer, rules: Normalizer[], call?: CallScope): Buffer {
  return redactBytes(bytes, rules, call);
}

/**
 * An attempt's error as a copy keeps it: the rules without a path applied to every string in it, as
 * to the response it came with. With `call`, for a copy that is only read, also the path rules that
 * reach what that call got back, the error read as a tool stores it: `{ "error": { "name",
 * "message", "code", "data" } }`, so `$.error.data.card`.
 */
function redactedError(error: SerializedError, rules: Normalizer[], observer?: RewriteObserver, call?: CallScope): SerializedError {
  let out: unknown = error;
  rules.forEach((n, i) => {
    if (n.path === undefined) {
      if (n.pattern === undefined) return;
      const changed = observer?.changed ? (before: string, after: string, count: number) => observer.changed!(i, before, after, count) : undefined;
      out = rewriteStringsDeep(out, compilePattern(n.pattern), n.replace, changed);
      return;
    }
    if (!call || !reachesResultsOf(n, call)) return;
    const one: RewriteObserver | undefined = observer && {
      ...(observer.reached ? { reached: (_: number, value: unknown) => observer.reached!(i, value) } : {}),
      ...(observer.changed ? { changed: (_: number, before: unknown, after: unknown, count: number) => observer.changed!(i, before, after, count) } : {}),
    };
    const wrapped = applyNormalizers({ error: out }, [n], call.kind, call.name, one) as { error: unknown };
    // A rule that replaced the whole of it leaves an error whose message is the replacement.
    out = isObject(wrapped.error) ? wrapped.error : { name: 'Error', message: typeof wrapped.error === 'string' ? wrapped.error : JSON.stringify(wrapped.error) };
  });
  if (observer?.unmasked) {
    reportUnmasked(out, rules, (n) => n.path === undefined, observer.unmasked, ['error']);
    if (call) reportUnmasked({ error: out }, rules, (n) => reachesResultsOf(n, call), observer.unmasked);
  }
  return out as SerializedError;
}

function redactRequest(src: Store, call: CallRecord, rules: Normalizer[], dst: Store): string | null {
  if (!call.requestRef) return null;
  const body = redactedRequest(src, call, rules);
  return call.kind === 'api' ? storeApiRequest(dst, body) : dst.putJson(body);
}

/**
 * Whether what a call got back is the run's own time or randomness, a clock or random read, which
 * every copy keeps as recorded whatever the rules: a replay hands it to the agent, which builds on
 * it (an id cut from the uuid it read, a date from the time), so a masked value would fork it.
 */
export function keptAsRecorded(call: Pick<CallScope, 'kind'>): boolean {
  return call.kind === 'clock' || call.kind === 'random';
}

/**
 * A call's name as every copy writes it. A captured HTTP call (a host under "http" in the config) is
 * named after the address the agent asked for, `GET api.example.com/contacts/alice@example.com`,
 * so the rules without a path that apply to tool calls mask its name as they mask the address in its
 * arguments. Any other call's name is the code's (a tool, a model API path) and stays as it is.
 *
 * A rule scoped to a call by its `name` masks that call's name, as it masks only that call's
 * arguments. A replay of the copy matches such a call by its masked name (matchedAs). `observer`
 * hears each rule's change, by its place in `rules`.
 */
export function redactedCallName(call: Pick<CallRecord, 'kind' | 'name' | 'meta'>, rules: readonly Normalizer[], observer?: RewriteObserver): string {
  if (call.kind !== 'tool' || typeof call.meta.http !== 'string') return call.name;
  let name = call.name;
  rules.forEach((rule, i) => {
    if (rule.path !== undefined || rule.pattern === undefined || !normalizerApplies(rule, 'tool', call.name)) return;
    const regex = compilePattern(rule.pattern);
    regex.lastIndex = 0;
    const next = name.replace(regex, rule.replace);
    if (next !== name) observer?.changed?.(i, name, next, countMatches(name, regex));
    name = next;
  });
  return name;
}

/**
 * How a replay of a redacted copy matches a call: the name the copy holds it under, and the
 * normalizers that apply to it. A captured HTTP call's name is masked by the copy's rules
 * (`meta.redactions`, redactedCallName), live and recorded alike, and so is the name each
 * normalizer is scoped to, so a rule written for `POST crm.example.com/contacts/alice@example.com`
 * applies to the call on both sides. Masking twice changes nothing, so a recorded name the copy
 * already masked, or one an older copy kept, comes out the same. Any other call, and a replay of a
 * run no rules redacted, is matched as it was recorded.
 */
export function matchedAs(call: Pick<CallRecord, 'kind' | 'name' | 'meta'>, normalizers: Normalizer[], redactions: readonly Normalizer[]): { name: string; normalizers: Normalizer[] } {
  if (!redactions.length || call.kind !== 'tool' || typeof call.meta.http !== 'string') return { name: call.name, normalizers };
  const masked = (name: string) => redactedCallName({ kind: 'tool', name, meta: call.meta }, redactions);
  return { name: masked(call.name), normalizers: normalizers.map((n) => (n.name === undefined ? n : { ...n, name: masked(n.name) })) };
}

/** What a call got back as a copy writes it: `read` for a copy that is only read (redactBytes' `call`). */
function redactResponse(src: Store, ref: string | null, rules: Normalizer[], dst: Store, call: CallScope, read: boolean): string | null {
  if (!ref) return null;
  const bytes = src.getBlob(ref);
  if (!bytes) return null;
  return dst.putBlob(keptAsRecorded(call) ? bytes : redactBytes(bytes, rules, read ? call : undefined));
}

/** The bytes as a string when they are text (UTF-8 that round-trips), else null. */
function asText(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/** Every string inside a JSON value with the pathless rules applied. */
function rewriteDeep(value: unknown, rules: Normalizer[], observer?: RewriteObserver): unknown {
  if (typeof value === 'string') return rewriteText(value, rules, observer);
  if (Array.isArray(value)) return value.map((v) => rewriteDeep(v, rules, observer));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteDeep(v, rules, observer)]));
  return value;
}

/**
 * One event stream payload with the rules without a path applied, or null when nothing in it changed
 * (or it is not text). InvokeModelWithResponseStream wraps the provider's own event in base64
 * `bytes`, which is decoded, masked and encoded again; ConverseStream's events are JSON as they are.
 * An event that is JSON is masked as a JSON document (its strings; its numbers and layout kept, so a
 * token count or a latency a pattern matches stays a number), any other text as text. `event` is
 * the frame's place in the stream, from 1, for the observer.
 */
function redactEventPayload(payload: Buffer, rules: Normalizer[], observer: RewriteObserver | undefined, event: number): Buffer | null {
  const text = asText(payload);
  if (text === null) return null;
  const masked = (t: string) => rewriteJsonDocument(t, rules, null, inEvent(observer, event)) ?? rewriteText(t, rules, observer);
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
        const next = inner === null ? null : masked(inner);
        if (next !== null && next !== inner) {
          changed = true;
          out[key] = Buffer.from(next, 'utf8').toString('base64');
        } else out[key] = value;
      } else {
        const next = rewriteDeep(value, rules, observer);
        if (JSON.stringify(next) !== JSON.stringify(value)) changed = true;
        out[key] = next;
      }
    }
    return changed ? Buffer.from(JSON.stringify(out), 'utf8') : null;
  }
  const next = masked(text);
  return next === text ? null : Buffer.from(next, 'utf8');
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
 * pieces, across frames, then each payload as redactEventPayload masks it. A frame nothing matched
 * stays byte for byte.
 */
function redactEventStream(frames: EventStreamFrame[], rules: Normalizer[], observer?: RewriteObserver): Buffer {
  const events = frames.map((f) => frameEvent(f.payload));
  const across = maskStreamed(
    events.map((e) => e?.event),
    rules,
    observer,
  );
  return Buffer.concat(
    frames.map((f, i) => {
      const payload = across.has(i) ? events[i]!.encode() : f.payload;
      const masked = redactEventPayload(payload, rules, observer, i + 1) ?? payload;
      return masked.equals(f.payload) ? f.raw : encodeEventStreamFrame(f.headers, masked);
    }),
  );
}

/**
 * A stored response, or any bytes, with the rules applied as every copy applies them. A streamed
 * response (server-sent events, Gemini's array of chunks, or Bedrock's AWS event stream) is first
 * masked across its events, since the model's text arrives in pieces a rule never sees whole (see
 * redact-stream.ts), then each event by its strings. A response that is one JSON document gets the
 * rules on its strings as rewriteJsonDocument applies them, its numbers and layout byte for byte;
 * any other text gets the rules without a path on its text. An event stream's frames are rebuilt
 * with new checksums. Other bytes that are not text stay as they are; so does a document no rule
 * could change, without being read (`untouched`).
 *
 * `call` is for a copy that is only read, never replayed (export html, har and dataset): the path
 * rules that reach what that call got back (reachesResultsOf) apply too, to a response that is one
 * JSON document. A pack passes none: its replay hands what calls got back to the agent. A clock or
 * random read is never passed here (keptAsRecorded); one that is given comes back as it is.
 *
 * The preview passes an observer and reads this to count exactly what a copy changes, and what the
 * rules match that it leaves as it is (previewRedaction); a copy passes none.
 */
export function redactBytes(bytes: Buffer, rules: Normalizer[], call?: CallScope, observer?: RewriteObserver): Buffer {
  if (call && keptAsRecorded(call)) return bytes;
  const pathless = rules.some((n) => n.path === undefined && n.pattern !== undefined);
  const reaching = !!call && rules.some((n) => reachesResultsOf(n, call));
  if (!pathless && !reaching) return bytes;
  const frames = eventStreamFrames(bytes);
  if (frames) return pathless ? redactEventStream(frames, rules, observer) : bytes;
  const text = asText(bytes);
  if (text === null) return bytes;
  if (pathless) {
    const sse = maskSseStream(text, rules, observer);
    if (sse !== null) return sse === text ? bytes : Buffer.from(sse, 'utf8');
  }
  const chunks = pathless ? maskJsonChunks(text, rules, observer) : null;
  const streamed = chunks ?? text;
  if (untouched(streamed, rules, call ?? null)) return chunks === null ? bytes : Buffer.from(streamed, 'utf8');
  // A JSON document gets the rules on its values; other text as text.
  const doc = rewriteJsonDocument(streamed, rules, call ?? null, observer);
  if (doc !== null) return doc === text ? bytes : Buffer.from(doc, 'utf8');
  return pathless ? Buffer.from(rewriteText(streamed, rules, observer), 'utf8') : bytes;
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
 * details masked, and so does the last blame: the labels of the checks it judged its attempts by
 * (the same labels as the checks', `output includes "…"`) and the request fields its probes changed,
 * their strings wherever they are. Another record that isn't a list is left for the read side,
 * which skips it.
 */
function redactMeta(meta: RunMeta | undefined, rules: Normalizer[]): RunMeta {
  const { expect: _expect, ...rest } = meta ?? {};
  const out: RunMeta = { ...rest, redactions: [...(meta?.redactions ?? []), ...rules] };
  const text = (v: unknown): string => (typeof v === 'string' ? rewriteText(v, rules) : '');
  if (Array.isArray(meta?.interventions)) out.interventions = meta.interventions.filter(isObject).map((i) => ({ kind: i.kind, at: i.at, flag: text(i.flag) }));
  if (Array.isArray(meta?.checks)) out.checks = meta.checks.filter(isObject).map((c) => ({ ...c, label: text(c.label), detail: c.detail === null ? null : text(c.detail) }));
  if (isObject(meta?.blame)) {
    const b = meta.blame;
    out.blame = { ...b, ...('oracle' in b ? { oracle: rewriteDeep(b.oracle, rules) as string[] } : {}), ...('fields' in b ? { fields: rewriteDeep(b.fields, rules) as Record<string, unknown> } : {}) };
  }
  return out;
}

/**
 * A call's metadata with what it repeats of the content masked: its error, an injected failure's
 * message, the response headers. `call` for a copy that is only read: the error gets the path rules
 * that reach what that call got back too.
 */
function redactCallMeta(meta: CallMeta, rules: Normalizer[], call: CallScope | undefined): CallMeta {
  const out: CallMeta = { ...meta };
  if (meta.error) out.error = redactedError(meta.error, rules, undefined, call);
  if (isObject(meta.failure) && typeof meta.failure.message === 'string') out.failure = { ...meta.failure, message: rewriteText(meta.failure.message, rules) };
  if (meta.headers) out.headers = Object.fromEntries(Object.entries(meta.headers).map(([k, v]) => [k, rewriteText(v, rules)]));
  return out;
}

export interface RedactRunOptions {
  /**
   * A copy that is only ever read, never replayed (`export html`): the path rules also reach what
   * calls got back (reachesResultsOf). A pack leaves this out, since its replay hands those values
   * back to the agent.
   */
  read?: boolean;
}

/** Copies `runId` from `src` into `dst` with `rules` applied. The copy keeps the run id. */
export function redactRun(src: Store, runId: string, rules: Normalizer[], dst: Store, options: RedactRunOptions = {}): RunRecord {
  const run = src.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const calls = src.getCalls(runId);
  // The divergence report names the call the run forked at: a captured HTTP call's name is masked as the call's is.
  const forkedAt = run.divergence && calls.find((c) => c.callNo === run.divergence!.callNo && c.name === run.divergence!.name);
  const copy: RunRecord = {
    ...run,
    parentRunId: run.parentRunId && dst.getRun(run.parentRunId) ? run.parentRunId : null,
    divergence: run.divergence ? { ...redactDivergence(run.divergence, rules), ...(forkedAt ? { name: redactedCallName(forkedAt, rules) } : {}) } : null,
    // The run page's facts in the metadata (the hosts the guard named) are masked too.
    meta: redactRunFacts(redactMeta(run.meta, rules), rules),
  };
  dst.transaction(() => {
    dst.importRun(copy);
    for (const call of calls) {
      const { end, attempts, ...start } = call;
      const name = redactedCallName(call, rules);
      dst.appendCallStart({ ...start, name, requestRef: redactRequest(src, call, rules, dst) });
      const identity = { kind: call.kind, name, fingerprint: call.fingerprint, occurrence: call.occurrence };
      const results = options.read ? call : undefined;
      const redactEnd = (e: CallEndRow): CallEndRow => ({ ...e, meta: redactCallMeta(e.meta, rules, results), responseRef: redactResponse(src, e.responseRef, rules, dst, call, options.read === true) });
      for (const a of attempts) dst.appendCallEnd(identity, redactEnd(a));
      if (end) dst.appendCallEnd(identity, redactEnd(end));
    }
  });
  return copy;
}

// ---- the run's own record ----

/**
 * A command line with the rules without a path applied to it as one text, `argv.join(' ')`, as the
 * preview counts it and `export dataset` writes it: so a rule sees what runs across arguments, the
 * lookbehind in `(?<=--api-key )\S+` included. The text is then cut back into arguments: a space
 * between two arguments that no match covered still parts them, and arguments a match runs across
 * become one. Joined, the result is the masked text, so every copy that carries the command line,
 * as one text or as its arguments, masks it alike. `observer` hears each rule's change of the text.
 */
export function redactArgv(argv: readonly string[], rules: readonly Normalizer[], observer?: RewriteObserver): string[] {
  let args = [...argv];
  rules.forEach((rule, i) => {
    if (rule.path !== undefined || rule.pattern === undefined) return;
    const text = args.join(' ');
    const regex = compilePattern(rule.pattern);
    regex.lastIndex = 0;
    const found = regex.global ? [...text.matchAll(regex)] : [regex.exec(text)].filter((m): m is RegExpExecArray => m !== null);
    if (!found.length) return;
    // Where the spaces between arguments are in the text.
    const spaces: number[] = [];
    let end = 0;
    for (const a of args.slice(0, -1)) {
      end += a.length;
      spaces.push(end);
      end += 1;
    }
    // A match's replacement as the rule writes it there: `replace` on the whole text at that place
    // alone, so a lookbehind still sees what comes before it.
    const there = new RegExp(regex.source, `${regex.flags.replace(/[gy]/g, '')}y`);
    let out = '';
    let from = 0;
    let shift = 0;
    let next = 0;
    const kept: number[] = [];
    for (const m of found) {
      const start = m.index!;
      const stop = start + m[0].length;
      there.lastIndex = start;
      const whole = text.replace(there, rule.replace);
      const replacement = whole.slice(start, whole.length - (text.length - stop));
      for (; next < spaces.length && spaces[next]! < start; next++) kept.push(spaces[next]! + shift);
      // A space inside the match is gone: the arguments on either side of it become one.
      for (; next < spaces.length && spaces[next]! < stop; next++);
      out += text.slice(from, start) + replacement;
      shift += replacement.length - (stop - start);
      from = stop;
    }
    for (; next < spaces.length; next++) kept.push(spaces[next]! + shift);
    out += text.slice(from);
    if (out === text) return;
    observer?.changed?.(i, text, out, countMatches(text, regex));
    const cut: string[] = [];
    let at = 0;
    for (const k of kept) {
      cut.push(out.slice(at, k));
      at = k + 1;
    }
    cut.push(out.slice(at));
    args = cut;
  });
  return args;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A run's own record with the rules without a path applied to what a person or a command line
 * wrote in it, outside its calls: the command line (as one text, redactArgv) and its folder,
 * labels, notes, outcome checks, the file or golden it came from, its author, what blame changed,
 * and the divergence report's values and words. Ids, times and Shadowlap's own words stay as they
 * are.
 */
export function redactRunDetails(run: RunRecord, rules: Normalizer[]): RunRecord {
  if (!rules.some((r) => r.path === undefined && r.pattern !== undefined)) return run;
  const text = (value: string) => rewriteText(value, rules);
  const deep = (value: unknown): unknown => (typeof value === 'string' ? text(value) : Array.isArray(value) ? value.map(deep) : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)])) : value);
  const out: RunRecord = { ...run, command: { ...run.command, argv: redactArgv(run.command.argv, rules), cwd: text(run.command.cwd) } };
  const meta = run.meta;
  if (meta) {
    // A record imported from someone else's pack may hold anything the pack's checks let through:
    // each part is masked where it has the shape it should, its strings wherever they are otherwise.
    const m: RunMeta = { ...meta };
    if (meta.labels !== undefined) m.labels = deep(meta.labels) as string[];
    if (Array.isArray(meta.notes)) m.notes = meta.notes.map((n) => (isRecord(n) ? { ...n, text: deep(n.text) as string } : (deep(n) as RunNote)));
    if (Array.isArray(meta.checks)) m.checks = meta.checks.map((c) => (isRecord(c) ? { ...c, label: deep(c.label) as string, detail: deep(c.detail) as string | null } : (deep(c) as RunCheck)));
    if (isRecord(meta.imported) && typeof meta.imported.from === 'string') m.imported = { ...meta.imported, from: text(meta.imported.from) };
    if (isRecord(meta.test) && typeof meta.test.golden === 'string') m.test = { ...meta.test, golden: text(meta.test.golden) };
    if (typeof meta.author === 'string') m.author = text(meta.author);
    if (isRecord(meta.blame)) m.blame = { ...meta.blame, fields: deep(meta.blame.fields) as Record<string, unknown>, oracle: deep(meta.blame.oracle) as string[] };
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
 * The copy `export html` and the dashboard's download make: what `pack` copies (redactRun), with the
 * path rules on what calls got back too, and the run's own record masked as well
 * (redactRunDetails), since this copy is read, never replayed.
 */
export function redactRunWithDetails(src: Store, runId: string, rules: Normalizer[], dst: Store): RunRecord {
  return redactRun(withRunDetailsRedacted(src, rules), runId, rules, dst, { read: true });
}

// ---- the preview ----

/** One rule in a redaction preview. */
export interface RedactionRulePreview {
  /** Position in the project's rules, from 1, as `shadowlap redact ls` numbers them. */
  n: number;
  rule: Normalizer;
  /** Matches the rule would mask in a pack. A value repeated in every later request of a conversation counts once. */
  count: number;
  /** Up to two values before and after, cut to the change and a little around it. */
  samples: Array<{ before: string; after: string }>;
  /** For a rule with a path: the distinct values found at it, changed or not. Null for a rule without one. */
  reached: number | null;
  /** Why the count is 0, in words; null when it isn't. */
  note: string | null;
  /**
   * For a rule with a path: what it masks in what calls got back (a response, a tool's result, an
   * error), which only the copies that are read mask (export html, har and dataset). A pack keeps
   * those values as recorded, since its replay hands them to the agent. Apart from `count`.
   */
  returned: { count: number; samples: Array<{ before: string; after: string }> };
  /** What the rule's pattern matches that a pack leaves as it is, apart from `count`. */
  unmasked: RedactionUnmasked;
}

/** Why a value a rule leaves as it is gets no path rule. */
export type UnmaskedReason = 'replay' | 'stream' | 'whole' | 'key';

/**
 * What a rule's pattern matches that a pack carries as recorded: a number (a copy rewrites strings,
 * so a timestamp a card-number pattern matches still replays as that number), a key of a request or
 * an error (which keeps its keys; a response's keys are strings like any other there), or for a rule
 * with a path, a number at its path or what is inside an object or list there, since its pattern
 * applies to a string at its path.
 */
export interface RedactionUnmasked {
  /** Its matches there, each value once however many requests send it again, as `count` counts. */
  count: number;
  /** Up to two of those values, each where it was first found. */
  samples: UnmaskedSample[];
  /** The places a path rule would mask them at, each with its own command: `remedies` lists the first 20. */
  places: number;
  /**
   * A path rule for each place, which masks the whole value at its path, numbers included (for a
   * string inside an object at a rule's path, the rule's pattern at the string's own path), as the
   * rule and the command that adds it. A position in a list reads as [*], so the rule masks that
   * value in every message or item alike. `copies` says where it masks it: `all`, in a request, in
   * every copy; `read`, in what a call got back, only in the copies that are read (export html, har
   * and dataset), since a pack keeps what calls got back for its replay. Those for requests first.
   */
  remedies: Array<{ rule: Normalizer; command: string; copies: 'all' | 'read' }>;
  /** Rules (numbered from 1) that already mask some of them in the copies that are read: in what a call got back, which a pack keeps. */
  covered: number[];
  /**
   * Why some of them get no path rule: `replay`, a clock or random read, the run's time and
   * randomness, which a replay needs as recorded; `stream`, in an event of a streamed response,
   * where no path reaches; `whole`, the whole request or response, or a key at its top, which no
   * path names apart from all of it; `key`, under a key no path can name (one holding `]`).
   */
  reasons: UnmaskedReason[];
}

/** A value a copy carries as recorded, and where: the call, which part of it, and the path there. */
export interface UnmaskedSample {
  /** As the copy carries it: a number as recorded, a key, or a string inside an object at a path rule's path. */
  value: string;
  /** It is a key of an object, not a value. */
  key: boolean;
  callNo: number;
  kind: CallKind;
  name: string;
  /** The call's request, what it got back (a response, a tool's result, a clock or random read), or an attempt's error. */
  in: 'request' | 'response' | 'error';
  /** Its JSONPath there, as a path rule takes it: `$.result.card`, `$.messages[3].content[1].input.amount`. A key's path ends in the key. */
  path: string;
  /** In a streamed response, the event it is in, from 1, and `path` is within that event; else null. */
  event: number | null;
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
  /** What the rules with a path mask in what calls got back only in the copies that are read (each rule's `returned.count`), summed. Not part of `total`. */
  returned: number;
  /** What the rules match that a pack leaves as it is (each rule's `unmasked.count`), summed over the rules. Not part of `total`. */
  unmasked: number;
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
/** Path rules a preview lists for one rule's values left as they are, at most; `places` counts them all. */
export const REMEDIES = 20;
const REASONS: readonly UnmaskedReason[] = ['replay', 'stream', 'whole', 'key'];

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
/** A value's identity for counting it once: a short text as it is, a long one by its digest. */
const identity = (v: unknown): string => {
  const text = shownText(v);
  return text.length <= 64 ? `=${text}` : `#${createHash('sha1').update(text).digest('base64')}`;
};

/** A key as a path writes it: `.name` when it reads plainly, else `["any key"]`. */
function keySegment(key: string): string {
  return /^[A-Za-z_$][\w$-]*$/.test(key) ? `.${key}` : `["${key}"]`;
}

/** A path as a rule takes it: `$.messages[3].content`. With `general`, every position after the first reads [*]. */
export function jsonPath(path: ReadonlyArray<string | number>, general = false): string {
  return `$${path.map((s, i) => (typeof s === 'number' ? (general && i > 0 ? '[*]' : `[${s}]`) : keySegment(s))).join('')}`;
}

/** Whether a path rule's segments name `place` or a value around it. */
function leadsTo(segs: Segment[], place: ReadonlyArray<string | number>, exactly: boolean): boolean {
  if (segs.length > place.length || (exactly && segs.length !== place.length)) return false;
  return segs.every((seg, k) => {
    const at = place[k]!;
    if (seg.type === 'wild') return true;
    if (seg.type === 'key') return typeof at === 'string' && at === seg.key;
    return typeof at === 'number' && seg.index >= 0 && at === seg.index;
  });
}

/**
 * The rule (numbered from 1) that masks `place` in what `call` got back in a copy that is read: a
 * path rule with no pattern there or around it, or one with `pattern` at a string's own place. 0
 * when none does.
 */
function coveredBy(rules: readonly Normalizer[], call: CallScope, place: ReadonlyArray<string | number>, pattern: string | undefined): number {
  return (
    rules.findIndex((r) => {
      if (r.path === undefined || !reachesResultsOf(r, call)) return false;
      const segs = parsePath(r.path);
      return r.pattern === undefined ? leadsTo(segs, place, false) : pattern !== undefined && r.pattern === pattern && leadsTo(segs, place, true);
    }) + 1
  );
}

type Outcome = { fix: { rule: Normalizer; command: string; copies: 'all' | 'read' } } | { covered: number } | { reason: UnmaskedReason };

/**
 * What masks a value `rule` leaves as it is, found in `part` of `call` at `at`: a path rule at its
 * place (a key's object for a key; for a string inside an object at a rule's path, the rule's
 * pattern at the string's own place), scoped to the call's kind and, for a tool, its name (a rule
 * with a path keeps its own scope), with the same replacement; in what a call got back it masks it
 * only in the copies that are read, or a rule already does there. None in a clock or random read,
 * whose value a replay needs as recorded, in a stream's events, for the whole request or response,
 * or under a key no path can name.
 */
function outcomeFor(rule: Normalizer, rules: readonly Normalizer[], call: Pick<CallRecord, 'kind' | 'name'>, part: UnmaskedSample['in'], at: UnmaskedAt): Outcome {
  if (call.kind === 'clock' || call.kind === 'random') return { reason: 'replay' };
  if (at.event !== undefined) return { reason: 'stream' };
  const place = at.what === 'key' ? at.path.slice(0, -1) : at.path;
  if (!place.length) return { reason: 'whole' };
  if (place.some((s) => typeof s === 'string' && s.includes(']'))) return { reason: 'key' };
  const pattern = at.what === 'string' ? rule.pattern : undefined;
  const copies = part === 'request' ? 'all' : 'read';
  if (copies === 'read') {
    const n = coveredBy(rules, call, place, pattern);
    if (n) return { covered: n };
  }
  const scope = rule.path === undefined ? { kind: call.kind, ...(call.kind === 'tool' ? { name: call.name } : {}) } : { ...(rule.kind ? { kind: rule.kind } : {}), ...(rule.name ? { name: rule.name } : {}) };
  const fix: Normalizer = { ...scope, path: jsonPath(place, true), ...(pattern !== undefined ? { pattern } : {}), replace: rule.replace };
  const argv = ['shadowlap', 'redact', 'add', ...(fix.kind ? ['--kind', fix.kind] : []), ...(fix.name ? ['--name', fix.name] : []), '--path', fix.path!, ...(fix.pattern !== undefined ? ['--pattern', fix.pattern] : []), '--replace', fix.replace];
  return { fix: { rule: fix, command: quoteArgv(argv), copies } };
}

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
 * What `shadowlap pack` would mask in one run, without writing anything: the run's stored requests,
 * responses and errors, retries included, read through the very functions a pack applies the rules
 * with (redactedRequest's applyNormalizers, redactBytes, redactedError), which report each change
 * they make; so the count per rule, and its two samples, are what the pack changes. A response that
 * is one JSON document has its strings masked and its numbers kept, and is counted so. The local
 * store is never modified. A run still recording is refused: its calls are still arriving, so the
 * count would be out of date before it was read (a run its process abandoned is not recording).
 *
 * A rule with a path that reaches what calls got back is read again there as the copies that are
 * read apply it (export html, har and dataset), and what it masks there is its `returned`, apart
 * from the count: a pack keeps those values.
 *
 * Apart from the count, each rule's `unmasked`: what its pattern matches that a pack leaves as it is
 * (a number; a key of a request or an error; for a rule with a path, a number at its path or what an
 * object there holds), each value once, with where it was found and, for each place, the path rule
 * that would mask it, a rule that already does in the copies that are read, or why there is none.
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
  const per = rules.map(() => ({
    count: 0,
    scoped: 0,
    seen: new Set<string>(),
    samples: [] as Array<{ before: string; after: string }>,
    // Distinct values found at a path rule's path, in requests and in what calls got back.
    reached: { seen: new Set<string>(), requests: 0, results: 0 },
    returned: { count: 0, seen: new Set<string>(), samples: [] as Array<{ before: string; after: string }> },
    unmasked: {
      count: 0,
      numbers: 0,
      keys: 0,
      strings: 0,
      seen: new Set<string>(),
      samples: [] as UnmaskedSample[],
      // Each place found, by where it is, and what masks it there.
      outcomes: new Map<string, Outcome>(),
      fixes: new Map<string, { rule: Normalizer; command: string; copies: 'all' | 'read' }>(),
      covered: new Set<number>(),
      reasons: new Set<UnmaskedReason>(),
    },
  }));
  // The call the rules are reading, and which part of it: where a value they leave is found.
  let here: { call: CallRecord; in: UnmaskedSample['in'] } | null = null;
  const reachedAt = (i: number, value: unknown) => {
    const r = per[i]!.reached;
    const key = digest(value);
    if (r.seen.has(key)) return;
    r.seen.add(key);
    if (here?.in === 'request') r.requests++;
    else r.results++;
  };
  const observer: RewriteObserver = {
    reached: reachedAt,
    changed(i, before, after, count) {
      const r = per[i]!;
      // A conversation sends its earlier messages again with every request: count each value once.
      const key = identity(before);
      if (r.seen.has(key)) return;
      r.seen.add(key);
      r.count += count;
      if (r.samples.length < SAMPLES) r.samples.push(clipChange(shownText(before), shownText(after)));
    },
    unmasked(i, text, at, count) {
      if (!here) return;
      const u = per[i]!.unmasked;
      // What masks it, for each place, though the value was found before at another.
      const where = `${here.call.kind}\u0000${here.call.kind === 'tool' ? here.call.name : ''}\u0000${here.in}\u0000${at.what}\u0000${at.event === undefined ? '' : 'e'}\u0000${at.path.map((s, k) => (typeof s === 'number' && k > 0 ? '*' : typeof s === 'number' ? `#${s}` : `.${s}`)).join('\u0001')}`;
      let outcome = u.outcomes.get(where);
      if (!outcome) {
        outcome = outcomeFor(rules[i]!, rules, here.call, here.in, at);
        u.outcomes.set(where, outcome);
        if ('fix' in outcome) {
          if (!u.fixes.has(outcome.fix.command)) u.fixes.set(outcome.fix.command, outcome.fix);
        } else if ('covered' in outcome) u.covered.add(outcome.covered);
        else u.reasons.add(outcome.reason);
      }
      // Each value once, as `count` counts them; a key and a value apart.
      const key = `${at.what === 'key' ? 'k' : 'v'}${identity(text)}`;
      if (u.seen.has(key)) return;
      u.seen.add(key);
      u.count += count;
      if (at.what === 'key') u.keys++;
      else if (at.what === 'string') u.strings++;
      else u.numbers++;
      if (u.samples.length < SAMPLES) u.samples.push({ value: text.length > SAMPLE_MAX ? `${text.slice(0, SAMPLE_MAX - 1)}…` : text, key: at.what === 'key', callNo: here.call.callNo, kind: here.call.kind, name: here.call.name, in: here.in, path: jsonPath(at.path), event: at.event ?? null });
    },
  };
  // What calls got back, read again as the copies that are read apply the path rules there: what
  // they mask there, and what their pattern leaves at their path.
  const reading: RewriteObserver = {
    reached(i, value) {
      if (rules[i]!.path !== undefined) reachedAt(i, value);
    },
    unmasked(i, text, at, count) {
      if (rules[i]!.path !== undefined) observer.unmasked!(i, text, at, count);
    },
    changed(i, before, after, count) {
      if (rules[i]!.path === undefined) return;
      const r = per[i]!.returned;
      const key = identity(before);
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
    // A path rule that reaches what this call got back, in the copies that are read.
    const reaches = rules.some((r) => r.path !== undefined && reachesResultsOf(r, call));
    try {
      // What redactRun copies, read through the functions it copies with: a captured HTTP call's
      // name, the request, then each attempt's response and error.
      here = { call, in: 'request' };
      redactedCallName(call, rules, observer);
      if (call.requestRef) {
        const request = call.kind === 'api' && skipSeen ? unseenParts(reader, call, seen) : storedRequest(reader, call);
        applyNormalizers(request, rules, call.kind, call.name, observer);
      }
      for (const end of [...call.attempts, ...(call.end ? [call.end] : [])]) {
        const response = end.responseRef ? counting.getBlob(end.responseRef) : null;
        here = { call, in: 'response' };
        if (response && keptAsRecorded(call)) reportKept(response, rules, observer);
        else if (response) {
          redactBytes(response, rules, undefined, observer);
          if (reaches) redactBytes(response, rules, call, reading);
        }
        here = { call, in: 'error' };
        if (end.meta.error) {
          redactedError(end.meta.error, rules, observer);
          if (reaches) redactedError(end.meta.error, rules, reading, call);
        }
      }
    } catch {
      unreadable++;
    } finally {
      here = null;
    }
  }
  const previews = rules.map((rule, i): RedactionRulePreview => {
    const r = per[i]!;
    const fixes = [...r.unmasked.fixes.values()];
    const unmasked: RedactionUnmasked = {
      count: r.unmasked.count,
      samples: r.unmasked.samples,
      places: fixes.length,
      // Those for requests, which mask the value in every copy, first.
      remedies: [...fixes.filter((f) => f.copies === 'all'), ...fixes.filter((f) => f.copies === 'read')].slice(0, REMEDIES),
      covered: [...r.unmasked.covered].sort((a, b) => a - b),
      reasons: REASONS.filter((x) => r.unmasked.reasons.has(x)),
    };
    const returned = { count: r.returned.count, samples: r.returned.samples };
    return { n: i + 1, rule, count: r.count, samples: r.samples, reached: rule.path === undefined ? null : r.reached.requests + r.reached.results, note: r.count ? null : zeroNote(rule, r.scoped, r.reached, r.unmasked, returned.count), returned, unmasked };
  });
  // The run's details, as the exports that carry them mask them (redactRunDetails): the command line as one text (redactArgv), each label and each note.
  const details: RedactionPreview['details'] = { count: 0, samples: [], rules: [] };
  const detailObserver: RewriteObserver = {
    changed(i, before, after, count) {
      details.count += count;
      if (!details.rules.includes(i + 1)) details.rules.push(i + 1);
      if (details.samples.length < SAMPLES) details.samples.push(clipChange(shownText(before), shownText(after)));
    },
  };
  redactArgv(run.command.argv, rules, detailObserver);
  for (const text of [...(run.meta?.labels ?? []), ...(run.meta?.notes ?? []).map((n) => n.text)]) rewriteText(text, rules, detailObserver);
  details.rules.sort((a, b) => a - b);
  return {
    runId,
    calls: read - unreadable,
    unreadable,
    partial: stopped ? { read, of: all.length, stopped } : null,
    total: previews.reduce((s, p) => s + p.count, 0),
    returned: previews.reduce((s, p) => s + p.returned.count, 0),
    unmasked: previews.reduce((s, p) => s + p.unmasked.count, 0),
    rules: previews,
    details,
  };
}

/**
 * What a rule without a path matched that a copy leaves, in words: `a number here, which a copy
 * leaves as it is`, `numbers and keys here, which …`. Such a rule leaves a string only in a clock or
 * random read (reportKept).
 */
function leftWords(u: { numbers: number; keys: number; strings: number }): string {
  const parts = [u.numbers ? (u.numbers === 1 ? 'a number' : 'numbers') : '', u.keys ? (u.keys === 1 ? 'a key' : 'keys') : '', u.strings ? 'what a clock or random read returned' : ''].filter(Boolean);
  return `${parts.join(' and ') || 'values'} here, which a copy leaves as ${u.numbers + u.keys + u.strings === 1 ? 'it is' : 'they are'}`;
}

/**
 * What the rules without a path match in a clock or random read, which every copy keeps as recorded
 * (keptAsRecorded), told to the observer as left as it is: each string, number and key of the JSON
 * stored for it, or its text when it isn't JSON. A rule with a path never reaches one.
 */
function reportKept(bytes: Buffer, rules: Normalizer[], observer: RewriteObserver): void {
  const report = observer.unmasked;
  const text = asText(bytes);
  if (!report || text === null) return;
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Its text as a whole.
  }
  rules.forEach((rule, i) => {
    if (rule.path !== undefined || rule.pattern === undefined) return;
    const regex = compilePattern(rule.pattern);
    const test = (found: string, path: Array<string | number>, what: UnmaskedAt['what']) => {
      const count = countMatches(found, regex);
      if (count) report(i, found, { path: [...path], what }, count);
    };
    const walk = (v: unknown, path: Array<string | number>) => {
      if (typeof v === 'string') test(v, path, 'string');
      else if (typeof v === 'number') test(JSON.stringify(v), path, 'number');
      else if (Array.isArray(v)) v.forEach((item, k) => walk(item, [...path, k]));
      else if (isObject(v))
        for (const [k, item] of Object.entries(v)) {
          test(k, [...path, k], 'key');
          walk(item, [...path, k]);
        }
    };
    walk(value, []);
  });
}

/**
 * Where a path rule looks, in words: a tool's arguments are its request (`$.args…`) and its result
 * or error what it got back (`$.result…`, `$.error…`); any other path that starts with a key reaches
 * both a request and a response, and `$` or a wildcard first only a request.
 */
function lookedIn(rule: Normalizer): string {
  const first = rule.path === undefined ? undefined : parsePath(rule.path)[0];
  if (!first || first.type === 'wild') return 'request';
  if (first.type === 'key' && first.key === 'args') return 'request';
  if (first.type === 'key' && (first.key === 'result' || first.key === 'error')) return 'result';
  return 'request or response';
}

function zeroNote(rule: Normalizer, scoped: number, reached: { requests: number; results: number }, unmasked: { count: number; numbers: number; keys: number; strings: number }, returned: number): string {
  if (rule.path === undefined && rule.pattern === undefined) return 'it has neither a path nor a pattern, so it changes nothing';
  // A response is matched by every rule without a path, whatever its scope, so a scope only rules out requests.
  if (rule.path === undefined) return unmasked.count ? `it matches only ${leftWords(unmasked)}` : 'no matches in this run';
  if (scoped === 0) return `no ${rule.kind ? `${rule.kind} call` : 'call'}${rule.name ? ` named ${rule.name}` : ''} in this run`;
  if (returned) return 'a pack keeps what calls got back, since its replay hands it to the agent';
  const found = reached.requests + reached.results;
  if (found === 0) return `no ${lookedIn(rule)} in this run has ${rule.path}`;
  if (rule.pattern === undefined) return `${rule.path} already reads ${rule.replace}`;
  if (unmasked.count) return `what ${rule.pattern} matches at ${rule.path} here is in a number or inside an object, which it leaves as it is: it masks a string at its path`;
  const where = reached.results === 0 ? (found === 1 ? 'a request' : `${found} requests`) : reached.requests === 0 ? (found === 1 ? 'a response' : `${found} responses`) : `${found} requests and responses`;
  return `${rule.path} is in ${where}, but nothing there matches ${rule.pattern}`;
}

// ---- where the rules apply ----

/** An export a run can leave the machine by, and which redaction rules it applies (decision 6). */
export interface RedactionExport {
  id: 'pack' | 'html' | 'har' | 'dataset' | 'pairs' | 'otel';
  command: string;
  /**
   * `all`: every rule, on every request and response it copies and the errors with them (a pack
   * keeps what calls got back as recorded but for its strings: redactRun). `messages`: the rules on
   * the conversations and answers it keeps (path rules on the message fields there), then the rules
   * without a path on every string it writes.
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
  { id: 'pack', command: 'shadowlap pack', applies: 'all', details: 'kept', note: 'every rule on the requests it copies, and the rules without a path on the strings of what calls got back and the errors with them, which a replay hands the agent as recorded otherwise; the command line, labels and notes are copied as recorded, since a replay runs the command' },
  { id: 'html', command: 'shadowlap export html', applies: 'all', details: 'masked', note: 'every rule, as pack applies them, the rules with a path on what calls got back too, and the rules without a path on the command line, labels and notes' },
  { id: 'har', command: 'shadowlap export har', applies: 'all', details: 'absent', note: 'every rule on the model calls it holds, as export html applies them to their requests and responses, and the rules without a path on URLs and headers; it holds no tool calls and no command line' },
  { id: 'dataset', command: 'shadowlap export dataset', applies: 'messages', details: 'masked', note: 'every rule on the conversations and answers it keeps, as export html applies them, and the rules without a path on the rest of each row: command line, labels and notes' },
  { id: 'pairs', command: 'shadowlap export pairs', applies: 'messages', details: 'absent', note: 'the rules on the conversations and answers it keeps: path rules on the request and on tool arguments and results, and the rules without a path on every string' },
  { id: 'otel', command: 'shadowlap export otel', applies: 'attributes', details: 'masked', note: 'no prompt text leaves; the rules without a path on the names, command line and errors it keeps' },
];
