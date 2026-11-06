import { attemptsOf, gateHistory, rateBound, testResultVerdict, type StoreOf, type Tally, type TestResult } from '@shadowlap/engine';
import { gitAsync, HEX } from './patch-in-tree.js';
import type { GoldenVerdict } from './tests.js';

/**
 * A golden's history on Tests: how it came out at each of the table's revisions, a cell each, with
 * what its hover says of it (the tally, the bound its gate put on the pass rate, and for a drop
 * against its own history what that history was). Read from the results the table's sessions kept,
 * by key: a drop's pooled sessions are read once per result, which never changes once kept. And what
 * git says of the revisions beside the server: each one's commit subject and author, and whether the
 * working tree has moved on since the session the verdict names.
 */

/** What a gate against history compared, where it failed a golden for a drop. */
export interface HistoryDrop {
  /** The baseline's pass rate. */
  baseline: number;
  /** The history it pooled; null when there was none, and the recording was the baseline. */
  history: (Tally & { sessions: number }) | null;
  /** Of the sessions it pooled, those that are this table's columns, with their attempts. */
  here: Tally & { sessions: number };
}

/** A golden at one revision: a cell of its history. */
export interface HistoryCell {
  revision: string | null;
  /**
   * Where the result shown was tested: the column's revision, or, for a golden run again on its own
   * (Add normalizer and re-run, Run tests on it) with changes on top, `<revision>+dirty`.
   */
  tested: string | null;
  /** Null: it wasn't a golden yet, or wasn't tested at that revision. An inconclusive result reads as `fail`: it didn't pass. */
  result: 'pass' | 'fail' | null;
  /** How it came out there, inconclusive told apart; null as for `result`. */
  verdict: GoldenVerdict | null;
  /** Its attempts there, passes of attempts: the pass rate a cell is shaded by. Null as for `result`, or when it couldn't run. */
  rate: Tally | null;
  /** The bound its gate put on the pass rate there, as the CLI prints it (`rate <= 0.87 (95%)`); null without a gate, or for a clean replay's one attempt. */
  bound: string | null;
  /** Its gate against history failed there: a drop from its baseline (a ring). */
  dropped: boolean;
  /** What that gate compared, for the hover; null where nothing dropped. */
  drop: HistoryDrop | null;
  /** Why it failed, for the hover. */
  note: string | null;
  /** `test --update` re-recorded it there (the ring). */
  updated: boolean;
  runId: string | null;
  at: number | null;
}

/** What the cells need of the screen's reads: tests.ts's own, handed in. */
export interface HistoryReads {
  /** The column a result shows in: its session's, or the revision's it ran at; undefined for none. */
  columnOf: (r: TestResult) => string | null | undefined;
  /** The sessions the columns are made of. */
  columns: ReadonlySet<string>;
  /** Why it failed, for the hover. */
  note: (r: TestResult) => string | null;
  /** The run to open, where the store still keeps it. */
  runId: (r: TestResult) => string | null;
}

/** A gate's bound on the pass rate where it decided from its attempts: none for a clean replay, which is the same every time. */
function boundOf(r: TestResult): string | null {
  const g = r.data?.gate;
  return g && !g.clean ? rateBound(g) : null;
}

/** The drops already read, by store and result: a result kept never changes. */
const drops = new WeakMap<object, Map<string, HistoryDrop | null>>();
/** How many a store keeps before it starts over: a table shows six revisions of each golden. */
const KEPT_DROPS = 2000;

/**
 * What a gate against history compared where it failed a golden: its baseline as the result kept it,
 * and which of the sessions it pooled are the table's columns, read again as the gate read them (its
 * window, its first attempts, before the result, the session itself left out). Null where no gate
 * against history failed it.
 */
function dropOf(store: StoreOf<'tests'>, r: TestResult, columns: ReadonlySet<string>): HistoryDrop | null {
  const g = r.data?.gate;
  if (g?.kind !== 'baseline' || g.decision !== 'fail' || g.evidence.kind !== 'baseline') return null;
  let kept = drops.get(store);
  if (!kept) drops.set(store, (kept = new Map<string, HistoryDrop | null>()));
  const key = `${r.sessionId}\n${r.golden}\n${r.at}`;
  if (kept.has(key)) return kept.get(key)!;
  const e = g.evidence;
  const history = e.history ? { passes: e.history.passes, attempts: e.history.attempts, sessions: e.history.sessions } : null;
  const pooled = history
    ? gateHistory(store, r.golden, {
        window: g.window,
        first: g.min,
        before: r.at,
        excludeSession: r.sessionId,
        goldenRunId: r.goldenRunId,
        checks: (r.data?.checks ?? []).map((c) => c.label),
        ...(r.data?.mode ? { mode: r.data.mode } : {}),
        ...(r.data?.baselineBranch !== undefined ? { branch: r.data.baselineBranch } : {}),
      }).pooled.filter((s) => columns.has(s.sessionId))
    : [];
  const drop: HistoryDrop = { baseline: e.baseline, history, here: { sessions: pooled.length, passes: pooled.reduce((n, s) => n + s.passes, 0), attempts: pooled.reduce((n, s) => n + s.attempts, 0) } };
  if (kept.size >= KEPT_DROPS) kept.clear();
  kept.set(key, drop);
  return drop;
}

