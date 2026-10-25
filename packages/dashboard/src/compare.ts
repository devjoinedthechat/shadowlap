import { execFile } from 'node:child_process';
import { compareRuns, type RunComparison, type Store } from '@shadowlap/engine';
import { compare, lookupRun } from './api.js';

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
  /**
   * The same commit on both sides, named by abbreviations of different lengths (`git rev-parse
   * --short` gives more digits as a repository grows, and machines differ): the code didn't change.
   */
  same?: true;
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
  // Commits only in a, and only in b: "0 3" means b is 3 commits after a. Counted in full (a cap could take
  // two long branches for one far ahead of the other); git gives up after the timeout, and the card says less.
  const counts = await git(cwd, ['rev-list', '--left-right', '--count', `${x.commit}...${y.commit}`]);
  const m = counts ? /^(\d+)\s+(\d+)\s*$/.exec(counts) : null;
  if (!m) return null;
  const onlyA = Number(m[1]);
  const onlyB = Number(m[2]);
  if (onlyA && onlyB) return { commits: null, newer: null, subjects: [], uncommitted: false };
  // Nothing on either side: one commit, abbreviated two ways (abc1234, abc12345).
  if (!onlyA && !onlyB) return x.dirty !== y.dirty ? { commits: 0, newer: null, subjects: [], uncommitted: true } : { commits: 0, newer: null, subjects: [], uncommitted: false, same: true };
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

/**
 * What Compare shows first while the whole comparison is worked out: the identical prefix and the
 * first request that differs, read from the two runs' calls as the store lists them (their identity
 * and the answer each got), and that one request of each read whole, so a long pair shows where it
 * parted in a moment where the whole comparison reads every model call's request of both (5 s at
 * 20,000 calls, 37 s at 100,000). The first difference is the engine's own, from those two calls.
 * Calls with the same request and another answer are counted, not described: the whole comparison
 * says what each got.
 */
export type CompareHead = Pick<RunComparison, 'a' | 'b' | 'identicalPrefix' | 'firstRequestDifference' | 'onlyInA' | 'onlyInB'> & {
  /** Before the first request that differs (or the end), the calls that got another answer to the same request. */
  answersDiffer: number;
};

/** The agent's calls of a run, in order (a judge check's left out, as the engine compares them), with the final answer each got. */
const HEAD_SQL = `
SELECT s.call_no AS n, s.kind AS kind, s.name AS name, s.fingerprint AS fp, e.response_ref AS ref, e.outcome AS outcome
FROM call_events s
LEFT JOIN call_events e ON e.run_id = s.run_id AND e.call_no = s.call_no AND e.phase = 'end'
  AND e.attempt = (SELECT MAX(x.attempt) FROM call_events x WHERE x.run_id = s.run_id AND x.call_no = s.call_no AND x.phase = 'end')
WHERE s.run_id = ? AND s.phase = 'start' AND json_extract(s.meta, '$.scope') IS NOT 'shadowlap:judge'
  AND s.attempt = (SELECT MAX(x.attempt) FROM call_events x WHERE x.run_id = s.run_id AND x.call_no = s.call_no AND x.phase = 'start')
ORDER BY s.call_no`;

export function compareHead(store: Store, a: string, b: string): CompareHead | null {
  const ra = lookupRun(store, a);
  const rb = lookupRun(store, b);
  if (!ra || !rb) return null;
  const xs = store.query(HEAD_SQL, ra.runId);
  const ys = store.query(HEAD_SQL, rb.runId);
  const n = Math.min(xs.length, ys.length);
  let identicalPrefix = 0;
  let intact = true;
  let answersDiffer = 0;
  let differs = -1;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    if (x.kind !== y.kind || x.name !== y.name || x.fp !== y.fp) {
      differs = i;
      break;
    }
    if ((x.ref ?? null) === (y.ref ?? null) && (x.outcome ?? null) === (y.outcome ?? null)) {
      if (intact) identicalPrefix++;
    } else {
      intact = false;
      answersDiffer++;
    }
  }
  let firstRequestDifference: CompareHead['firstRequestDifference'] = null;
  if (differs >= 0) {
    // The engine's own account of that difference, from those two calls read whole.
    const [x] = store.getCalls(ra.runId, { only: [Number(xs[differs]!.n)] });
    const [y] = store.getCalls(rb.runId, { only: [Number(ys[differs]!.n)] });
    if (x && y) firstRequestDifference = compareRuns(store, ra, [x], rb, [y]).firstRequestDifference;
  }
  return {
    a: { runId: ra.runId, calls: xs.length },
    b: { runId: rb.runId, calls: ys.length },
    identicalPrefix,
    firstRequestDifference,
    onlyInA: differs >= 0 ? 0 : Math.max(0, xs.length - n),
    onlyInB: differs >= 0 ? 0 : Math.max(0, ys.length - n),
    answersDiffer,
  };
}
