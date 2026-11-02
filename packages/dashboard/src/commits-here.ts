import { gitAsync } from './patch-in-tree.js';
import { bisectArgs, type BisectChoices, type BisectRange, type BisectRevision } from './tests.js';

/**
 * Find the commit offers only commits this checkout has, wherever it is offered: the Runs calendar,
 * a run's page and Tests. With a team store, a teammate's runs and CI's test sessions name commits
 * of their own checkout (a pull request's merge commit, a branch never fetched), which bisect can't
 * start from or stop at here. Each commit offered carries its subject, as `git log` shows it, so a
 * dialog can say "c91d0f4 · Escalate refunds above the limit".
 *
 * The pages that show these are read again as the store changes, so git's answers are kept: a
 * commit found stays found and its subject never changes; one not found is asked about again after
 * a minute, as a fetch may bring it. git runs beside the server (`execFile`), which answers other
 * requests while it waits.
 */

/** Only a commit's hex name is ever handed to git: a revision comes from a run, which may have come from anyone. */
const HEX = /^[0-9a-f]{4,64}$/i;
/** How long git's "no such commit" stands before it is asked again. */
const MISSING_FOR_MS = 60_000;

/**
 * What git said in one project folder: the commits it has, each with its subject and its author's
 * email, and when it last lacked one; and of the commits asked about, those with a parent here (kept:
 * a commit's parents never change) and those with none, the first or the oldest of a shallow clone,
 * with when that was said (a fetch may deepen a shallow clone).
 */
interface Answers {
  has: Map<string, string | null>;
  authors: Map<string, string>;
  lacks: Map<string, number>;
  parented: Set<string>;
  parentless: Map<string, { shallow: boolean; at: number }>;
}
const answers = new Map<string, Answers>();

function answersIn(cwd: string): Answers {
  let a = answers.get(cwd);
  if (!a) {
    // A dashboard serves a handful of projects: the answers of the latest few are kept.
    if (answers.size >= 16) answers.delete(answers.keys().next().value!);
    answers.set(cwd, (a = { has: new Map(), authors: new Map(), lacks: new Map(), parented: new Set(), parentless: new Map() }));
  }
  return a;
}

/** Forgets what git said, for a test that changes the repository between questions. */
export function forgetCommits(): void {
  answers.clear();
}

/** Asks git about the revisions it hasn't answered for lately: whether each is a commit here, its subject and its author. False when git can't say. */
async function ask(cwd: string, revs: readonly string[], now: number): Promise<boolean> {
  const a = answersIn(cwd);
  const wanted = revs.filter((r) => !a.has.has(r) && !(now - (a.lacks.get(r) ?? -Infinity) < MISSING_FOR_MS));
  if (!wanted.length) return true;
  // One line each, in order: "<sha> commit <size>", or "<rev> missing" (or "ambiguous").
  const out = await gitAsync(cwd, ['cat-file', '--batch-check'], { input: wanted.map((r) => `${r}^{commit}\n`).join(''), maxBuffer: 1024 * 1024 });
  if (out.code !== 0) return false;
  const lines = out.stdout.split('\n');
  const found: Array<{ rev: string; sha: string }> = [];
  wanted.forEach((rev, i) => {
    const sha = /^([0-9a-f]{40,64}) commit \d+$/.exec(lines[i] ?? '')?.[1];
    if (sha) found.push({ rev, sha });
    else a.lacks.set(rev, now);
  });
  const said = found.length ? await commitsOf(cwd, found.map((f) => f.sha)) : new Map<string, { subject: string; author: string }>();
  for (const f of found) {
    const c = said.get(f.sha);
    a.has.set(f.rev, c?.subject ?? null);
    if (c?.author) a.authors.set(f.rev, c.author);
    a.lacks.delete(f.rev);
  }
  return true;
}

/** Each commit's subject and its author's email, by its full name; none when git won't say. */
async function commitsOf(cwd: string, shas: readonly string[]): Promise<Map<string, { subject: string; author: string }>> {
  const out = await gitAsync(cwd, ['log', '--no-walk=unsorted', '--format=%H%x09%ae%x09%s', ...new Set(shas)]);
  const map = new Map<string, { subject: string; author: string }>();
  if (out.code !== 0) return map;
  for (const line of out.stdout.split('\n')) {
    const [sha, author, ...subject] = line.split('\t');
    if (sha && subject.length) map.set(sha, { subject: subject.join('\t').slice(0, 200), author: (author ?? '').slice(0, 200) });
  }
  return map;
}

/**
 * Which of these revisions are commits the project's git has. With a team store, a teammate's runs
 * name commits of their own checkout, which bisect can't start from here. Null when git can't say
 * (no git, not a repository): the choices stay as they are, and bisect says why it can't run.
 */
export async function commitsHere(cwd: string, revs: ReadonlyArray<string | null>, now = Date.now()): Promise<Set<string> | null> {
  const wanted = [...new Set(revs.filter((r): r is string => !!r && HEX.test(r)))];
  if (!wanted.length) return new Set();
  if (!(await ask(cwd, wanted, now))) return null;
  const has = answersIn(cwd).has;
  return new Set(wanted.filter((r) => has.has(r)));
}

