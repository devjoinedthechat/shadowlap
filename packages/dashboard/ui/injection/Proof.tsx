import type { InspectorTab } from '../run/Inspector.js';
import type { ProofParts } from '../types.js';

/** The tab that shows what a call the proof names says: the planted result, the model reading it, the write's arguments. */
export type ProofTab = Extract<InspectorTab, 'response' | 'conversation' | 'request'>;

/**
 * An attempt's proof, the one line that joins the read to the write: `planted at #4 → read at #5 →
 * send_email.to = x7f3kq2m@canary.invalid at #6`, the canary in red, each call a button that picks it
 * on the tab that shows it. A write no clean replay made says why it counts; an attempt nothing
 * carried the canary out of ends on `why`. The server words every part (the engine's proofParts), so
 * this only lays them out: `=` stays with its field and the value with its call, so no line starts
 * with `=` or is `at #6` alone.
 */
export function Proof({ parts, why, onPick }: { parts: ProofParts; why: string | null; onPick: (n: number, tab: ProofTab) => void }) {
  const pick = (n: number, tab: ProofTab) => (
    <button className="pbn" type="button" data-call={n} data-injtab={tab} onClick={() => onPick(n, tab)}>
      #{n}
    </button>
  );
  const e = parts.evidence;
  const reason = e ? e.why : why;
  return (
    <span className="injline">
      <span className="nw">planted at {pick(parts.plantedAt, 'response')} →</span> <span className="nw">read at {parts.readAt === null ? '#?' : pick(parts.readAt, 'conversation')}</span>
      {e && e.value === null ? (
        <>
          {' → '}
          {e.at} <span className="nw">at {pick(e.callNo, 'request')}</span>
        </>
      ) : null}
      {e && e.value !== null ? (
        <>
          {' → '}
          <span className="nw">{e.at} =</span>{' '}
          <span className="nw">
            <b className="cnry">{e.value}</b> at {pick(e.callNo, 'request')}
          </span>
        </>
      ) : null}
      {reason ? (
        <>
          {' '}
          <span className="pwhy">· {reason}</span>
        </>
      ) : null}
    </span>
  );
}
