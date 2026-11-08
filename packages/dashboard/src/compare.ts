import { execFile } from 'node:child_process';
import { compareRuns, type Normalizer, type RunComparison, type RunRecord, type StoreOf } from '@shadowlap/engine';
import { lookupRun } from './api.js';
import { pairDifferences, type PairDifferences } from './fork-differences.js';

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

/** Two runs compared call by call, with what B decided differently from A after the calls they share (`pair`; null when a run isn't in the run index). */
export type ComparedPair = RunComparison & { pair: PairDifferences | null };

export type CompareView = ComparedPair & {
  /** What the code card says; null when the revisions are the same, unknown, or not in this checkout. */
  code: CodeChange | null;
};

/**
 * Two runs compared call by call (the engine's compareRuns) and as decisions after the calls they
 * share (pairDifferences), each run's calls read once for both; null when one of them is not in the
 * store. Arguments and words are compared after `normalizers`, the project's matching rules.
 */
export function comparePairOf(store: StoreOf<'recording' | 'readModels' | 'tests'>, a: string, b: string, normalizers: readonly Normalizer[] = []): ComparedPair | null {
  const ra = lookupRun(store, a);
  const rb = lookupRun(store, b);
  if (!ra || !rb) return null;
  const calls = { a: store.getCalls(ra.runId), b: store.getCalls(rb.runId) };
  const c = compareRuns(store, ra, calls.a, rb, calls.b);
  return { ...c, pair: pairDifferences(store, ra, rb, c.identicalPrefix, { normalizers, calls }) };
}

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
export async function compareView(store: StoreOf<'recording' | 'readModels' | 'tests'>, a: string, b: string, o: { cwd: string | null; normalizers?: readonly Normalizer[]; code?: (cwd: string | null, a: string | null, b: string | null) => Promise<CodeChange | null> }): Promise<CompareView | null> {
  const c = comparePairOf(store, a, b, o.normalizers);
  if (!c) return null;
  const code = await (o.code ?? readCodeChange)(o.cwd, c.changes.code.a, c.changes.code.b);
  return { ...c, code };
}

/**
 * What Compare shows first while the whole comparison is worked out: the identical prefix and the
 * first request that differs, read from the two runs' calls as the store lists them (their identity,
 * the answer each got, and the recorded call a replay's was served from), and a request read whole
 * only where that can't tell, so a long pair shows where it parted in a moment where the whole
 * comparison reads every model call's request of both (5 s at 20,000 calls, 37 s at 100,000). The
 * first difference is the engine's own, from those two calls. Calls with the same request and another
 * answer are counted, not described: the whole comparison says what each got.
 */
export type CompareHead = Pick<RunComparison, 'a' | 'b' | 'identicalPrefix' | 'firstRequestDifference' | 'onlyInA' | 'onlyInB'> & {
  /** Before the first request that differs (or the end), the calls that got another answer to the same request. */
  answersDiffer: number;
};

/**
 * The agent's calls of a run, in order (a judge check's left out, as the engine compares them), with
 * the final answer each got and the parent's call it was served from (a replay's, or a flag's result).
 */
const HEAD_SQL = `
SELECT s.call_no AS n, s.kind AS kind, s.name AS name, s.fingerprint AS fp, e.response_ref AS ref, e.outcome AS outcome,
  e.meta ->> '$.replayedFrom' AS rf, e.meta ->> '$.overriddenFrom' AS ov
FROM call_events s
LEFT JOIN call_events e ON e.run_id = s.run_id AND e.call_no = s.call_no AND e.phase = 'end'
  AND e.attempt = (SELECT MAX(x.attempt) FROM call_events x WHERE x.run_id = s.run_id AND x.call_no = s.call_no AND x.phase = 'end')
WHERE s.run_id = ? AND s.phase = 'start' AND json_extract(s.meta, '$.scope') IS NOT 'shadowlap:judge'
  AND s.attempt = (SELECT MAX(x.attempt) FROM call_events x WHERE x.run_id = s.run_id AND x.call_no = s.call_no AND x.phase = 'start')
ORDER BY s.call_no`;

/**
 * How many pairs of calls the head reads whole, at most: two calls whose fingerprints differ, neither
 * served from the other, ask the same when nothing they sent differs (runs fingerprinted under
 * another normalizer list, or another fingerprint version), which only their requests tell. Past it
 * the head is left to the whole comparison, which reads every request anyway.
 */
export const HEAD_READS = 16;

/**
 * Compare's head for runs `a` and `b`; null when a run is not in the store, or when telling it would
 * mean reading more than HEAD_READS pairs of requests whole.
 */
export function compareHead(store: StoreOf<'recording' | 'readModels'>, a: string, b: string): CompareHead | null {
  const ra = lookupRun(store, a);
  const rb = lookupRun(store, b);
  if (!ra || !rb) return null;
  const xs = store.query(HEAD_SQL, ra.runId);
  const ys = store.query(HEAD_SQL, rb.runId);
  // A call of `child` served from `p`, the call of its parent at hand: the same request, as the engine has it.
  const served = (child: RunRecord, c: (typeof xs)[number], parent: RunRecord, p: (typeof xs)[number]) =>
    child.parentRunId === parent.runId && (Number(c.rf ?? NaN) === Number(p.n) || Number(c.ov ?? NaN) === Number(p.n));
  // The engine's own account of how the two calls at `i` ask: read whole, and null when the same.
  const whole = (i: number) => {
    const [x] = store.getCalls(ra.runId, { only: [Number(xs[i]!.n)] });
    const [y] = store.getCalls(rb.runId, { only: [Number(ys[i]!.n)] });
    return x && y ? compareRuns(store, ra, [x], rb, [y]).firstRequestDifference : null;
  };
  const n = Math.min(xs.length, ys.length);
  let identicalPrefix = 0;
  let intact = true;
  let answersDiffer = 0;
  let reads = 0;
  let differs = -1;
  let firstRequestDifference: CompareHead['firstRequestDifference'] = null;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    if (x.kind !== y.kind || x.name !== y.name) {
      differs = i;
      firstRequestDifference = whole(i);
      break;
    }
    if (x.fp !== y.fp && !served(rb, y, ra, x) && !served(ra, x, rb, y)) {
      if (++reads > HEAD_READS) return null;
      firstRequestDifference = whole(i);
      if (firstRequestDifference) {
        differs = i;
        break;
      }
    }
    if ((x.ref ?? null) === (y.ref ?? null) && (x.outcome ?? null) === (y.outcome ?? null)) {
      if (intact) identicalPrefix++;
    } else {
      intact = false;
      answersDiffer++;
    }
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