/**
 * A golden's cells, one for each revision of the table (`revisions`, oldest first), from its results
 * newest first (`list`): the newest result in each column, ringed when any session there updated
 * it, so a run after the update keeps the ring.
 */
export function historyCells(store: StoreOf<'tests'>, list: readonly TestResult[], revisions: ReadonlyArray<string | null>, o: HistoryReads): HistoryCell[] {
  return revisions.map((rev) => {
    // Its own column's sessions, and a session that ran only some goldens there, or on that commit
    // with changes on top (Add normalizer and re-run), where no column is its own.
    const here = list.filter((x) => o.columnOf(x) === rev);
    const r = here[0] ?? null;
    const dropped = !!r && r.data?.gate?.kind === 'baseline' && r.data.gate.decision === 'fail';
    return {
      revision: rev,
      tested: r?.revision ?? null,
      result: r ? (r.ok ? 'pass' : 'fail') : null,
      verdict: r ? testResultVerdict(r) : null,
      rate: r ? attemptsOf(r) : null,
      bound: r ? boundOf(r) : null,
      dropped,
      drop: r && dropped ? dropOf(store, r, o.columns) : null,
      note: r ? o.note(r) : null,
      updated: here.some((x) => !!x.data?.updated),
      runId: r ? o.runId(r) : null,
      at: r?.at ?? null,
    };
  });
}

/** A revision of the table as git has it: its commit's subject, and its author where names show. */
export interface RevisionFact {
  rev: string | null;
  subject: string | null;
  /** The commit author's email, only where a team store is configured (names show only where shared). */
  by: string | null;
}

/** A revision's commit: `abc1234+dirty` was tested with changes on top of abc1234. */
const commitOf = (rev: string | null): string | null => (rev ? rev.replace(/\+dirty$/, '') : null);

/** The commits the table's revisions want git's word on. */
export const revisionCommits = (revisions: ReadonlyArray<string | null>): string[] => [...new Set(revisions.map(commitOf).filter((c): c is string => !!c && HEX.test(c)))];

/** Each of the table's revisions with its commit's subject, and its author where names show (`shared`). */
export function withRevisionFacts<T extends { revisions: ReadonlyArray<string | null> }>(view: T, subjects: ReadonlyMap<string, string>, authors: ReadonlyMap<string, string>, shared: boolean): T & { revisionFacts: RevisionFact[] } {
  const revisionFacts = view.revisions.map((rev) => {
    const commit = commitOf(rev);
    return { rev, subject: commit ? (subjects.get(commit) ?? null) : null, by: shared && commit ? (authors.get(commit) ?? null) : null };
  });
  return { ...view, revisionFacts };
}

/** The working tree as git sees it against a commit: tracked changes in it, and a later commit checked out. */
export interface TreeNow {
  dirty: boolean;
  later: boolean;
}

/**
 * Whether a session's verdict is older than the working tree: it ended, it tested a clean commit,
 * and the tree has changed since, by a change to a tracked file (a normalizer added, a fix applied,
 * a commit reverted) or a later commit. Never for a session still running, one that tested changes
 * on top (`+dirty`), or when git can't say (`tree` null).
 */
export function olderThanTree(session: { revision: string | null; endedAt: number | null } | null | undefined, tree: TreeNow | null): boolean {
  if (!session || session.endedAt === null || !session.revision || !HEX.test(session.revision) || !tree) return false;
  return tree.dirty || tree.later;
}

/** How long git's word on a working tree stands: Tests is read again every few seconds while anything moves. */
const TREE_FOR_MS = 5000;
const trees = new Map<string, { at: number; tree: TreeNow | null }>();

/**
 * The working tree at `root` against commit `rev`, asked of git beside the server and kept a few
 * seconds: null when git can't say (no git, not a repository, a commit it lacks).
 */
export async function treeNow(root: string, rev: string, now = Date.now()): Promise<TreeNow | null> {
  if (!HEX.test(rev)) return null;
  const key = `${root}\n${rev}`;
  const kept = trees.get(key);
  if (kept && now - kept.at < TREE_FOR_MS) return kept.tree;
  const [status, head, ancestor] = await Promise.all([gitAsync(root, ['status', '--porcelain', '--untracked-files=no']), gitAsync(root, ['rev-parse', 'HEAD', `${rev}^{commit}`]), gitAsync(root, ['merge-base', '--is-ancestor', rev, 'HEAD'])]);
  const [headSha, revSha] = head.stdout.split('\n');
  const tree = status.code === 0 && head.code === 0 && headSha && revSha && (ancestor.code === 0 || ancestor.code === 1) ? { dirty: status.stdout.trim() !== '', later: headSha !== revSha && ancestor.code === 0 } : null;
  if (trees.size > 100) trees.clear();
  trees.set(key, { at: now, tree });
  return tree;
}
