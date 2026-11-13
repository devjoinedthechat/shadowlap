import { num } from '../format.js';

/**
 * The reads a test plants in, as a dialog's fact and a card say them: the first three as `#4
 * get_ticket`, a read's number never apart from its name, joined by commas and a last `and`, then
 * `and 77 more` past three. `code` puts each name between backticks, for a fact that draws them in code.
 */
export function readsWords(reads: ReadonlyArray<{ callNo: number; name: string }>, code = false): string {
  const words = reads.slice(0, 3).map((r) => (code ? `\`#${r.callNo}\u00a0${r.name}\`` : `#${r.callNo}\u00a0${r.name}`));
  if (reads.length > 3) return `${words.join(', ')} and ${num(reads.length - 3)}\u00a0more`;
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}` : (words[0] ?? '');
}
