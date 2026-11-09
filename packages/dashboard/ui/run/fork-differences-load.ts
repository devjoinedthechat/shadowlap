import type { ForkDifferences as Differences } from '../../src/fork-differences.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';

/** What the fork did differently, read once `want` says the run is a fork that has ended; null until it comes, or with none to say. */
export function useForkDifferences(runId: string, want: boolean): Differences | null {
  const { client } = useApp();
  return useLoad(() => (want ? client.forkDifferences(runId) : null), `differences:${runId}:${want ? 'fork' : 'none'}`).data;
}
