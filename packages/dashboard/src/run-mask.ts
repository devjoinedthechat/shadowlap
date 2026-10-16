import type { Normalizer, Store } from '@shadowlap/engine';
import { PREVIEW_LIMITS, previewApart, previewHere, type PreviewLimitsConfig } from './redaction-preview.js';

/**
 * What a copy of a run made now would mask, for its Provenance: the Redaction tab's preview of the
 * run (`shadowlap redact preview`), so both screens give the same number, each value counted once
 * however many later requests of a conversation send it again. Like that preview, it is read on a
 * thread of its own against the store file, within the preview's limits, so a rule that takes
 * minutes on the run's text never holds up the dashboard server; a store with no file (in memory)
 * is read here.
 */

export interface MaskCount {
  /** The redaction rules a copy made now applies. */
  rules: number;
  /** The values they would mask in the run; null when not counted. */
  values: number | null;
  /** Why they were not counted: a rule took too long, or the run was read only in part. */
  why?: string;
}

export async function maskCount(o: { store: Store; dbPath?: string | null; runId: string; rules: Normalizer[]; limits?: PreviewLimitsConfig }): Promise<MaskCount> {
  const { rules } = o;
  if (!rules.length) return { rules: 0, values: 0 };
  // A run still recording has nothing a copy would hold yet: it is copied once it has ended.
  if (o.store.recordingRuns().live.some((r) => r.run.runId === o.runId)) return { rules: rules.length, values: null };
  const limits = o.limits ?? PREVIEW_LIMITS;
  try {
    const preview = o.dbPath && o.dbPath !== ':memory:' ? await previewApart({ dbPath: o.dbPath, runId: o.runId, rules }, { limits }) : previewHere(o.store, o.runId, rules, limits);
    if (preview.partial) return { rules: rules.length, values: null, why: `the run is long: ${preview.partial.read.toLocaleString('en-US')} of its ${preview.partial.of.toLocaleString('en-US')} calls were read before the preview's limit` };
    return { rules: rules.length, values: preview.total };
  } catch (err) {
    return { rules: rules.length, values: null, why: err instanceof Error ? err.message : String(err) };
  }
}
