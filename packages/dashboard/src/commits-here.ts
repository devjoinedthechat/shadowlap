import { execFileSync } from 'node:child_process';
import type { BisectChoices, BisectRange } from './tests.js';

/**
 * Find the commit offers only commits this checkout has, wherever it is offered: the Runs calendar,
 * a run's page and Tests. With a team store, a teammate's runs and CI's test sessions name commits
 * of their own checkout (a pull request's merge commit, a branch never fetched), which bisect can't
 * start from or stop at here.
 */

/**
 * Which of these revisions are commits the project's git has. With a team store, a teammate's runs
 * name commits of their own checkout, which bisect can't start from here. Null when git can't say
 * (no git, not a repository): the choices stay as they are, and bisect says why it can't run.
 */
export function commitsHere(cwd: string, revs: ReadonlyArray<string | null>): Set<string> | null {
  // Only a commit's hex name: a revision comes from a run, which may have come from anyone.
  const wanted = [...new Set(revs.filter((r): r is string => !!r && /^[0-9a-f]{4,64}$/i.test(r)))];
  if (!wanted.length) return new Set();
  try {
    const out = execFileSync('git', ['cat-file', '--batch-check'], { cwd, input: wanted.map((r) => `${r}^{commit}\n`).join(''), stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 1024 * 1024 });
    // One line each, in order: "<sha> commit <size>", or "<rev> missing" (or "ambiguous").
    const lines = out.toString().split('\n');
    return new Set(wanted.filter((_, i) => / commit \d+$/.test(lines[i] ?? '')));
  } catch {
    return null;
  }
}

/**
 * Find the commit's choices without the commits this checkout doesn't have: the good one falls to
 * the newest one here where the runs didn't all fail, and the bad one to HEAD when the failure's own
 * commit isn't here.
 */
export function choicesHere(c: BisectChoices, here: ReadonlySet<string>): BisectChoices {
  const revisions = c.revisions.filter((r) => here.has(r.rev));
  const bad = c.bad && here.has(c.bad) ? c.bad : null;
  const good = c.good && here.has(c.good) ? c.good : c.failed ? (revisions.find((r) => r.failed < r.runs)?.rev ?? null) : null;
  const ref = c.target.kind === 'golden' ? c.target.golden : c.target.runId;
  return { ...c, revisions, good, bad, args: good && !c.unavailable ? ['bisect', ref, '--good', good, ...(bad ? ['--bad', bad] : []), ...(c.fork ? ['--fork'] : [])] : null };
}

/** A run's Find the commit as the project's checkout can run it; as it is without a project folder, or when git can't say. */
export function choicesInCheckout(root: string | null | undefined, c: BisectChoices): BisectChoices {
  if (!root) return c;
  const here = commitsHere(root, [c.good, c.bad, ...c.revisions.map((r) => r.rev)]);
  return here ? choicesHere(c, here) : c;
}

/**
 * A golden's Find the commit (Tests) as this checkout can run it: none without the commit where it
 * last passed, so the page asks for one, and up to HEAD when the commit where it failed isn't here.
 */
export function rangeHere(golden: string, range: BisectRange, here: ReadonlySet<string>): BisectRange | null {
  if (!here.has(range.good)) return null;
  const bad = range.bad && here.has(range.bad) ? range.bad : null;
  return { ...range, bad, args: ['bisect', golden, '--good', range.good, ...(bad ? ['--bad', bad] : [])] };
}
