import { safeText, type Block, type Turn, type TurnBlock } from '@shadowlap/engine';
/** Text rendering helpers: wrapping, truncation, JSON and message content blocks as lines. */

export function truncate(s: string, width: number): string {
  s = safeText(s);
  if (width <= 1) return s.slice(0, Math.max(0, width));
  return s.length > width ? s.slice(0, width - 1) + '…' : s;
}

/**
 * Items joined with ` · ` in at most `width` columns: as many whole items as fit, then ` · …` where
 * the rest are left out, so a line never ends inside a word. A first item too long by itself is cut.
 */
export function fitItems(items: readonly string[], width: number, sep = ' · '): string {
  const all = items.join(sep);
  if (all.length <= width) return all;
  const more = `${sep}…`;
  let shown = '';
  for (const item of items) {
    const next = shown ? `${shown}${sep}${item}` : item;
    if (next.length + more.length > width) break;
    shown = next;
  }
  return shown ? `${shown}${more}` : truncate(all, width);
}

export function wrap(text: string, width: number): string[] {
  text = safeText(text);
  const w = Math.max(8, width);
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para.length <= w) {
      out.push(para);
      continue;
    }
    // Indented lines (lists, code) keep their indentation on every wrapped line, within reason.
    const indent = /^\s*/.exec(para)![0].slice(0, Math.floor(w / 3));
    const inner = w - indent.length;
    let line = '';
    for (const word of para.trimStart().split(' ')) {
      if (word.length > inner) {
        if (line) out.push(indent + line);
        line = '';
        for (let i = 0; i < word.length; i += inner) out.push(indent + word.slice(i, i + inner));
        continue;
      }
      if ((line + ' ' + word).trim().length > inner) {
        out.push(indent + line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(indent + line);
  }
  return out;
}

export function jsonLines(value: unknown, width: number, maxLines = 4000): string[] {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  const lines = text.split('\n').flatMap((l) => (l.length > width ? wrap(l, width) : [l]));
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`] : lines;
}

/** Renders one block of a normalized conversation or response as lines. */
export function blockLines(b: TurnBlock | Block, width: number): string[] {
  switch (b.type) {
    case 'text':
      return wrap(b.text, width);
    case 'thinking':
      return 'redacted' in b && b.redacted ? ['💭 (redacted thinking)'] : wrap(`💭 ${b.text || '(thinking)'}`, width);
    case 'tool_call':
      // While a streamed call plays back, its input is still partial JSON text.
      return wrap(`⚙ ${b.name} ${typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {})}`, width);
    case 'tool_result':
      return wrap(`${b.isError ? '↳ error result' : '↳ result'}${b.name ? ` from ${b.name}` : ''}: ${b.content}`, width);
    case 'other':
      return [`[${b.label}]`];
  }
}

export interface RenderedLine {
  text: string;
  role?: 'system' | 'user' | 'assistant' | 'tool' | 'label';
}

/** Renders a conversation, whatever the provider, as role-labelled lines. System turns are not numbered. */
export function conversationLines(turns: Turn[], width: number): RenderedLine[] {
  const out: RenderedLine[] = [];
  let n = 0;
  for (const turn of turns) {
    out.push({ text: turn.role === 'system' ? 'system' : `${turn.role}  #${++n}`, role: 'label' });
    for (const b of turn.blocks) for (const text of blockLines(b, width)) out.push({ text, role: turn.role });
    out.push({ text: '' });
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
