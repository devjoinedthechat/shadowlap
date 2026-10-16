import { num, shortId } from '../format.js';
import type { BulkSkip, DeleteResult, LabelRunsResult } from '../types.js';

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

/** The most runs one dataset takes: `export-dataset` refuses more (MAX_DATASET_RUNS in src/run-exports.ts). */
export const DATASET_MAX = 500;

/** Why Dataset is off for the runs picked, or null: more than one dataset takes. The bar picks up to 1,000. */
export function datasetOff(runs: number): string | null {
  return runs > DATASET_MAX ? `At most ${num(DATASET_MAX)} runs go into one dataset: ${num(runs)} are picked` : null;
}

/** A Delete of up to this many runs spells out every id in its command; past it, the first RM_SHOWN and how many more. */
export const RM_ALL = 10;
export const RM_SHOWN = 5;

/**
 * The command a bulk Delete runs: `full` for Copy, and `shown`, what its dialog prints. A pick of a
 * few runs prints every id; a long one prints the first few and how many more (`… and 1,095 more`),
 * so the dialog keeps its title and buttons on the screen.
 */
export function rmCommand(ids: readonly string[]): { shown: string; full: string } {
  const short = ids.map((id) => shortId(id));
  const full = `shadowlap rm ${short.join(' ')}`;
  if (short.length <= RM_ALL) return { shown: full, full };
  return { shown: `shadowlap rm ${short.slice(0, RM_SHOWN).join(' ')} … and ${num(short.length - RM_SHOWN)} more`, full };
}

/** The most full ids the bulk routes take in one request (BULK_MAX in src/runs-list.ts): more go in batches. */
export const BULK_BATCH = 1000;

/** Sends the ids `size` at a time, one batch after the other, and hands back every answer in order. */
export async function inBatches<T>(ids: readonly string[], send: (part: string[]) => Promise<T>, size = BULK_BATCH): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(await send(ids.slice(i, i + size)));
  return out;
}

/** Bulk labels sent in batches, as one answer. */
export function joinLabelled(parts: readonly LabelRunsResult[]): LabelRunsResult {
  return { done: parts.flatMap((p) => p.done), skipped: parts.flatMap((p) => p.skipped) };
}

/** A bulk delete sent in batches, as one answer. */
export function joinDeleted(parts: readonly DeleteResult[]): DeleteResult {
  return { done: parts.flatMap((p) => p.done), attempts: parts.flatMap((p) => p.attempts), skipped: parts.flatMap((p) => p.skipped), blobs: parts.reduce((n, p) => n + p.blobs, 0), bytes: parts.reduce((n, p) => n + p.bytes, 0) };
}
