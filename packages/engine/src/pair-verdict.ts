import type { DecisionRank } from './decisions.js';

/**
 * Compare's verdict on two runs, from what one did differently from the other after the calls they
 * share (fork-changes.ts `comparePair`), ranked as `shadowlap decisions` ranks a changed decision: a
 * write first, then how a run ended, then its reads, then its words. A side that quit (it exited,
 * or stopped on an HTTP failure, with no model call answered after the shared calls) puts the
 * endings first where the two ended otherwise: its writes differ because it stopped, not because it
 * decided otherwise. Words only, so the dashboard and the CLI can say it alike.
 */

export type PairVerdictWords = 'Different writes' | 'Different endings' | 'Different reads' | 'Different words' | 'The same decisions';

export interface PairVerdict {
  words: PairVerdictWords;
  /** Where the two runs part: `after #18`, the last call they share, or `from #1` where they share none. */
  where: string;
  /** The verdict's tone, as a verdict line draws it: a write red, an ending amber, the rest in ink. */
  tone: 'err' | 'warn' | 'done';
}

export interface PairVerdictInput {
  /** The most consequential change between the two (fork-changes.ts), or null when they decided alike. */
  rank: DecisionRank | null;
  /** Either side quit: it exited, or stopped on an HTTP failure, with no model call answered after the shared calls. */
  quit: boolean;
  /** How the two turns ended differs: answered, stopped on a failure, exited (with its code), or ended. */
  endsDiffer: boolean;
  /** The calls the two share from the start, the same request and the same answer. */
  identicalPrefix: number;
}

const counted = (n: number): string => (n >= 1000 ? n.toLocaleString('en-US') : String(n));

/** The verdict's words, its tone and where the runs part. */
export function pairVerdict(o: PairVerdictInput): PairVerdict {
  const where = o.identicalPrefix ? `after #${counted(o.identicalPrefix)}` : 'from #1';
  const said = (words: PairVerdictWords, tone: PairVerdict['tone']): PairVerdict => ({ words, where, tone });
  if (o.endsDiffer && o.quit) return said('Different endings', 'warn');
  if (o.rank === 1) return said('Different writes', 'err');
  if (o.rank === 2 || o.endsDiffer) return said('Different endings', 'warn');
  if (o.rank === 3 || o.rank === 4) return said('Different reads', 'done');
  if (o.rank === 5) return said('Different words', 'done');
  return said('The same decisions', 'done');
}
