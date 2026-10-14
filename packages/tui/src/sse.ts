import { applyDeltas, type Delta } from '@shadowlap/engine';

/** Play mode for streamed responses, over the provider-neutral deltas the engine derives from them. */

export { parseSse } from '@shadowlap/engine';
export type { SseEvent } from '@shadowlap/engine';

export interface StreamView {
  /** The response as a user would have seen it so far: text lines, tool calls, thinking. */
  lines: string[];
  stopReason: string | null;
}

/** What the response looked like after its first `upto` deltas. */
export function streamView(deltas: Delta[], upto: number): StreamView {
  const { blocks, stopReason } = applyDeltas(deltas.slice(0, upto));
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.type === 'tool_call') lines.push(`⚙ ${b.name} ${typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {})}`);
    else if (b.type === 'thinking') lines.push(`💭 ${b.text}`);
    else lines.push(...b.text.split('\n'));
  }
  return { lines, stopReason };
}
