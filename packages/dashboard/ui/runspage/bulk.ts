import { num, plural, shortId } from '../format.js';
import { jobCommand } from '../jobs.js';
import type { BulkSkip, DeleteResult, LabelRunsResult } from '../types.js';

/** What the bulk bar says once it has acted on the runs picked, and what Push sends. No DOM here: the tests import it. */

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

/**
 * What a bulk Delete takes, for its title: "2 runs and the 6 attempts bundled under them",
 * "01K5CQ4N7G and the attempt bundled under it", or the runs alone when none has attempts. A count
 * keeps to its noun when the title wraps.
 */
export function deleteWhat(ids: readonly string[], attempts: number): string {
  const runs = named(ids).replace(' ', '\u00a0');
  if (!attempts) return runs;
  return `${runs} and the ${attempts === 1 ? 'attempt' : `${num(attempts)}\u00a0attempts`} bundled under ${ids.length === 1 ? 'it' : 'them'}`;
}

/** The line under a bulk Delete's title: what goes with the runs, what keeps its data, and the runs still recording it leaves alone. */
export function deleteText(runs: number, attempts: number, live: readonly string[]): string {
  const them = runs === 1 ? 'it' : 'them';
  const gone = attempts ? `${runs === 1 ? 'the run' : 'the runs'}, ${attempts === 1 ? 'the attempt' : 'the attempts'} bundled under ${them}` : runs === 1 ? 'the run' : 'the runs';
  const left = live.length ? ` ${live.map((id) => shortId(id)).join(', ')} ${live.length === 1 ? 'is' : 'are'} still recording and ${live.length === 1 ? 'is' : 'are'} left alone.` : '';
  return `Removes ${gone} and the recorded data nothing else uses. ${runs === 1 ? 'Its' : 'Their'} forks keep their own data but lose the link.${left}`;
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

/** The most runs one Pack takes (MAX_PACK_RUNS in src/run-exports.ts): each is a command of its job, and its drawer lists every folder. */
export const PACK_MAX = 100;

/** Why Pack is off for the runs picked, or null. The bar picks up to 1,000. */
export function packOff(runs: number): string | null {
  return runs > PACK_MAX ? `At most ${num(PACK_MAX)} runs are packed at once: ${num(runs)} are picked` : null;
}

/**
 * Where each run of a bulk Pack goes inside `dir`: a folder named by the first ten characters of its
 * id in lower case, as one run's pack is named, or its whole id where two runs share those ten. The
 * job names them the same way (src/run-exports.ts `packFolders`).
 */
export function packFolders(ids: readonly string[], dir: string): Array<{ runId: string; folder: string }> {
  const parent = dir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const shorts = ids.map((id) => id.slice(0, 10).toLowerCase());
  return ids.map((runId, i) => ({ runId, folder: `${parent}/${shorts.indexOf(shorts[i]!) === shorts.lastIndexOf(shorts[i]!) ? shorts[i]! : runId.toLowerCase()}` }));
}

/**
 * The commands a bulk Pack runs, a `pack` per run into its own folder in `dir`: `shown` in its dialog
 * (the first, and how many more), `full` for Copy, each after the one before worked, as the job runs
 * them.
 */
export function packCommand(ids: readonly string[], dir: string): { shown: string; full: string } {
  const lines = packFolders(ids, dir).map(({ runId, folder }) => jobCommand(['pack', shortId(runId), folder]));
  const full = lines.join(' && ');
  if (lines.length <= 1) return { shown: full, full };
  return { shown: `${lines[0]!} … and\u00a0${num(lines.length - 1)}\u00a0more, one per run`, full };
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

/**
 * Add label…'s suggestions: every label the runs in memory carry (the newest 500), most used first,
 * ties in alphabetical order, `good` and `bad` among them. An older label is typed.
 */
export function labelSuggestions(runs: ReadonlyArray<{ labels?: readonly string[] | null }> | null): string[] {
  const uses = new Map<string, number>();
  for (const r of runs ?? []) for (const l of r.labels ?? []) uses.set(l, (uses.get(l) ?? 0) + 1);
  return [...uses].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([l]) => l);
}
