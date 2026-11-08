import { num, plural, shortId } from '../format.js';
import type { BulkSkip } from '../types.js';

/** The words a bulk action and a run's own Delete and Add label… share, apart from the bulk bar's, so a run's page loads them alone. No DOM here. */

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
 * Add label…'s suggestions: every label the runs in memory carry (the newest 500), most used first,
 * ties in alphabetical order, `good` and `bad` among them. An older label is typed.
 */
export function labelSuggestions(runs: ReadonlyArray<{ labels?: readonly string[] | null }> | null): string[] {
  const uses = new Map<string, number>();
  for (const r of runs ?? []) for (const l of r.labels ?? []) uses.set(l, (uses.get(l) ?? 0) + 1);
  return [...uses].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([l]) => l);
}
