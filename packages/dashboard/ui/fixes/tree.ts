import { useMemo } from 'react';
import { testsBusy } from '../goldens.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import type { JobListItem } from '../types.js';
import { mergeTreeJobs, treeBusy, type TreeJob } from './model.js';

/** A lime button's class while it waits: the page never offers a lime button that can't start. */
export const plainButton = (className: string): string => className.replace(' lime', '');

/**
 * The jobs the server runs and has run, from every tab and the terminal's dashboard alike, with this
 * tab's own on top (`mergeTreeJobs`): what a button reads to wait for a job that would make the
 * server refuse it. Read again whenever the change feed says a job started, ended or reported.
 * None on a page where nothing can run.
 */
export function useServerJobs(wanted = true): JobListItem[] {
  const { client, exported, actionsOff, feeds, jobs } = useApp();
  const listed = useLoad(() => (exported || actionsOff || !wanted ? null : client.jobs()), wanted ? 'server-jobs' : 'none', feeds.jobs ?? 0);
  return useMemo(() => mergeTreeJobs(listed.data, jobs), [listed.data, jobs]);
}

/**
 * Why an action that uses the project's working tree as `use` can't start now, as the server would
 * refuse it, or null: what Run blame, Run repair, Apply fix and the Tests actions read to
 * disable themselves, with the reason (`treeBusy`). Only jobs in this project's tree count. A list
 * hands its rows the `jobs` it read once, and they read none of their own.
 */
export function useTreeBusy(use: 'reads' | 'writes', verb: string, jobs?: readonly TreeJob[]): string | null {
  const { meta } = useApp();
  const tree = useServerJobs(!jobs);
  return treeBusy(jobs ?? tree, use, verb, meta?.project?.path ?? null);
}

/**
 * Why a Tests job started from another page (the run page's diverged-test banner) can't start now,
 * as the server would refuse it, or null: a job replaying or rewriting the goldens (`testsBusy`), or
 * a repair holding the working tree (`treeBusy`).
 */
export function useTestsWait(verb: string): string | null {
  return useJobWait({ verb, tests: true });
}

/**
 * Why a job can't start now, for one known only as the page renders (a run's next step): a Tests job
 * waits as `useTestsWait` says (`tests`), any other as `useTreeBusy` does for what reads the tree, or
 * changes it (`use`, Revert), and no job (null) waits for nothing.
 */
export function useJobWait(job: { verb: string; tests: boolean; use?: 'reads' | 'writes' | undefined } | null): string | null {
  const { meta } = useApp();
  const jobs = useServerJobs(!!job);
  if (!job) return null;
  return (job.tests ? testsBusy(jobs, job.verb, meta?.project?.id ?? null) : null) ?? treeBusy(jobs, job.use ?? 'reads', job.verb, meta?.project?.path ?? null);
}
