import { execFile } from 'node:child_process';
import type { RunComparison, Store } from '@shadowlap/engine';
import { compare } from './api.js';

/**
 * Compare's read model (`GET /api/compare?a=&b=`): the engine's comparison of two runs, call by call,
 * and what the code card says about the code between them, read from the project's git: how many
 * commits lie between the two revisions and the newest one's subject ("harness: pass refund_limit
 * through"), when this checkout has both. Revisions come from runs, which may come from anyone (a
 * teammate's pull, a pack), so only a commit's hex name is ever handed to git.
 */

export interface CodeChange {
  /** The commits between the two revisions, when this checkout has both and one follows the other; null otherwise. */
  commits: number | null;
  /** Which run's revision is the newer: comparing a run with an older one reads the change backwards. */
  newer: 'a' | 'b' | null;
  /** The subjects of those commits, newest first, at most ten. */
  subjects: string[];
  /** The same commit on both sides, and only uncommitted changes (`+dirty`) differ. */
  uncommitted: boolean;
}

export type CompareView = RunComparison & {
  /** What the code card says; null when the revisions are the same, unknown, or not in this checkout. */
  code: CodeChange | null;
};

/** How long what git said about two revisions is reused: a fetch can bring them in. */
const CODE_TTL_MS = 60_000;
/** Commits counted between two revisions; past it, the card says "1000+". */
export const COMMITS_CAP = 1000;
const SUBJECTS = 10;

const HEX = /^[0-9a-f]{4,64}$/i;

/** A run's revision as `codeVersion` keeps it: a commit, `+dirty` when the tree had uncommitted changes. */
export function parseRevision(v: string | null | undefined): { commit: string; dirty: boolean } | null {
  if (!v) return null;
  const m = /^([0-9a-f]{4,64})(\+dirty)?$/i.exec(v.trim());
  return m ? { commit: m[1]!, dirty: !!m[2] } : null;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/**
 * What git says about the code between two runs' revisions, or null: the same revision, a revision
 * that isn't a commit name, a folder that isn't a repository, or commits this checkout doesn't have.
 * Branches that went separate ways have no "between": the card says only that they differ.
 */
export async function readCodeChange(cwd: string | null, a: string | null | undefined, b: string | null | undefined): Promise<CodeChange | null> {
  const x = parseRevision(a);
  const y = parseRevision(b);
  if (!cwd || !x || !y || (a ?? '') === (b ?? '')) return null;
  const sameCommit = x.commit.toLowerCase() === y.commit.toLowerCase();
  if (sameCommit) return { commits: 0, newer: null, subjects: [], uncommitted: true };
  if (!HEX.test(x.commit) || !HEX.test(y.commit)) return null;
  // Commits only in a, and only in b: "0 3" means b is 3 commits after a.
  const counts = await git(cwd, ['rev-list', '--left-right', '--count', `--max-count=${COMMITS_CAP}`, `${x.commit}...${y.commit}`]);
  const m = counts ? /^(\d+)\s+(\d+)\s*$/.exec(counts) : null;
  if (!m) return null;
  const onlyA = Number(m[1]);
  const onlyB = Number(m[2]);
  if (onlyA && onlyB) return { commits: null, newer: null, subjects: [], uncommitted: false };
  if (!onlyA && !onlyB) return { commits: 0, newer: null, subjects: [], uncommitted: x.dirty !== y.dirty };
  const [from, to, newer] = onlyB ? [x.commit, y.commit, 'b' as const] : [y.commit, x.commit, 'a' as const];
  const log = await git(cwd, ['log', `-n${SUBJECTS}`, '--format=%s', `${from}..${to}`]);
  const subjects = (log ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.length > 120 ? `${s.slice(0, 119)}…` : s));
  return { commits: Math.min(onlyA + onlyB, COMMITS_CAP), newer, subjects, uncommitted: false };
}

/** Remembers what git said about pairs of revisions for a minute, per folder. */
export function codeChangeCache(read: typeof readCodeChange = readCodeChange): (cwd: string | null, a: string | null, b: string | null) => Promise<CodeChange | null> {
  const known = new Map<string, { at: number; value: Promise<CodeChange | null> }>();
  return (cwd, a, b) => {
    const key = `${cwd ?? ''}\n${a ?? ''}\n${b ?? ''}`;
    const now = Date.now();
    const hit = known.get(key);
    if (hit && now - hit.at < CODE_TTL_MS) return hit.value;
    const value = read(cwd, a, b);
    known.set(key, { at: now, value });
    if (known.size > 200) known.delete(known.keys().next().value!);
    return value;
  };
}

/** Two runs compared, with what the code card says; null when one of them is not in the store. */
export async function compareView(store: Store, a: string, b: string, o: { cwd: string | null; code?: (cwd: string | null, a: string | null, b: string | null) => Promise<CodeChange | null> }): Promise<CompareView | null> {
  const c = compare(store, a, b);
  if (!c) return null;
  const code = await (o.code ?? readCodeChange)(o.cwd, c.changes.code.a, c.changes.code.b);
  return { ...c, code };
}
