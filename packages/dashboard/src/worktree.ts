import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The working tree a job uses: the folder it runs in, a project's, with the agent's own files. A job
 * whose command changes those files (`repair` tries each candidate there and puts the files back,
 * `fix apply` applies a patch for good) runs alone in its tree, and one that runs the agent from them
 * (run, replay, blame, verify, test, calibrate, injection, tasks score) never alongside one that changes them:
 * an agent started meanwhile would run a candidate's prompt, and blame or test would hold it against
 * the code. Bisect replays in worktrees of its own, so it is neither. It is worked out from the
 * commands a builder returns, so every feature's kinds take part, whoever registers them.
 *
 * Trees are told apart by folder: jobs in two projects never wait for each other, unless one project
 * is inside the other, where a change to one may be a change to the other.
 */

/** How a job uses its working tree, as the job's view shows it. */
export interface JobTree {
  use: 'reads' | 'writes';
  /** What it is doing there, for the 409 another job gets and for the page, which disables what would be refused. */
  doing: string;
  /** The folder it runs in, as the dashboard names its project's (null: the dashboard's own). */
  folder: string | null;
}

/** How one command uses the tree, and what to do once it is free (the verb in "repair once it is done"). */
export interface TreeUse {
  use: 'reads' | 'writes';
  doing: string;
  verb: string;
}

/** Commands that run the agent from the working tree: what each is called, and its verb. */
const TREE_READS: Readonly<Record<string, { noun: string; verb: string }>> = {
  run: { noun: 'a recording', verb: 'record' },
  replay: { noun: 'a replay', verb: 'replay' },
  blame: { noun: 'a blame', verb: 'blame' },
  verify: { noun: 'a verify', verb: 'verify' },
  test: { noun: 'a test', verb: 'test' },
  calibrate: { noun: 'a calibration', verb: 'calibrate' },
  injection: { noun: 'an injection test', verb: 'test for injection' },
};

/** How the CLI command `args` (what follows `shadowlap`) uses the working tree, or null when it runs no agent. */
export function commandTreeUse(args: readonly string[]): TreeUse | null {
  const [command, sub] = args;
  // The decision diff runs the agent only to read the prompt it sends (--from-code) and to verify; migrate always verifies.
  if (command === 'migrate') return { use: 'reads', doing: 'a migration is verifying runs with your agent from your working tree', verb: 'migrate' };
  if (command === 'decisions' && args.includes('--verify')) return { use: 'reads', doing: 'the changed runs are being verified with your agent from your working tree', verb: 'verify the changed runs' };
  if (command === 'decisions' && (args.includes('--from-code') || args.includes('--then-verify'))) return { use: 'reads', doing: 'a decision diff is running your agent from your working tree', verb: 'preview the change' };
  if (command === 'repair') return { use: 'writes', doing: 'a repair is trying candidates in your working tree', verb: 'repair' };
  if (command === 'fix' && sub === 'apply') return { use: 'writes', doing: 'a patch is being applied to your working tree', verb: 'apply the patch' };
  const reads = command === 'tasks' ? (sub === 'score' ? { noun: 'tasks score', verb: 'score' } : undefined) : TREE_READS[command ?? ''];
  return reads ? { use: 'reads', doing: `${reads.noun} is running your agent from your working tree`, verb: reads.verb } : null;
}

const isCommand = (c: unknown): c is string[] => Array.isArray(c) && c.length > 0 && c.every((a) => typeof a === 'string');

/** Every command a job runs, in order: the arguments its builder returned, then any it chains after them (`then`). */
export function jobCommands(built: { args: string[]; then?: unknown }): string[][] {
  return [built.args, ...(Array.isArray(built.then) ? built.then.filter(isCommand) : [])];
}

/**
 * How a job that runs `commands` in order uses its tree: the strongest use among them (changing it
 * over running the agent from it), as the first command that makes it says it; null when none runs
 * the agent. A `normalize add` chained before a `test` holds the tree as the test does.
 */
export function treeUse(commands: ReadonlyArray<readonly string[]>): TreeUse | null {
  let found: TreeUse | null = null;
  for (const c of commands) {
    const use = commandTreeUse(c);
    if (use && (!found || (use.use === 'writes' && found.use === 'reads'))) found = use;
  }
  return found;
}

/** The folder a job's tree is told apart by: where it runs, through symbolic links; null for the dashboard's own folder. */
export function treeFolder(cwd: string | null): string | null {
  if (!cwd) return null;
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

const inside = (outer: string, inner: string): boolean => {
  const rel = relative(outer, inner);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Whether jobs running in folders `a` and `b` (as `treeFolder` gives them) share a working tree: the
 * same folder, or one inside the other. Null, the dashboard's own folder, shares every tree.
 */
export function sameTree(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true;
  return inside(a, b) || inside(b, a);
}

/**
 * The first running job a job using its tree as `use` in `at` (a `treeFolder`) clashes with: in the
 * same tree, one that changes it, or any that uses it when this one changes it. Null when it can start.
 */
export function treeClash(running: Iterable<{ tree: JobTree | null; at: string | null }>, use: 'reads' | 'writes', at: string | null): JobTree | null {
  for (const r of running) {
    if (!r.tree || !sameTree(r.at, at)) continue;
    if (use === 'writes' || r.tree.use === 'writes') return r.tree;
  }
  return null;
}
