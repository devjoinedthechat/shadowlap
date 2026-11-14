import { compareFork, forkEnd, pairDecisions, RANK_LABELS, type CallRecord, type DecisionRank, type ForkChange as ComparedChange, type ForkEnd as ComparedEnd, type ForkWrite as ComparedWrite, type Normalizer, type PairChange as ComparedPairChange, type PairEnding, type PairVerdict, type PathRow, type RunRecord, type StoreOf } from '@shadowlap/engine';
import { lookupRun } from './api.js';
import { exitCodes } from './exit-codes.js';
import { links } from './links.js';
import { loadRunIndex, type IndexedRun } from './run-index.js';

/**
 * What a fork did differently from the run it forked from, from the call it left that run at on, for
 * `GET /api/runs/:id/differences`: the engine's comparison (compareFork, which the terminal UI shows
 * too), with how each run ended as the run lists count it (the run index) and a link to each call.
 * Every change is ranked as `shadowlap decisions` ranks a changed decision: a write first, then how
 * the run ended, then reads added or removed, reads asked differently, and the words of its last
 * answer. Arguments and words are compared after the project's normalizers.
 *
 * Compare asks the same of any two runs (pairDifferences): what B decided differently from A after
 * the calls they share, its verdict, how each side ended, and both paths call by call.
 */

export type { ForkChangeKind } from '@shadowlap/engine';

export interface ForkChange extends Omit<ComparedChange, 'parentCallNo' | 'forkCallNo'> {
  /** Where each side is: the call in the parent's run and in the fork's, when it is a call. */
  parent: { callNo: number; href: string } | null;
  fork: { callNo: number; href: string } | null;
}

export interface ForkEnd extends Omit<ComparedEnd, 'tone'> {
  tone: 'ok' | 'err' | 'warn' | 'n';
}

export interface ForkWrite extends ComparedWrite {
  href: string;
}

export interface ForkDifferences {
  runId: string;
  parentRunId: string;
  /** The call the fork left its parent at: everything before it replayed as recorded. */
  from: number;
  /** The most consequential change, or null when the fork did as its parent did. */
  rank: DecisionRank | null;
  /** Each change, most consequential first. */
  changes: ForkChange[];
  ended: { parent: ForkEnd; fork: ForkEnd };
  /** The fork's writes from where it left its parent on, in order. */
  writes: ForkWrite[];
  /** The tool calls each run made from there, as compared. */
  toolCalls: { parent: number; fork: number };
  /** True when a run made more tool calls from there than are compared (`MAX_TOOL_CALLS`). */
  cut: boolean;
  /** What each rank means, as `decisions` words it. */
  ranks: Record<DecisionRank, string>;
}

/** How a run ended, as its row in the run index counts it. */
const endOf = (r: IndexedRun): ComparedEnd => forkEnd(r.status, r.outcome, r.failed);
/** An end in the page's tones: one neither good nor bad is `n`. */
const shown = (e: ComparedEnd): ForkEnd => ({ ...e, tone: e.tone ?? 'n' });

/**
 * What the fork `idOrPrefix` did differently from its parent; null for a run that isn't a fork of a
 * run in the store (a recording, a clean replay, a fork whose parent was deleted).
 */
