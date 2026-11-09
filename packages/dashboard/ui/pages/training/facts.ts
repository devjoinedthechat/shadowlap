import type { TrainingView } from '../../api.js';
import type { Fact } from '../../components/Facts.js';
import { num, plural } from '../../format.js';
import { leftNote } from '../../training.js';

/**
 * Training's facts under its header, the same on both tabs (the design's trainingFacts): the pairs,
 * the tasks ready of all of them, the best mean score once a model is scored, and what the last
 * export wrote, last and quieter; each one's makeup on its hover. None leads anywhere: the tabs are
 * right under them.
 */
export function trainingFacts(view: TrainingView, now = Date.now()): Fact[] {
  const { pairs, tasks, best, left } = view.strip;
  const n = Number(pairs.value) || 0;
  const facts: Fact[] = [
    { value: num(n), words: n === 1 ? 'pair' : 'pairs', tip: { title: plural(n, 'pair'), parts: [pairs.sub] } },
    { value: num(tasks.ready), words: `of ${num(tasks.total)} tasks ready`, tip: { title: `${num(tasks.ready)} of ${num(tasks.total)} tasks ready`, parts: [tasks.sub] } },
  ];
  if (best.mean !== null) facts.push({ value: best.value, words: 'best mean score', tip: { title: 'Best mean score', parts: [best.sub] } });
  facts.push({ value: num(left.pairs), words: 'exported', money: true, tip: { title: 'Exported', parts: [leftNote(left, now)] } });
  return facts;
}
