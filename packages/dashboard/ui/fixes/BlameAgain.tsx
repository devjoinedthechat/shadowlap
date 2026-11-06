import { useState, type ReactNode } from 'react';
import { probesPart } from '../../../engine/src/cost-words.js';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { AskNote } from '../components/AskNote.js';
import { ConfirmDialog, PromptDialog } from '../components/Dialog.js';
import { approx } from '../format.js';
import { ACTIONS, confirmWords, STRONGER_MODEL } from '../labels.js';
import { sentEstimate } from '../spending.js';
import type { FixDetail } from '../types.js';
import { useStrongerEstimate } from './estimates.js';

/**
 * The asks of a fix's next blame: Run blame again, by Spending, and Run blame with stronger model, a
 * form that asks for the model on every setting. Each Cost line is the fix's estimate, the stronger
 * one's at the model typed once the field rests, and the job keeps the one its dialog said.
 */

/** How a rescue rate reads on the Gate row. */
const rate = (p: number): string => `${Math.round(p * 100)}%`;

/**
 * Run blame again: the same blame with more attempts and a lower bar, the last blame's beside it, or
 * from the first model call where the last stopped part way, at the furthest call it had rescued.
 */
export function BlameAgainDialog({ fix, estimate, onRun, onClose }: { fix: FixDetail; estimate: Estimate | null | undefined; onRun: () => boolean; onClose: () => void }) {
  const again = fix.actions.blameAgain;
  const stopped = again?.kind === 'stopped';
  const gate = !stopped && again?.gate ? again.gate : null;
  const soFar = again?.soFar ?? null;
  const last = again?.lastGood ?? null;
  return (
    <ConfirmDialog
      title={ACTIONS.runBlameAgain.label}
      lead={stopped ? `Searches the run again from the first model call: the last search stopped ${soFar === null ? 'part way' : `at #${soFar}`}.` : 'Probes again with more attempts and a lower bar.'}
      doc="blame"
      facts={gate ? [{ label: 'Gate', value: `a rescue at ${rate(gate.good)} or more`, ...(last === null ? {} : { quiet: `the last blame’s was ${rate(last)}` }) }] : []}
      command={again?.command ?? null}
      cost={{ price: 'Billed by your provider', parts: [probesPart()], estimate }}
      footNote={<AskNote estimate={estimate} />}
      ok={ACTIONS.runBlameAgain.label}
      onOk={onRun}
      onClose={onClose}
    />
  );
}

/**
 * Run blame with stronger model asks first, for the model: it answers from each probed call instead of
 * the recorded one, live, writes stubbed, at what that model costs a call. Its Cost line follows the
 * model typed; until that model's estimate comes, what the last blame took. How to read what it finds
 * is the drawer's and the docs'.
 */
export function StrongerDialog({ fix, onRun, onClose }: { fix: FixDetail; onRun: (model: string, sent: Record<string, unknown>) => boolean; onClose: () => void }) {
  const s = fix.actions.blameStronger;
  const base = s ? s.command.replace(/ --model <model>$/, '') : '';
  const [model, setModel] = useState('');
  const estimate = useStrongerEstimate(fix.fixId, model.trim());
  return (
    <PromptDialog
      title={confirmWords(ACTIONS.runBlameStronger.label)}
      lead="Probes the run again with the model you name answering from each probed call."
      doc="blame"
      label="Model"
      placeholder={STRONGER_MODEL}
      ok={confirmWords(ACTIONS.runBlameStronger.label)}
      command={(m) => `${base} --model ${m.trim() || '<model>'}`}
      cost={{ price: 'Billed by your provider', parts: [...(s ? [`the last blame took ${s.attempts} attempts, ${approx(s.spent)}`] : []), probesPart()], estimate }}
      onAnswer={setModel}
      // The model typed is the one priced: with its estimate not come yet, the job keeps none.
      onRun={(m) => (m.trim() ? onRun(m.trim(), { estimate: sentEstimate(m.trim() === model.trim() ? estimate : null).estimate }) : false)}
      onClose={onClose}
    />
  );
}

/** The ask a fix's next blame opens, starting it with what its dialog adds. */
export function blameNextAsk(fix: FixDetail, kind: 'again' | 'stronger', estimate: Estimate | null | undefined): (start: (more: Record<string, unknown>) => boolean, close: () => void) => ReactNode {
  if (kind === 'stronger') return (start, close) => <StrongerDialog fix={fix} onRun={(model, sent) => start({ model, ...sent })} onClose={close} />;
  return (start, close) => <BlameAgainDialog fix={fix} estimate={estimate} onRun={() => start({})} onClose={close} />;
}
