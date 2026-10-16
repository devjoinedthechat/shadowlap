import { useMemo } from 'react';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import type { TreeJob } from './model.js';

/**
 * The jobs using the project's working tree that the server is running, from every tab and the
 * terminal's dashboard alike, with this tab's own on top (they show before the change feed sees
 * them). What Run blame, Repair from here and Apply the patch read to disable themselves, with the
 * reason, while the server would refuse them (`treeBusy`). None on a page where nothing can run.
 */
export function useTreeJobs(): readonly TreeJob[] {
  const { client, exported, actionsOff, feeds, jobs } = useApp();
  const listed = useLoad(() => (exported || actionsOff ? null : client.jobs()), 'tree-jobs', feeds.jobs ?? 0);
  return useMemo(() => {
    const byId = new Map<string, TreeJob>();
    for (const j of listed.data ?? []) byId.set(j.id, j);
    for (const w of jobs) if (!w.lost) byId.set(w.job.id, w.job);
    return [...byId.values()];
  }, [listed.data, jobs]);
}
