import { encodeEventStreamFrame, eventStreamFrames, type EventStreamFrame } from './eventstream.js';
import { loadApiRequest, storeApiRequest } from './manifest.js';
import { applyNormalizers, parsePath, rewriteText } from './normalize.js';
import { maskJsonChunks, maskSseStream, maskStreamed } from './redact-stream.js';
import { redactRunFacts } from './run-facts.js';
import type { Store } from './store.js';
import type { CallEndRow, CallKind, CallMeta, CallRecord, DiffEntry, DivergenceReport, Normalizer, RunMeta, RunRecord } from './types.js';

/**
 * Redaction: a copy of a run whose stored requests and responses have the rules applied.
 * Path-scoped rules apply to requests (they are JSON); pathless pattern rules apply to every
 * string of a request and to the raw text of a response. The copy records the rules in its run
 * metadata so a replay applies them as normalizers and still matches (a rule must therefore be
 * idempotent: its replacement must not match its own pattern).
 *
 * What the run record itself repeats of that content is masked too: the flags that made a fork
 * (an `--override` carries a whole tool result), the divergence report's diff and reason, the
 * checks' details, and each call's error, injected failure and response headers.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function redactRequest(src: Store, call: CallRecord, rules: Normalizer[], dst: Store): string | null {
  if (!call.requestRef) return null;
  if (call.kind === 'api') {
    const body = loadApiRequest(src, call.requestRef);
    return storeApiRequest(dst, applyNormalizers(body, rules, 'api', call.name));
  }
  const req = src.getJson(call.requestRef);
  return dst.putJson(applyNormalizers(req, rules, call.kind, call.name));
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
  return Buffer.from(rewriteText(streamed, rules), 'utf8');
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
 * the `--expect` it was judged by goes too. Checks keep their verdicts, with their details masked.
 */
function redactMeta(meta: RunMeta | undefined, rules: Normalizer[]): RunMeta {
  const { expect: _expect, ...rest } = meta ?? {};
  const out: RunMeta = { ...rest, redactions: [...(meta?.redactions ?? []), ...rules] };
  if (meta?.interventions) out.interventions = meta.interventions.map(({ args: _args, ...i }) => ({ ...i, flag: rewriteText(i.flag, rules) }));
  if (meta?.checks) out.checks = meta.checks.map((c) => ({ ...c, label: rewriteText(c.label, rules), detail: c.detail === null ? null : rewriteText(c.detail, rules) }));
  return out;
}

/** A call's metadata with what it repeats of the content masked: its error, an injected failure's message, the response headers. */
function redactCallMeta(meta: CallMeta, rules: Normalizer[]): CallMeta {
  const out: CallMeta = { ...meta };
  if (meta.error) out.error = { ...meta.error, message: rewriteText(meta.error.message, rules), ...(meta.error.data !== undefined ? { data: rewriteDeep(meta.error.data, rules) } : {}) };
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
