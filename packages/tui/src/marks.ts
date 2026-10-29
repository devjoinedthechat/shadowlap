import { markChange, withLabels, type RunMark } from '@shadowlap/engine';

/**
 * A run's labels after a press of the good/bad key, as the engine's markChange says which to add and
 * which to take off (run-marks.ts, the dashboard's too): the labels, and whether the mark is on.
 */
export function marked(labels: readonly string[], m: RunMark): { labels: string[]; on: boolean } {
  const { add, remove } = markChange(labels, m);
  return { labels: withLabels(labels, add, remove), on: add.includes(m) };
}
