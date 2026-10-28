import { GOOD_LABEL, withLabels } from '@shadowlap/engine';

/**
 * The good/bad key, as the dashboard has it (packages/dashboard/ui/runkey.ts): one press labels a
 * run `good` or `bad`, which a run can't hold at once, and a press of the one it holds takes it off.
 * `good` is a run a fix must not make worse than its own baseline (`repair --keeps label:good`);
 * `bad` names one that went wrong, for `repair --fixes label:bad`.
 */
export type RunMark = 'good' | 'bad';

const other = (m: RunMark): RunMark => (m === 'good' ? 'bad' : 'good');

/** The mark a key gives: + (or =) good, - bad. */
export function markKey(input: string): RunMark | null {
  return input === '+' || input === '=' ? 'good' : input === '-' ? 'bad' : null;
}

/** The run's labels after a press: the mark added and the other taken off, or the mark taken off. */
export function marked(labels: readonly string[], m: RunMark): { labels: string[]; on: boolean } {
  if (labels.includes(m)) return { labels: withLabels(labels, [], [m]), on: false };
  return { labels: withLabels(labels, [m], labels.includes(other(m)) ? [other(m)] : []), on: true };
}

/** What a press says: `01M5GRX8K4 is good: a fix must not make it worse than its own baseline`. */
export function markToast(runId: string, m: RunMark, on: boolean): string {
  const id = runId.slice(0, 10);
  if (!on) return `${id} is no longer marked ${m}`;
  return m === GOOD_LABEL ? `${id} is good: a fix must not make it worse than its own baseline (--keeps label:good)` : `${id} is bad: one to fix (--fixes label:bad)`;
}
