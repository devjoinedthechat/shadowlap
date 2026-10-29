import { compareFork, forkEnd, RANK_LABELS, type DecisionRank, type ForkChange as ComparedChange, type ForkEnd as ComparedEnd, type ForkWrite as ComparedWrite, type Normalizer, type StoreOf } from '@shadowlap/engine';
import { lookupRun } from './api.js';
import { links } from './links.js';
import { loadRunIndex, type IndexedRun } from './run-index.js';

/**
 * What a fork did differently from the run it forked from, from the call it left that run at on, for
 * `GET /api/runs/:id/differences`: the engine's comparison (compareFork, which the terminal UI shows
 * too), with how each run ended as the run lists count it (the run index) and a link to each call.
 * Every change is ranked as `shadowlap decisions` ranks a changed decision: a write first, then how
 * the run ended, then reads added or removed, reads asked differently, and the words of its last
 * answer. Arguments and words are compared after the project's normalizers.
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