/** The subjects of those of these revisions that are commits here, by revision (asked of git along with `commitsHere`). */
export async function commitSubjects(cwd: string, revs: ReadonlyArray<string | null>, now = Date.now()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const has = answersIn(cwd).has;
  for (const r of (await commitsHere(cwd, revs, now)) ?? []) {
    const subject = has.get(r);
    if (subject) out.set(r, subject);
  }
  return out;
}

/**
 * The authors of those of these revisions that are commits here, by revision: the email git has for
 * each commit's author, as Shadowlap names whoever records or tests (asked of git along with
 * `commitsHere`, so asked once with the subjects).
 */
export async function commitAuthors(cwd: string, revs: ReadonlyArray<string | null>, now = Date.now()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const authors = answersIn(cwd).authors;
  for (const r of (await commitsHere(cwd, revs, now)) ?? []) {
    const author = authors.get(r);
    if (author) out.set(r, author);
  }
  return out;
}

/**
 * Find the commit's choices without the commits this checkout doesn't have: the good one falls to
 * the newest one here where the runs didn't all fail, and the bad one to HEAD when the failure's own
 * commit isn't here. Each revision left is named by its subject in `subjects`.
 */
export function choicesHere(c: BisectChoices, here: ReadonlySet<string>, subjects: ReadonlyMap<string, string> = new Map()): BisectChoices {
  const revisions = c.revisions.filter((r) => here.has(r.rev)).map((r) => (subjects.has(r.rev) ? { ...r, subject: subjects.get(r.rev)! } : r));
  const bad = c.bad && here.has(c.bad) ? c.bad : null;
  // A run that failed only blame's check keeps its good end to be chosen: how other runs exited says nothing about it.
  const good = c.good && here.has(c.good) ? c.good : c.failed && !c.expect ? (revisions.find((r) => r.failed < r.runs)?.rev ?? null) : null;
  const ref = c.target.kind === 'golden' ? c.target.golden : c.target.runId;
  return { ...c, revisions, good, bad, args: good && !c.unavailable ? bisectArgs(ref, good, bad, c.fork, c.expect ?? null) : null };
}

/**
 * Whether a commit has no parent in this checkout, so bisect has nothing before it to search: it is
 * the repository's first, or the oldest commit a shallow clone has (`shallow`). False when it has a
 * parent; null when git can't say, or doesn't have the commit.
 */
export async function parentlessHere(cwd: string, rev: string, now = Date.now()): Promise<{ shallow: boolean } | false | null> {
  if (!HEX.test(rev)) return null;
  const a = answersIn(cwd);
  if (a.parented.has(rev)) return false;
  const known = a.parentless.get(rev);
  if (known && now - known.at < MISSING_FOR_MS) return { shallow: known.shallow };
  // "<sha> <parent> …" for the commit: its sha alone when it has none here.
  const out = await gitAsync(cwd, ['rev-list', '--parents', '--max-count=1', rev, '--']);
  if (out.code !== 0) return null;
  const words = out.stdout.trim().split(/\s+/);
  if (!words[0]) return null;
  if (words.length > 1) {
    a.parented.add(rev);
    return false;
  }
  const deep = await gitAsync(cwd, ['rev-parse', '--is-shallow-repository']);
  const shallow = deep.code === 0 && deep.stdout.trim() === 'true';
  a.parentless.set(rev, { shallow, at: now });
  return { shallow };
}

/**
 * A failure at a commit with no parent in this checkout (`parentlessHere`): bisect would look for a
 * good commit before it, and there is none, so no search is offered, and `unavailable` says why:
 * "01M5GS40V1 failed at the first commit, f6c5756: there is nothing before it to search" (`first`).
 */
async function atFirstCommit(root: string, c: BisectChoices): Promise<BisectChoices> {
  if (!c.failed || c.unavailable || !c.bad) return c;
  const first = await parentlessHere(root, c.bad);
  if (!first) return c;
  const what = c.target.kind === 'golden' ? c.target.golden : c.target.runId.slice(0, 10);
  return { ...c, good: null, args: null, first: true, unavailable: `${what} failed at ${first.shallow ? 'the oldest commit this checkout has' : 'the first commit'}, ${c.bad}: there is nothing before it to search` };
}

/**
 * A run's Find the commit as the project's checkout can run it: only commits this checkout has, and
 * no search from a failure at its first commit. As it is without a project folder, or when git
 * can't say.
 */
export async function choicesInCheckout(root: string | null | undefined, c: BisectChoices): Promise<BisectChoices> {
  if (!root) return c;
  const revs = [c.good, c.bad, ...c.revisions.map((r) => r.rev)];
  const here = await commitsHere(root, revs);
  return atFirstCommit(root, here ? choicesHere(c, here, await commitSubjects(root, revs)) : c);
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

/** The commits a golden's Find the commit dialog offers, those this checkout has, each with its subject. */
export function revisionsHere(revisions: readonly BisectRevision[], here: ReadonlySet<string>, subjects: ReadonlyMap<string, string>): BisectRevision[] {
  return revisions.filter((r) => here.has(r.rev)).map((r) => (subjects.has(r.rev) ? { ...r, subject: subjects.get(r.rev)! } : r));
}
