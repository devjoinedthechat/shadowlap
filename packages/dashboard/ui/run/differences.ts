import type { ForkDifferences } from '../../src/fork-differences.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';

/**
 * What the fork did differently, read once `want` says the run is a fork that has ended; null until
 * it comes, or with none to say. Apart from their panel (ForkDifferences.tsx), which a run's page
 * loads as a part of its own once there are differences to show (FindingsBar.tsx).
 */
export function useForkDifferences(runId: string, want: boolean): ForkDifferences | null {
  const { client } = useApp();
  return useLoad(() => (want ? client.forkDifferences(runId) : null), `differences:${runId}:${want ? 'fork' : 'none'}`).data;
}
