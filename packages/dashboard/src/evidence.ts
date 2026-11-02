import { confidenceWhy, dropBound, isObject, probeClaim, type BlameProbe, type BlameReport, type PinCheck } from '@shadowlap/engine';

/**
 * What a verdict's JSON may say beyond its tally, read for the Fixes pages when it says it: a gate's
 * bound with the method that computed it and the attempts the provider left unavailable (never
 * tallied), verify's baseline for a run, the margin it was kept within and the bound on its drop
 * from the baseline, and blame's range of calls and the error bound its confidence comes from.
 * Reports made before these fields carry none, and a report from a pack or the team store can carry
 * anything: each reader takes only a well-formed value, and says nothing otherwise.
 */

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const record = (v: unknown): Record<string, unknown> | null => (isObject(v) ? v : null);
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
  /**
   * The error bound as the CLI prints it after the blame's confidence, with what it rests on (the
   * engine's confidenceWhy): `<= 3% risk that the call is wrong: 3 probes decided, at <= 1.3% risk
   * each`. Null with no bound, where the CLI prints no confidence line, or for a report whose probes
   * don't say what bounds it.
   */
  risk: string | null;
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
  return { range, errorBound, risk: r && errorBound !== null ? riskWords(r, errorBound, range) : null };
}

/** A share, as a risk is one: from 0 to 1. */
const share = (v: unknown): boolean => finite(v) && v >= 0 && v <= 1;

/** A blame's probes as confidenceWhy reads them: each that decided something carries its risk. */
const decidedProbes = (v: unknown): v is BlameProbe[] => Array.isArray(v) && v.every((p) => isObject(p) && (probeClaim(p as Parameters<typeof probeClaim>[0]) === null || share(p.risk)));

/** Where rescue rose again past the boundary, each by its two calls. */
const rises = (v: unknown): v is BlameReport['nonMonotone'] => Array.isArray(v) && v.every((m) => isObject(m) && count(m.lost) !== null && count(m.rescued) !== null);

/** The check of the pinned call: none, one that couldn't decide, or one that did, with its call and its risk. */
const pinCheck = (v: unknown): v is PinCheck | null => v === null || (isObject(v) && (v.verdict === 'inconclusive' || (count(v.callNo) !== null && share(v.risk))));

/**
 * A blame's error bound in the CLI's words (confidenceWhy), from what of the report they read, each
 * of its shape: every probe that decided something carries its risk, each rise past the boundary
 * names its two calls, and a check of the pinned call that decided carries its call and risk. Null
 * when any doesn't, so a report from elsewhere never prints a bound it doesn't hold. Null too where
 * `shadowlap blame` prints no confidence line (formatBlame): a blame whose passing attempts answered
 * the call as the recording did (`sameAnswer`) keeps the search's bound, which is not one on the
 * claim it makes, that no call rescues the run.
 */
function riskWords(r: Record<string, unknown>, errorBound: number, range: BlameEvidence['range']): string | null {
  const { outcome, probes } = r;
  const nonMonotone = r.nonMonotone ?? [];
  const pin = r.pin ?? null;
  if (r.sameAnswer) return null;
  if ((outcome !== 'blamed' && outcome !== 'unrescuable') || !decidedProbes(probes) || !rises(nonMonotone) || !pinCheck(pin)) return null;
  return confidenceWhy({ outcome, probes, nonMonotone, errorBound, range, pin });
}
