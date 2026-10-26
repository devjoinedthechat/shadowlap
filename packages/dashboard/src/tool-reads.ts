import type { Store } from '@shadowlap/engine';

/** What Settings → Tools reads from the store: every tool across runs, and the MCP servers calls came through. */
export interface ToolReads {
  key: string;
  usage: ReturnType<Store['toolUsage']>;
  mcp: ReturnType<Store['mcpServerUsage']>;
}

const toolReadCache = new WeakMap<Store, ToolReads>();

/**
 * Settings → Tools' store reads, kept per store until its runs or calls change (`changeCounts`).
 * Each scans every call in the store (0.8 s at 10,000 runs, 3.7 s the first time), so they are read
 * beside the server (read-jobs.ts `tool-reads`), and a tab read again with nothing new (the window
 * back in focus, a second tab) costs nothing.
 */
export function toolReads(store: Store): ToolReads {
  const counts = store.changeCounts();
  const key = `${counts.runs ?? 0}:${counts.calls ?? 0}`;
  const kept = toolReadCache.get(store);
  if (kept && kept.key === key) return kept;
  const read: ToolReads = { key, usage: store.toolUsage(), mcp: store.mcpServerUsage() };
  toolReadCache.set(store, read);
  return read;
}
