import { canonicallySame } from '../../engine/src/canonical.js';
import type { DecisionView } from './types.js';

/**
 * A tool call's mark beside the other side's decision, as an opened cell draws it: the other side
 * makes the very call (`same`, a faint →), calls the tool otherwise (`diff`, → in ink), or doesn't
 * call it (`gone` on the recorded side, struck through, `new` on the changed one).
 */
export type ToolMark = 'same' | 'diff' | 'gone' | 'new';

export function toolMarks(d: Pick<DecisionView, 'tools'>, other: Pick<DecisionView, 'tools'> | null, side: 'recorded' | 'now'): ToolMark[] {
  const theirs = other?.tools ?? [];
  const same = (t: DecisionView['tools'][number]) => theirs.some((o) => o.name === t.name && canonicallySame(o.args ?? null, t.args ?? null));
  return d.tools.map((t) => (same(t) ? 'same' : theirs.some((o) => o.name === t.name) ? 'diff' : side === 'recorded' ? 'gone' : 'new'));
}

/** A tool's effect as its tag says it: a tool of unknown effect counts as a write, as the engine counts it; a hand-over keeps its word. */
export const effectTag = (effect: DecisionView['tools'][number]['effect']): string => (effect === 'unknown' ? 'write' : effect);

/**
 * A call's arguments as JSON, cut where a line may break: after a comma or an opening brace, never
 * inside a short quoted value (an id), which is `whole`; arguments of 30 characters or fewer stay whole.
 */
export function argParts(json: string): Array<{ text: string; whole: boolean }> {
  if (json.length <= 30) return [{ text: json, whole: true }];
  return json.split(/("(?:[^"\\]|\\.)*")/).flatMap((part, i) => (i % 2 ? [{ text: part, whole: part.length <= 30 && !/\s/.test(part) }] : part.split(/(?<=[,{])/).filter(Boolean).map((text) => ({ text, whole: false }))));
}

