import { spawn, type ChildProcess } from 'node:child_process';
import { gitAsync } from './patch-in-tree.js';

/**
 * A job's git step (`JobBuild.git`): a git command the server built, run in the job's folder before
 * the CLI's commands, as Revert runs `git revert --no-commit <rev>`. git runs with no shell, its
 * arguments as they are; on macOS and Linux in a process group of its own, so stopping the job stops
 * it as it stops the CLI. What it left behind is asked of git afterwards, never read from its words.
 */

/** A git step as a job's builder gives it. */
export interface GitStep {
  /** git's arguments, after `git`: built from what the store holds, never from the request. */
  args: string[];
  /** The line the output says once git exited 0, before the CLI's commands. */
  ok: string;
  /** What it does to the working tree, which it holds as a writer: for the 409 another job gets. */
  doing: string;
  /** The verb a job refused meanwhile is told to wait to: "revert it once it is done". */
  verb: string;
}

/**
 * What a job's git step left in its working tree: `done` (it exited 0), `untouched` (it failed and
 * left the tree as it was: refused, or never started) or `conflicts` (it failed with files unmerged).
 */
export type GitOutcome = 'done' | 'untouched' | 'conflicts';

/** The step as the output shows it: `$ git revert --no-commit 9a3c5e0`. */
export const gitLine = (args: readonly string[]): string => `$ git ${args.join(' ')}`;

/** Starts git with `args` in `cwd`, its output piped: no shell, with the job's environment on top of the dashboard's. */
export function spawnGit(args: readonly string[], cwd: string | null, env: Record<string, string>): ChildProcess {
  return spawn('git', [...args], { ...(cwd ? { cwd } : {}), env: { ...process.env, ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
}

/** Whether git left unmerged files in the tree at `cwd`: what a failed revert's conflicts leave, and a refused one never does. */
export async function leftConflicts(cwd: string | null): Promise<boolean> {
  if (!cwd) return false;
  const out = await gitAsync(cwd, ['diff', '--name-only', '--diff-filter=U']);
  return out.code === 0 && out.stdout.trim() !== '';
}

/** Whether a builder's git step is one: arguments and its words, all strings. */
export function isGitStep(v: unknown): v is GitStep {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  const words = (x: unknown) => typeof x === 'string' && x.length > 0 && !x.includes('\0');
  return Array.isArray(s.args) && s.args.length > 0 && s.args.every(words) && words(s.ok) && words(s.doing) && words(s.verb);
}
