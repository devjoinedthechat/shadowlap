import { loadApiRequest, storeApiRequest } from './manifest.js';
import { applyNormalizers, parsePath, rewriteText } from './normalize.js';
import { redactRunFacts } from './run-facts.js';
import type { Store } from './store.js';
import type { CallEndRow, CallRecord, DivergenceReport, Normalizer, RunRecord } from './types.js';

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
  const text = bytes.toString('utf8');
  // Only rewrite what round-trips as text; binary responses stay as they are.
  if (Buffer.from(text, 'utf8').equals(bytes)) return dst.putBlob(Buffer.from(rewriteText(text, rules), 'utf8'));
  return dst.putBlob(bytes);
}

/**
 * A divergence keeps the request values that differed (`diff[].before`/`after`): a fork's
 * overridden result or injected instruction is among them. Each value gets the rules the request
 * it came from got, placed at its path so that path rules apply as well as patterns.
 */
function redactDivergence(d: DivergenceReport | null, rules: Normalizer[]): DivergenceReport | null {
  if (!d) return d;
  const value = (path: string, v: unknown): unknown => {
    let segs: ReturnType<typeof parsePath> | null;
    try {
      segs = parsePath(path);
    } catch {
      segs = null;
    }
    // Rebuild the request around the value, redact it as a request, and take the value back out.
    let root: unknown = v;
    for (const seg of [...(segs ?? [])].reverse()) {
      if (seg.type === 'key') root = { [seg.key]: root };
      else if (seg.type === 'index' && seg.index >= 0) {
        const list: unknown[] = new Array(seg.index + 1);
        list[seg.index] = root;
        root = list;
      } else segs = null;
    }
    if (!segs) return applyNormalizers(v, rules.filter((r) => r.path === undefined), d.kind, d.name);
    let out = applyNormalizers(root, rules, d.kind, d.name);
    for (const seg of segs) out = (out as Record<string | number, unknown> | undefined)?.[seg.type === 'key' ? seg.key : (seg as { index: number }).index];
    return out;
  };
  return {
    ...d,
    ...(d.diff ? { diff: d.diff.map((e) => ({ ...e, ...('before' in e ? { before: value(e.path, e.before) } : {}), ...('after' in e ? { after: value(e.path, e.after) } : {}) })) } : {}),
    ...(typeof d.reason === 'string' ? { reason: rewriteText(d.reason, rules) } : {}),
  };
}

/** Copies `runId` from `src` into `dst` with `rules` applied. The copy keeps the run id. */
export function redactRun(src: Store, runId: string, rules: Normalizer[], dst: Store): RunRecord {
  const run = src.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const existing = run.meta?.redactions ?? [];
  // The run page's facts in the metadata (a fork's flags, the hosts the guard named) are masked too.
  const copy: RunRecord = { ...run, parentRunId: run.parentRunId && dst.getRun(run.parentRunId) ? run.parentRunId : null, divergence: redactDivergence(run.divergence, rules), meta: redactRunFacts({ ...run.meta, redactions: [...existing, ...rules] }, rules) };
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
