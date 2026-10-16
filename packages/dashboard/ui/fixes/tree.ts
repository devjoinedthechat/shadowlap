import { useMemo } from 'react';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import { mergeTreeJobs, treeBusy } from './model.js';

/**
 * Why an action that uses the project's working tree as `use` can't start now, as the server would
 * refuse it, or null: what Run blame, Repair from here and Apply the patch read to disable
 * themselves, with the reason (`treeBusy`). It reads the jobs the server is running, from every tab
 * and the terminal's dashboard alike, with this tab's own on top (`mergeTreeJobs`), and counts only
 * those in this project's tree. Nothing is busy on a page where nothing can run.
 */
export function useTreeBusy(use: 'reads' | 'writes', verb: string): string | null {
  const { client, exported, actionsOff, feeds, jobs, meta } = useApp();
  const listed = useLoad(() => (exported || actionsOff ? null : client.jobs()), 'tree-jobs', feeds.jobs ?? 0);
  const tree = useMemo(() => mergeTreeJobs(listed.data, jobs), [listed.data, jobs]);
  return treeBusy(tree, use, verb, meta?.project?.path ?? null);
}
