import { GATE_MAX_ATTEMPTS, keptMaxOf, openRunWhy, SPRT_DEFAULTS, verifyParts, type DecisionsVerify, type SprtGate } from '@shadowlap/engine';
import { gateArg } from './fix-shared.js';

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
  /** The flags its job adds to `decisions --verify` (`moreFlags`): none for Verify again. */
  flags: string[];
  /** The attempts its runs took so far, which don't carry over. */
  attempts: number;
  /** Its limits in verify's words (`up to 160 attempts a run`); empty for Verify again. */
  limit: string;
}

/**
 * Run more attempts' flags, as `decisions --verify` takes them: `--gate` with the figures the
 * session's verify was decided by and only its max raised, and a good run's pairs as `--kept-max`.
 * Its job and its dialog's command both read them here.
 */
export function moreFlags(gate: SprtGate | null, max: number | null | undefined, keptMax: number | null | undefined): string[] {
  const raised = typeof max === 'number' || typeof keptMax === 'number';
  const flags = raised ? gateArg({ ...(gate ?? { kind: 'sprt', ...SPRT_DEFAULTS }), ...(typeof max === 'number' ? { max } : {}) }, SPRT_DEFAULTS) : [];
  return [...flags, ...(typeof keptMax === 'number' ? ['--kept-max', String(keptMax)] : [])];
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
  const so = (runs: ReadonlyArray<{ attempts: number }>) => runs.reduce((n, x) => n + x.attempts, 0);
  if (open.every((x) => x.why === 'unjudged')) return { kind: 'again', runs: open.map((x) => x.runId), max: null, keptMax: null, flags: [], attempts: so(open), limit: '' };
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
  const max = limit(false);
  const kept = limit(true);
  if (!raised) return null;
  const words = verifyParts(max === null ? 0 : 1, kept === null ? 0 : 1, { failing: max ?? 0, good: kept ?? 0, unit: 'pairs' });
  return { kind: 'more', runs: taken.map((x) => x.runId), max, keptMax: kept, flags: moreFlags(gate, max, kept), attempts: so(taken), limit: words };
}
