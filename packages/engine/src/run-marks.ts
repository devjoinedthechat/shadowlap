/**
 * The good/bad key, as the dashboard and the terminal UI both have it: one press labels a run `good`
 * or `bad`, the two labels a run can't hold at once, and a press of the one it holds takes it off.
 * `good` is a run a fix must not make worse than its own baseline (`repair --keeps label:good`);
 * `bad` names one that went wrong, for `repair --fixes label:bad`. Plain functions of a run's labels:
 * the dashboard's browser code imports them too.
 */

export type RunMark = 'good' | 'bad';

export const MARKS: readonly RunMark[] = ['good', 'bad'];

/** The other mark: a run labelled good is no longer bad, and the other way round. */
const other = (m: RunMark): RunMark => (m === 'good' ? 'bad' : 'good');

/** The mark a key gives where a run's keys are heard: + (or =) good, - bad. */
export function markKey(key: string): RunMark | null {
  return key === '+' || key === '=' ? 'good' : key === '-' ? 'bad' : null;
}

/** The labels a press of the key changes: on, the mark added and the other taken off; on a run that has it, the mark taken off. */
export function markChange(labels: readonly string[], m: RunMark): { add: string[]; remove: string[] } {
  if (labels.includes(m)) return { add: [], remove: [m] };
  return { add: [m], remove: labels.includes(other(m)) ? [other(m)] : [] };
}

/** What a press says: `01M5GRX8K4 is good: a fix must not make it worse than its own baseline`, or that it no longer is. */
export function markToast(runId: string, m: RunMark, on: boolean): string {
  const id = runId.slice(0, 10);
  if (!on) return `${id} is no longer marked ${m}`;
  return m === 'good' ? `${id} is good: a fix must not make it worse than its own baseline (--keeps label:good)` : `${id} is bad: one to fix (--fixes label:bad)`;
}
