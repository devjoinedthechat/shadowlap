import { num, shortId } from '../format.js';
import type { BulkSkip } from '../types.js';

/** What the bulk bar says once it has acted on the runs picked. No DOM here: the tests import it. */

export const named = (ids: readonly string[]) => (ids.length === 1 ? shortId(ids[0]!) : `${num(ids.length)} runs`);

/** "Deleted 3 runs", "Labelled 2 of 3 runs “good” · 01K5CQ6L0P was left alone: no such run". */
export function bulkToast(o: { verb: string; done: readonly string[]; of: number; skipped: readonly BulkSkip[]; suffix?: string }): string {
  const what = o.done.length === o.of ? named(o.done) : `${num(o.done.length)} of ${num(o.of)} runs`;
  const why = o.skipped.slice(0, 2).map((s) => `${shortId(s.runId)} ${s.reason === 'still recording' ? 'is still recording' : `was left alone: ${s.reason}`}`);
  return [`${o.verb} ${what}${o.suffix ?? ''}`, ...why].join(' · ');
}
