import { GATE_MAX_ATTEMPTS, keptMaxOf, openRunWhy, type DecisionsVerify, type SprtGate } from '@shadowlap/engine';

/**
 * Run more attempts on the runs verify left open whose gate ran out or that stopped first (`kind`
 * more), with each role's limit: a failing run's attempts (`max`) and a good run's pairs
 * (`keptMax`), null where no run of that role is open. Verify again (`again`, no limit raised) where
 * an attempt it could not judge left every open run so.
 */
export interface PreviewMore {
  kind: 'more' | 'again';
  runs: string[];
  max: number | null;
  keptMax: number | null;
}

/**
 * Run more attempts by Fixes' rule (`openRunWhy`): the runs verify left open, `only` that one where
 * given, each role's limit what it ran under (a failing run's the gate's max, a good run's pairs as
 * `keptMax`, the config's `verify.max`, or that gate gives them) or the attempts it took, doubled up
 * to 1000 only where a run of that role ran out. None once verify rejected the change, which more
 * attempts can't turn, for a verify decided by a fixed count, or with no limit to raise and nothing
 * stopped.
 */
export function moreOf(v: DecisionsVerify | null, gate: SprtGate | null, keptMax: number | null, only?: string): PreviewMore | null {
  if (!v || v.verdict === 'rejected') return null;
  const open = v.runs.flatMap((x) => {
    const why = only && x.runId !== only ? null : openRunWhy(x.outcome, x.undecided);
    return why ? [{ ...x, why }] : [];
  });
  if (!open.length) return null;
  if (open.every((x) => x.why === 'unjudged')) return { kind: 'again', runs: open.map((x) => x.runId), max: null, keptMax: null };
  if (!gate) return null;
  const taken = open.filter((x) => x.why !== 'unjudged');
  let raised = taken.some((x) => x.why === 'stopped');
  const limit = (good: boolean): number | null => {
    const of = taken.filter((x) => (x.role === 'good') === good);
    if (!of.length) return null;
    const ran = Math.max(good ? keptMaxOf(keptMax, gate) : gate.max, ...of.map((x) => x.attempts));
    const now = of.some((x) => x.why === 'ran-out') ? Math.min(GATE_MAX_ATTEMPTS, 2 * ran) : ran;
    raised ||= now > ran;
    return now;
  };
  const more: PreviewMore = { kind: 'more', runs: taken.map((x) => x.runId), max: limit(false), keptMax: limit(true) };
  return raised ? more : null;
}
