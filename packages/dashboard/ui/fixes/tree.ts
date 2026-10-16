import { useMemo } from 'react';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import type { JobListItem } from '../types.js';
import { mergeTreeJobs, treeBusy } from './model.js';

/**
 * The jobs the server runs and has run, from every tab and the terminal's dashboard alike, with this
 * tab's own on top (`mergeTreeJobs`): what a button reads to wait for a job that would make the
 * server refuse it. Read again whenever the change feed says a job started, ended or reported.
 * None on a page where nothing can run.
 */
export function useServerJobs(): JobListItem[] {
  const { client, exported, actionsOff, feeds, jobs } = useApp();
  const listed = useLoad(() => (exported || actionsOff ? null : client.jobs()), 'server-jobs', feeds.jobs ?? 0);
  return useMemo(() => mergeTreeJobs(listed.data, jobs), [listed.data, jobs]);
}

/**
 * Why an action that uses the project's working tree as `use` can't start now, as the server would
 * refuse it, or null: what Run blame, Repair from here, Apply the patch and the Tests actions read to
 * disable themselves, with the reason (`treeBusy`). Only jobs in this project's tree count.
 */
export function useTreeBusy(use: 'reads' | 'writes', verb: string): string | null {
  const { meta } = useApp();
  const tree = useServerJobs();
  return treeBusy(tree, use, verb, meta?.project?.path ?? null);
}
