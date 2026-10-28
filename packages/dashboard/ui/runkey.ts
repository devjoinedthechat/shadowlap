import type { RunMark } from '../../engine/src/run-marks.js';

/**
 * The good/bad key: one press labels a run `good` or `bad`, the two labels a run can't hold at once,
 * and a press of the one it holds takes it off. `good` is a run a fix must not make worse than its
 * own baseline (`repair --keeps label:good`, and Repair from here takes a fix's good runs from it);
 * `bad` names a run that went wrong, for `repair --fixes label:bad`. The key itself, what a press
 * changes and what it says are the engine's (run-marks.ts), which the terminal UI's key is too; here
 * is what the page adds: each press can be undone, the change it made taken back. No DOM here: the
 * tests import it.
 */

export { markChange, markKey, MARKS, markToast, type RunMark } from '../../engine/src/run-marks.js';

/** Whether a run's labels hold a mark. */
export const hasMark = (labels: readonly string[], m: RunMark): boolean => labels.includes(m);

/** The labels a change gives a run, as the server's `withLabels` makes them: those taken off go, those added come after the rest. */
export function withChange(labels: readonly string[], c: { add: readonly string[]; remove: readonly string[] }): string[] {
  const kept = labels.filter((l) => !c.remove.includes(l));
  return [...kept, ...c.add.filter((l) => !kept.includes(l))];
}

/** What undoes a change made to `before`: what it added that wasn't there taken off, and what it took off that was put back. */
export function undoChange(before: readonly string[], c: { add: readonly string[]; remove: readonly string[] }): { add: string[]; remove: string[] } {
  return { add: c.remove.filter((l) => before.includes(l)), remove: c.add.filter((l) => !before.includes(l)) };
}

/** The hover of a key's button, by what pressing it does. */
export function markTitle(m: RunMark, on: boolean): string {
  if (on) return `Labelled ${m}: press to take the label off`;
  return m === 'good' ? 'Label it good: a fix must not make it worse than its own baseline, as repair --keeps label:good checks' : 'Label it bad: a run that went wrong, for repair --fixes label:bad';
}
