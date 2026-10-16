import { num, shortId } from '../format.js';
import type { BulkSkip } from '../types.js';

/** What the bulk bar says once it has acted on the runs picked, and what Push sends. No DOM here: the tests import it. */

export const named = (ids: readonly string[]) => (ids.length === 1 ? shortId(ids[0]!) : `${num(ids.length)} runs`);

/** "Deleted 3 runs", "Labelled 2 of 3 runs “good” · 01K5CQ6L0P was left alone: no such run". */
export function bulkToast(o: { verb: string; done: readonly string[]; of: number; skipped: readonly BulkSkip[]; suffix?: string }): string {
  const what = o.done.length === o.of ? named(o.done) : `${num(o.done.length)} of ${num(o.of)} runs`;
  const why = o.skipped.slice(0, 2).map((s) => `${shortId(s.runId)} ${s.reason === 'still recording' ? 'is still recording' : `was left alone: ${s.reason}`}`);
  return [`${o.verb} ${what}${o.suffix ?? ''}`, ...why].join(' · ');
}

/**
 * What a run's `local` tag says on hover: the run is only on this machine, or attempts bundled under
 * it are (`--repeat`, blame's probes, verify's attempts), which Push sends with the run.
 */
export function localTitle(parts: { run: boolean; attempts: number } | undefined): string {
  if (!parts) return 'Only on the machine that recorded it';
  const n = `${num(parts.attempts)} ${parts.attempts === 1 ? 'attempt' : 'attempts'}`;
  if (parts.run) return `Only on the machine that recorded it, with ${n} bundled under it`;
  return `${n} bundled under it ${parts.attempts === 1 ? 'is' : 'are'} only on this machine: pushing the run sends ${parts.attempts === 1 ? 'it' : 'them'}`;
}
