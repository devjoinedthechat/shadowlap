import type { GoldenRow } from '../api.js';
import { IntervalBar } from '../components/Verdict.js';

/** A golden's last gate, where it decided the result. */
export type GateShown = NonNullable<GoldenRow['last']['gate']>;

/** A gate decided it from its attempts (not a clean replay's one, which is the same every time): its line is a tally and a bound. */
export const gated = (g: GoldenRow['last']['gate']): g is GateShown => !!g && !g.clean;

/** Two places, as a rate reads beside a bar: `.70`. */
const rate2 = (x: number) => x.toFixed(2).replace(/^0(?=\.)/, '');

/**
 * Under a gated golden's line, what its attempts show (decision 9): the pass rate's interval, exact
 * under the gate's stopping, against the gate's two rates, or against the baseline and the drop that
 * fails it, in the verdict's colour; pass^k and the tally's sentence on hover. Its confidence reads
 * rounded down, as the verdict line's does, so it never says more than the gate worked out.
 */
export function GateEvidence({ g, verdict }: { g: GateShown; verdict: GoldenRow['last']['verdict'] }) {
  const baseline = g.kind === 'baseline' && g.evidence.kind === 'baseline' ? { at: g.evidence.baseline, drop: g.drop } : null;
  const marks = g.kind === 'sprt' ? [g.bad, g.good] : baseline ? [baseline.at - baseline.drop, baseline.at] : [];
  const against = g.kind === 'sprt' ? `against ${rate2(g.bad)} and ${rate2(g.good)}` : 'against its baseline';
  const why = `The pass rate's ${+(Math.floor(+(g.interval.confidence * 1000).toPrecision(12)) / 10)}% interval, ${against}${baseline ? ` (${rate2(baseline.at)}, less a drop of ${Math.round(baseline.drop * 100)} points)` : ''}`;
  return (
    <span className="gev" data-tip={JSON.stringify({ t: g.tally, s: why })}>
      <IntervalBar lo={g.interval.lo} hi={g.interval.hi} marks={marks} tone={verdict === 'passed' ? 'ok' : verdict === 'inconclusive' ? 'y' : 'no'} />
      <small>{against}</small>
    </span>
  );
}
