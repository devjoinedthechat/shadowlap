import { shortId } from './format.js';

/**
 * The good/bad key: one press labels a run `good` or `bad`, the two labels a run can't hold at once,
 * and a press of the one it holds takes it off. `good` is what a repair keeps working
 * (`repair --keeps label:good`, and Repair from here keeps a fix's good runs from it); `bad` names a
 * run that went wrong, for `repair --fixes label:bad`. Each press can be undone: the change it made,
 * taken back. No DOM here: the tests import it.
 */

export type RunMark = 'good' | 'bad';

export const MARKS: readonly RunMark[] = ['good', 'bad'];

/** The other mark: a run labelled good is no longer bad, and the other way round. */
const other = (m: RunMark): RunMark => (m === 'good' ? 'bad' : 'good');

/** Whether a run's labels hold a mark. */
export const hasMark = (labels: readonly string[], m: RunMark): boolean => labels.includes(m);

/** The labels a press of the key changes: on, the mark added and the other taken off; on a run that has it, the mark taken off. */
export function markChange(labels: readonly string[], m: RunMark): { add: string[]; remove: string[] } {
  if (hasMark(labels, m)) return { add: [], remove: [m] };
  return { add: [m], remove: hasMark(labels, other(m)) ? [other(m)] : [] };
}

/** The labels a change gives a run, as the server's `withLabels` makes them: those taken off go, those added come after the rest. */
export function withChange(labels: readonly string[], c: { add: readonly string[]; remove: readonly string[] }): string[] {
  const kept = labels.filter((l) => !c.remove.includes(l));
  return [...kept, ...c.add.filter((l) => !kept.includes(l))];
}

/** What undoes a change made to `before`: what it added that wasn't there taken off, and what it took off that was put back. */
export function undoChange(before: readonly string[], c: { add: readonly string[]; remove: readonly string[] }): { add: string[]; remove: string[] } {
  return { add: c.remove.filter((l) => before.includes(l)), remove: c.add.filter((l) => !before.includes(l)) };
}

/** The toast a press says: `01M5GRX8K4 is good: a repair keeps it working`, or that it no longer is. */
export function markToast(runId: string, m: RunMark, on: boolean): string {
  const id = shortId(runId);
  if (!on) return `${id} is no longer marked ${m}`;
  return m === 'good' ? `${id} is good: a repair keeps it working (--keeps label:good)` : `${id} is bad: one to fix (--fixes label:bad)`;
}

/** The hover of a key's button, by what pressing it does. */
export function markTitle(m: RunMark, on: boolean): string {
  if (on) return `Labelled ${m}: press to take the label off`;
  return m === 'good' ? 'Label it good: a repair keeps it working, as repair --keeps label:good does' : 'Label it bad: a run that went wrong, for repair --fixes label:bad';
}

/** The key a press of which marks a run where a run's keys are heard: + (or =) good, - bad. */
export function markKey(key: string): RunMark | null {
  return key === '+' || key === '=' ? 'good' : key === '-' ? 'bad' : null;
}
