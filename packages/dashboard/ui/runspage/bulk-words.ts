import { num, plural, shortId } from '../format.js';
import type { BulkSkip } from '../types.js';

/**
 * The runs an action took, in its toast: Runs' bulk bar's and Delete run's in the header's …
 * (run/delete-run.ts, loaded with that menu). Apart from Add label…'s suggestions (run-words.ts),
 * which a run's page draws, so the page loads none of it. No DOM here: the tests import it.
 */

export const named = (ids: readonly string[]) => (ids.length === 1 ? shortId(ids[0]!) : `${num(ids.length)} runs`);

/**
 * "Deleted 3 runs and 6 attempts", "Labelled 2 of 3 runs “good” · 01K5CQ6L0P was left alone: no such
 * run": the runs it acted on, the attempts bundled under them that went too, and which it left alone.
 */
export function bulkToast(o: { verb: string; done: readonly string[]; of: number; skipped: readonly BulkSkip[]; suffix?: string; attempts?: number }): string {
  const what = o.done.length === o.of ? named(o.done) : `${num(o.done.length)} of ${num(o.of)} runs`;
  const attempts = o.attempts ? ` and ${plural(o.attempts, 'attempt')}` : '';
  const why = o.skipped.slice(0, 2).map((s) => `${shortId(s.runId)} ${s.reason === 'still recording' ? 'is still recording' : `was left alone: ${s.reason}`}`);
  return [`${o.verb} ${what}${attempts}${o.suffix ?? ''}`, ...why].join(' · ');
}
