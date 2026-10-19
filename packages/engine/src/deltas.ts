/** Normalized response blocks and playback deltas. No Node imports: the browser bundle uses this too. */

/**
 * A tool call is `hosted` when the provider runs the tool or defines it itself: Anthropic's server
 * tools (web search, web fetch, code execution) and MCP connector calls, the Responses API's built-in
 * tools (web and file search, the code interpreter, computer use, the shell).
 */
export type Block = { type: 'text'; text: string } | { type: 'thinking'; text: string } | { type: 'tool_call'; name: string; input: unknown; id?: string; hosted?: true };

export type Delta =
  | { t: number; op: 'start'; index: number; block: 'text' | 'thinking' | 'tool_call'; name?: string; hosted?: true }
  | { t: number; op: 'append'; index: number; text: string }
  | { t: number; op: 'stop'; reason: string };

function parseJsonText(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Replays deltas into blocks; tool inputs arrive as JSON text and are parsed at the end. */
export function applyDeltas(deltas: Delta[]): { blocks: Block[]; stopReason: string | null } {
  const acc: Array<{ block: 'text' | 'thinking' | 'tool_call'; name?: string; hosted?: true; text: string }> = [];
  let stopReason: string | null = null;
  for (const d of deltas) {
    if (d.op === 'start') acc[d.index] = { block: d.block, text: '', ...(d.name ? { name: d.name } : {}), ...(d.hosted ? { hosted: true as const } : {}) };
    else if (d.op === 'append') {
      const b = (acc[d.index] ??= { block: 'text', text: '' });
      b.text += d.text;
    } else stopReason = d.reason;
  }
  const blocks: Block[] = [];
  for (const b of acc) {
    if (!b) continue;
    if (b.block === 'tool_call') blocks.push({ type: 'tool_call', name: b.name ?? 'tool', input: b.text ? parseJsonText(b.text) : {}, ...(b.hosted ? { hosted: true as const } : {}) });
    else if (b.text) blocks.push({ type: b.block, text: b.text });
  }
  return { blocks, stopReason };
}
