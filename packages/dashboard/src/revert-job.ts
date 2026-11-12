import { ACTIONS, type StoreOf } from '@shadowlap/engine';
import type { JobBuild } from './jobs.js';
import { gitAsync, HEX } from './patch-in-tree.js';
import { standingFound } from './tests-bisect.js';
import { knownGolden, type GoldenSource } from './tests.js';

/**
 * Revert (A19): once Find breaking commit named the first bad commit of a golden that fails, undo it
 * in the project's working tree, uncommitted for you to review, then test the golden. git runs as
 * the job's first step (job-git.ts), on the commit the store holds for the golden's standing answer,
 * never on the request's text. A merge is reverted against its first parent (`-m 1`), as git says of
 * it when the job is built. Where git refuses (changes to the commit's files in the tree) or leaves
 * conflicts, the output says so in git's words and the test never runs. Nothing is recorded of the
 * revert itself: its test keeps a session as any test does, and Runs reads `fixed by <run>` from it.
 */

/** The job's request: the golden, the commit it reverts (which must be the golden's standing first bad commit) and the run it is about. */
export interface RevertRequest {
  golden?: unknown;
  rev?: unknown;
  runId?: unknown;
}

/** Two names of one commit: a short sha and a longer one, or the same. */
const sameCommit = (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase());

/** What the job says once git has reverted the commit: what it did, and that nothing is committed. */
export const revertedLine = (rev: string): string => `reverted ${rev} in your working tree · not committed`;

/**
 * The job Revert starts: `git revert --no-commit [-m 1] <rev>`, then `shadowlap test <golden>`, or
 * why not: a golden not on disk or that can't be read, a commit that isn't the golden's standing
 * answer, or no project folder to revert in.
 */
export async function revertJob(store: StoreOf<'recording' | 'tests' | 'activity'>, goldens: readonly GoldenSource[], req: RevertRequest, project: string | null): Promise<JobBuild | { error: string; status?: number }> {
  if (!project) return { error: 'Revert needs the project folder: start the dashboard with shadowlap dashboard in it', status: 409 };
  const golden = knownGolden(goldens, req.golden);
  if (!golden) return { error: 'golden: name a golden on disk' };
  const source = goldens.find((g) => g.path === golden)!;
  if (source.error) return { error: `${golden} can't be read: ${source.error}` };
  const found = standingFound(store, golden);
  const rev = found && HEX.test(found.rev) ? found.rev : null;
  if (!rev) return { error: `Find breaking commit has named no first bad commit for ${golden}'s failure: there is nothing to revert` };
  if (typeof req.rev !== 'string' || !HEX.test(req.rev) || !sameCommit(req.rev, rev)) return { error: `${typeof req.rev === 'string' ? req.rev.slice(0, 40) : 'rev'} is not the first bad commit Find breaking commit named for ${golden}, ${rev}` };
  // A merge is reverted against its first parent, whatever the answer kept: asked of git here.
  const merge = (await gitAsync(project, ['rev-parse', '-q', '--verify', `${rev}^2`])).code === 0;
  const runId = typeof req.runId === 'string' && /^[0-9A-Z]{26}$/.test(req.runId) && store.getRun(req.runId) ? req.runId : null;
  return {
    title: `${ACTIONS.revert.doing} ${rev}`,
    git: { args: ['revert', '--no-commit', ...(merge ? ['-m', '1'] : []), rev], ok: revertedLine(rev), doing: 'a commit is being reverted in your working tree', verb: 'revert it' },
    args: ['test', golden],
    runId,
  };
}
