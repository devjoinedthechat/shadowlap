import { dropBound } from '@shadowlap/engine';

/**
 * What a verdict's JSON may say beyond its tally, read for the Fixes pages when it says it: a gate's
 * bound with the method that computed it and the attempts the provider left unavailable (never
 * tallied), verify's baseline for a run, the margin it was kept within and the bound on its drop
 * from the baseline, and blame's range of calls and the error bound its confidence comes from.
 * Reports made before these fields carry none, and a report from a pack or the team store can carry
 * anything: each reader takes only a well-formed value, and says nothing otherwise.
 */

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const count = (v: unknown): number | null => (finite(v) && Number.isInteger(v) && v >= 0 ? v : null);

/** A gate's result as the pages read it: how its bound was computed, and the attempts not tallied because the provider was unavailable. */
export interface GateEvidence {
  /** `bound.method`, in words: `exact under the gate's stopping rule`, `Clopper–Pearson`. Null when the result names none. */
  method: string | null;
  /** Attempts the provider couldn't answer (429, 5xx, a network error), retried and never tallied. */
  unavailable: number;
}

/** Verify's per-run evidence: its gate's, and the baseline it was kept against, with the margin. */
export interface VerifyEvidence extends GateEvidence {
  /** The run's own baseline: a paired arm at the base revision, or the golden's history. */
  baseline: { passes: number; attempts: number; source: 'paired' | 'history'; revision: string | null } | null;
  /** How much worse than its baseline a kept run may be, as a share: 0.1 is ten points. */
  margin: number | null;
  /**
   * The bound on the drop from its baseline that bears on its verdict, in the words the CLI and a
   * fix's PR say it: `drop <= 0.10 (95%)` for a run kept, `drop >= 0.12 (95%)` for one broken.
   */
  drop: string | null;
}

/** Blame's evidence: the calls it lost the run between, when no one call is pinned, and the error bound of its confidence. */
export interface BlameEvidence {
  /** `gradual` when the check of the call the probes pinned found no drop there: lost gradually around the two. */
  range: { from: number; to: number; gradual?: true } | null;
  errorBound: number | null;
}

/** A bound's method in words. */
export function methodWords(method: string): string {
  if (/clopper|pearson/i.test(method)) return 'Clopper–Pearson';
  if (/stagewise|sprt|sequential|stopping/i.test(method)) return 'exact under the gate’s stopping rule';
  if (/wilson/i.test(method)) return 'Wilson';
  if (/anytime|confidence.?sequence|e-?process/i.test(method)) return 'anytime-valid';
  return method.replace(/[-_]+/g, ' ').trim();
}

/** A gated result's evidence: from the result itself, else from the gate's result it carries. */
export function gateEvidence(x: unknown): GateEvidence {
  const r = record(x);
  const gate = record(r?.gate);
  const bound = record(r?.bound) ?? record(gate?.bound);
  const method = typeof bound?.method === 'string' && bound.method.trim() ? methodWords(bound.method.trim().slice(0, 80)) : null;
  return { method, unavailable: count(r?.unavailable) ?? count(gate?.unavailable) ?? 0 };
}

export function verifyEvidence(x: unknown): VerifyEvidence {
  const r = record(x);
  const b = record(r?.baseline);
  const passes = count(b?.passes);
  const attempts = count(b?.attempts);
  const source: 'paired' | 'history' | null = b?.source === 'paired' ? 'paired' : b?.source === 'history' ? 'history' : null;
  const baseline = passes !== null && attempts !== null && passes <= attempts && source ? { passes, attempts, source, revision: typeof b?.revision === 'string' && /^[\w.+-]{1,64}$/.test(b.revision) ? b.revision : null } : null;
  const margin = finite(r?.margin) && r.margin >= 0 && r.margin <= 1 ? r.margin : null;
  return { ...gateEvidence(x), baseline, margin, drop: baseline ? dropWords(r?.drop, r?.decision) : null };
}

/** A drop bound as verify keeps it, `{ lo, hi, confidence, method }`, in words; null for anything else. */
function dropWords(v: unknown, decision: unknown): string | null {
  const d = record(v);
  const end = (x: unknown) => (x === null || x === undefined ? null : finite(x) && x >= -1 && x <= 1 ? x : undefined);
  const lo = end(d?.lo);
  const hi = end(d?.hi);
  const confidence = d?.confidence;
  if (!d || lo === undefined || hi === undefined || !finite(confidence) || confidence <= 0 || confidence >= 1) return null;
  const method = d.method === 'history' ? 'history' : 'betting';
  const decided = decision === 'pass' || decision === 'fail' || decision === 'kept' || decision === 'broken' || decision === 'inconclusive' || decision === 'continue' ? decision : null;
  return dropBound({ lo, hi, confidence, method }, decided);
}

export function blameEvidence(x: unknown): BlameEvidence {
  const r = record(x);
  const g = record(r?.range);
  const from = count(g?.from);
  const to = count(g?.to);
  const range = from !== null && to !== null && from >= 1 && to >= from ? { from, to, ...(g?.gradual === true ? { gradual: true as const } : {}) } : null;
  const errorBound = finite(r?.errorBound) && r.errorBound >= 0 && r.errorBound <= 1 ? r.errorBound : null;
  return { range, errorBound };
}