export function forkDifferences(store: StoreOf<'recording' | 'readModels'>, idOrPrefix: string, options: { normalizers?: readonly Normalizer[] } = {}): ForkDifferences | null {
  const run = lookupRun(store, idOrPrefix);
  if (!run || run.mode !== 'replay' || !run.parentRunId || !run.divergence) return null;
  const parent = store.getRun(run.parentRunId);
  if (!parent) return null;
  const index = loadRunIndex(store);
  const ownRow = index.byId.get(run.runId);
  const parentRow = index.byId.get(parent.runId);
  if (!ownRow || !parentRow) return null;
  const compared = compareFork(store, run, parent, { parent: endOf(parentRow), fork: endOf(ownRow) }, options);
  if (!compared) return null;
  const changes: ForkChange[] = compared.changes.map(({ parentCallNo, forkCallNo, ...c }) => ({
    ...c,
    parent: parentCallNo !== null ? { callNo: parentCallNo, href: links.run(parent.runId, parentCallNo) } : null,
    fork: forkCallNo !== null ? { callNo: forkCallNo, href: links.run(run.runId, forkCallNo) } : null,
  }));
  return {
    runId: run.runId,
    parentRunId: parent.runId,
    from: compared.from,
    rank: changes[0]?.rank ?? null,
    changes,
    ended: { parent: shown(compared.ended.parent), fork: shown(compared.ended.fork) },
    writes: compared.writes.map((w) => ({ ...w, href: links.run(run.runId, w.callNo) })),
    toolCalls: compared.toolCalls,
    cut: compared.cut,
    ranks: RANK_LABELS,
  };
}

/** A change between two runs, B read against A, with a link to the call it is about on each side. */
export interface PairChange extends Omit<ComparedPairChange, 'aCallNo' | 'bCallNo'> {
  a: { callNo: number; href: string } | null;
  b: { callNo: number; href: string } | null;
}

/** What run B decided differently from run A after the calls they share, for Compare (`pair` in `GET /api/compare`). */
export interface PairDifferences {
  /** The first call after the identical prefix in each run. */
  from: { a: number; b: number };
  /** `Different writes after #18`, and its tone; null where no call follows the prefix, or while a run records. */
  verdict: PairVerdict | null;
  /** The most consequential change, or null when B decided as A did. */
  rank: DecisionRank | null;
  /** Each change, most consequential first. */
  changes: PairChange[];
  /** How each run ended, as the run lists count it: a change of how they end says both. */
  ended: { a: ForkEnd; b: ForkEnd };
  /** What each did after the calls they share: its HTTP failures, its writes by what became of them, how its turn ended. */
  endings: { a: PairEnding; b: PairEnding };
  /** True when a run made more tool calls from there than are compared. */
  cut: boolean;
  /** Both paths after the prefix, a row a call, at most `PATH_ROWS`. */
  rows: PathRow[];
  /** The rows left out past them. */
  more: number;
  ranks: Record<DecisionRank, string>;
}

/**
 * What run `b` decided differently from run `a` after the `identicalPrefix` calls they share
 * (compareRuns counts them): any two runs, ranked as a fork against its parent is, with how each
 * ended from the run index. Null when either run isn't in the store's index.
 */
export function pairDifferences(store: StoreOf<'recording' | 'readModels' | 'tests'>, a: RunRecord, b: RunRecord, identicalPrefix: number, options: { normalizers?: readonly Normalizer[]; calls?: { a: CallRecord[]; b: CallRecord[] } } = {}): PairDifferences | null {
  const index = loadRunIndex(store);
  const rowA = index.byId.get(a.runId);
  const rowB = index.byId.get(b.runId);
  if (!rowA || !rowB) return null;
  const codes = exitCodes(store, [a, b].map((r) => ({ runId: r.runId, status: r.status, test: r.meta?.test ?? null })));
  const p = pairDecisions(store, a, b, identicalPrefix, { a: endOf(rowA), b: endOf(rowB) }, { ...options, exitCodes: { a: codes.get(a.runId) ?? null, b: codes.get(b.runId) ?? null } });
  const link = (run: RunRecord, callNo: number | null) => (callNo !== null ? { callNo, href: links.run(run.runId, callNo) } : null);
  const c = p.comparison;
  return {
    from: p.from,
    verdict: p.verdict,
    rank: c.changes[0]?.rank ?? null,
    changes: c.changes.map(({ aCallNo, bCallNo, ...change }) => ({ ...change, a: link(a, aCallNo), b: link(b, bCallNo) })),
    ended: { a: shown(c.ended.a), b: shown(c.ended.b) },
    endings: p.endings,
    cut: c.cut,
    rows: p.rows,
    more: p.more,
    ranks: RANK_LABELS,
  };
}
