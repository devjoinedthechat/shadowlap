import { clipText, compareFork, forkEnd, RANK_LABELS, type CallRecord, type DecisionRank, type ForkEnd as RunEnd, type ForkWrite, type Normalizer, type RunRecord, type StoreOf } from '@shadowlap/engine';
import { outcomeFor, type Tone } from './verdict.js';

/**
 * What a fork did differently from its parent, from the call it forked at on: the engine's comparison
 * (compareFork, fork-changes.ts), which the dashboard's fork banner shows too, in the terms the diff
 * tab draws it in: each change and each run's end with its tone, and each run's last words clipped.
 */
export interface ForkChange {
  rank: DecisionRank;
  detail: string;
  before: string | null;
  after: string | null;
  /**
   * Its colour, as the dashboard's fork banner ranks a change: a write's in the write colour
   * (`write`); a stop or a hand-over that changed amber, a look; how the two ended in its own tone;
   * anything else in ink (`info`).
   */
  tone: Tone | 'write';
}

export interface ForkEnd {
  words: string;
  failed: boolean;
  tone: Tone;
}

export type { ForkWrite };

export interface ForkEffects {
  /** The highest-ranked change, in `shadowlap decisions`' words: `a write changed`. */
  most: string | null;
  changes: ForkChange[];
  ended: { parent: ForkEnd; fork: ForkEnd };
  writes: ForkWrite[];
  words: { parent: string | null; fork: string | null };
  /** True when a run made more tool calls from the fork on than are compared. */
  cut: boolean;
}

/** An end as the engine words it (forkEnd), its tone for the pane: one neither good nor bad is `info`. */
const toned = (e: RunEnd): ForkEnd => ({ words: e.words, failed: e.failed, tone: e.tone ?? 'info' });

/** What the fork did differently; null for a run that isn't a fork of a run in the store. */
export function forkEffects(store: StoreOf<'recording'>, run: RunRecord, calls: CallRecord[], normalizers: readonly Normalizer[] = []): ForkEffects | null {
  if (run.mode !== 'replay' || !run.parentRunId || !run.divergence) return null;
  const parent = store.getRun(run.parentRunId);
  if (!parent) return null;
  const ended = { parent: forkEnd(parent.status, outcomeFor(store, parent, store.getCalls(parent.runId))), fork: forkEnd(run.status, outcomeFor(store, run, calls)) };
  const compared = compareFork(store, run, parent, ended, { normalizers });
  if (!compared) return null;
  // How the two ended, as a change: red when the fork fails where its parent did not, green the other way round.
  const endTone: Tone = ended.fork.failed && !ended.parent.failed ? 'err' : ended.parent.failed && !ended.fork.failed ? 'ok' : 'info';
  // Rank 1 is a write that changed and rank 2 how the run stops or hands over, which the dashboard tags in the write colour and in amber; how the two ended takes its own tone.
  const changes = compared.changes.map((c): ForkChange => ({ rank: c.rank, detail: c.detail, before: c.before, after: c.after, tone: c.kind === 'ended' ? endTone : c.rank === 1 ? 'write' : c.rank === 2 ? 'warn' : 'info' }));
  const { words } = compared;
  return {
    most: changes.length ? RANK_LABELS[changes[0]!.rank] : null,
    changes,
    ended: { parent: toned(compared.ended.parent), fork: toned(compared.ended.fork) },
    writes: compared.writes,
    words: { parent: words.parent ? clipText(words.parent, 160) : null, fork: words.fork ? clipText(words.fork, 160) : null },
    cut: compared.cut,
  };
}
