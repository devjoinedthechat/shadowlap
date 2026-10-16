import type { Normalizer, RedactionPreview, RunRecord, Store } from '@shadowlap/engine';
import { PREVIEW_LIMITS, PreviewError, previewApart, previewHere, type PreviewLimitsConfig } from './redaction-preview.js';
import { recordingNow } from './run-exports.js';

/**
 * What a copy of a run made now would mask, for its Provenance: the Redaction tab's preview of the
 * run (`shadowlap redact preview`), so both screens give the same number, each value counted once
 * however many later requests of a conversation send it again. Like that preview, it is read on a
 * thread of its own against the store file, within the preview's limits, so a rule that takes
 * minutes on the run's text never holds up the dashboard server; a store with no file (in memory)
 * is read here.
 *
 * Counts take one preview thread at a time, in the order they were asked (two tabs open, the runs of
 * a batch looked at one after another), and leave the other to the Redaction tab. While that tab's
 * previews hold every thread, a count waits for one; past `MASK_WAIT` it says it is still to come
 * (`busy`), and the page asks again.
 */

export interface MaskCount {
  /** The redaction rules a copy made now applies. */
  rules: number;
  /** The values they would mask in the run; null when not counted. */
  values: number | null;
  /** When counted, what a path rule masks in what calls got back, which only a copy that is read masks (the preview's `returned`), when there is any. */
  returned?: number;
  /** When counted, what else they match that a pack leaves as it is (numbers a pattern never rewrites: the preview's `unmasked`), when there is any. */
  unmasked?: number;
  /** Why they were not counted: a rule took too long, or the run was read only in part. */
  why?: string;
  /** Not counted yet: the preview threads, or the store, were busy. Asked again in a moment, it is. */
  busy?: true;
}

/** How long a count waits for a preview thread, and how often it asks for one meanwhile. Tests lower it. */
export const MASK_WAIT = { totalMs: 20_000, everyMs: 250 };

/** What previewApart says when every thread is reading another preview. */
const THREADS_BUSY = /^Other previews are still being read/;

/** Why a count is still to come. */
export const MASK_BUSY = 'The redaction previews are busy: Settings → Redaction is reading one, or another command holds the store. It is counted again in a moment.';

/** The count asked last: the next waits for it. */
let queue: Promise<unknown> = Promise.resolve();

export async function maskCount(o: { store: Store; dbPath?: string | null; run: Pick<RunRecord, 'runId' | 'status'>; rules: Normalizer[]; limits?: PreviewLimitsConfig }): Promise<MaskCount> {
  const { rules, run } = o;
  if (!rules.length) return { rules: 0, values: 0 };
  // A run still recording has nothing a copy would hold yet: it is copied once it has ended.
  if (recordingNow(o.store, run)) return { rules: rules.length, values: null };
  const limits = o.limits ?? PREVIEW_LIMITS;
  if (!o.dbPath || o.dbPath === ':memory:') {
    try {
      return fromPreview(rules, previewHere(o.store, run.runId, rules, limits));
    } catch (err) {
      return { rules: rules.length, values: null, why: message(err) };
    }
  }
  const turn = queue.then(() => apart(o.dbPath!, run.runId, rules, limits));
  queue = turn.catch(() => undefined);
  return turn;
}

/** The count on a preview thread, waiting a while for one when the Redaction tab's previews hold them all. */
async function apart(dbPath: string, runId: string, rules: Normalizer[], limits: PreviewLimitsConfig): Promise<MaskCount> {
  const until = Date.now() + MASK_WAIT.totalMs;
  for (;;) {
    try {
      return fromPreview(rules, await previewApart({ dbPath, runId, rules }, { limits }));
    } catch (err) {
      if (!(err instanceof PreviewError) || err.status !== 503) return { rules: rules.length, values: null, why: message(err) };
      if (!THREADS_BUSY.test(err.message) || Date.now() + MASK_WAIT.everyMs >= until) return { rules: rules.length, values: null, why: MASK_BUSY, busy: true };
      await new Promise((r) => setTimeout(r, MASK_WAIT.everyMs));
    }
  }
}

function fromPreview(rules: Normalizer[], preview: RedactionPreview): MaskCount {
  if (preview.partial) return { rules: rules.length, values: null, why: `the run is long: ${preview.partial.read.toLocaleString('en-US')} of its ${preview.partial.of.toLocaleString('en-US')} calls were read before the preview's limit` };
  return { rules: rules.length, values: preview.total, ...(preview.returned ? { returned: preview.returned } : {}), ...(preview.unmasked ? { unmasked: preview.unmasked } : {}) };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
