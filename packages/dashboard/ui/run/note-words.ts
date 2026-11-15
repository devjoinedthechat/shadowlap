import type { NotePart } from './notes.js';

/**
 * The words of a run's notes that Tests' failure lines read too: what to do about a process the
 * guard can't watch, and a note's words alone. Apart from the rest of a run's notes (notes.ts, which
 * re-exports them), so the first look, which holds Tests' lines, holds only these.
 */

/**
 * What to do about a process the guard can't watch, in `shadowlap doctor`'s words (its
 * UNGUARDED_FIX, which a test holds this to), with the page's apostrophes.
 */
export const UNGUARDED_FIX: readonly NotePart[] = [
  'The Claude Code CLI the Claude Agent SDK runs is a native program that loads no shadowlap preload, so the network guard can’t watch a connection it makes itself, and its fence names what it can still reach. Close each (disallow WebFetch, keep MCP servers to the query’s own with strictMcpConfig, reach a remote one through ',
  { code: 'shadowlap mcp' },
  ', which records and fences its calls), accept the CLI alone with ',
  { code: '"guard": { "accept": ["claude-code"] }' },
  ' in shadowlap.config.json, or test with ',
  { code: '--guard warn' },
  ' to accept every connection the guard can’t watch. A Node or Python process whose guard could not start says so on its standard error.',
];

/** A note's words alone, as a screen reader and a test read them. */
export function noteText(parts: readonly NotePart[]): string {
  return parts.map((p) => (typeof p === 'string' ? p : 'code' in p ? p.code : `#${p.call}`)).join('');
}
