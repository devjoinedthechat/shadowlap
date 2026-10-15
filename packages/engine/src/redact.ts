import { loadApiRequest, storeApiRequest } from './manifest.js';
import { applyNormalizers, rewriteText } from './normalize.js';
import type { Store } from './store.js';
import type { CallEndRow, CallRecord, Normalizer, RunRecord } from './types.js';

/**
 * Redaction: a copy of a run whose stored requests and responses have the rules applied.
 * Path-scoped rules apply to requests (they are JSON); pathless pattern rules apply to every
 * string of a request and to the raw text of a response. The copy records the rules in its run
 * metadata so a replay applies them as normalizers and still matches (a rule must therefore be
 * idempotent: its replacement must not match its own pattern).
 */

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

/**
 * A stored response, or any bytes, with every pathless rule applied to its text. Only what
 * round-trips as text is rewritten; binary bytes stay as they are.
 */
export function redactBytes(bytes: Buffer, rules: Normalizer[]): Buffer {
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(bytes)) return Buffer.from(rewriteText(text, rules), 'utf8');
  return bytes;
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
