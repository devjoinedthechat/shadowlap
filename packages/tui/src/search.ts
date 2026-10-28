import type { ChildProcess } from 'node:child_process';
import type { CallKind } from '@shadowlap/engine';

/**
 * Search across what runs said, as `shadowlap search` searches it: prompts, model responses, tool
 * arguments and tool results, every word or a "quoted phrase". It runs the CLI in a process of its
 * own, because the first search indexes every run in the store, which can take a while on a big one,
 * and the terminal UI must keep answering keys meanwhile; later searches index only what changed.
 */
export interface SearchHit {
  runId: string;
  callNo: number;
  kind: CallKind;
  name: string;
  field: 'prompt' | 'response' | 'arguments' | 'result';
  snippet: string;
  runStartedAt: number;
}

export type SearchResult = { hits: SearchHit[] } | { error: string };

/** How many matches a search lists. */
export const SEARCH_LIMIT = 50;

/** The CLI's arguments for a search: the query as one argument, as `shadowlap search` joins its words. */
export function searchArgs(query: string): string[] {
  return ['search', query, '--json', '-n', String(SEARCH_LIMIT)];
}

/** What the search printed and how it ended: its matches, none (exit 1), or why it failed. */
export function readSearch(stdout: string, stderr: string, code: number | null): SearchResult {
  if (code === 1 && !stdout.trim().startsWith('[')) return { hits: [] };
  if (code !== 0 && code !== 1) return { error: stderr.trim().split('\n').at(-1) || `search exited with code ${code ?? '?'}` };
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? { hits: parsed as SearchHit[] } : { error: 'search printed something other than its matches' };
  } catch {
    return { error: 'search printed something other than its matches' };
  }
}

/** Runs a search through the CLI and resolves with its matches. */
export function runSearch(spawn: (args: string[]) => ChildProcess, query: string): Promise<SearchResult> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child: ChildProcess;
    try {
      child = spawn(searchArgs(query));
    } catch (e) {
      resolve({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.once('error', (e) => resolve({ error: e.message }));
    child.once('close', (code) => resolve(readSearch(out, err, code)));
  });
}

/** The words a snippet should mark: each word of the query, or each quoted phrase whole. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const rest = query.replace(/"([^"]+)"/g, (_, phrase: string) => {
    terms.push(phrase.toLowerCase());
    return ' ';
  });
  for (const w of rest.split(/\s+/)) if (w) terms.push(w.toLowerCase());
  return terms;
}
