import { useId, useState } from 'react';
import { TRUST_FROM } from '../../../engine/src/trust-words.js';
import { consentAsked } from '../actions.js';
import { JOB_KINDS } from '../api.js';
import { ConsentDialog, Dialog } from '../components/Dialog.js';
import { DialogTip } from '../components/DialogFacts.js';
import { JobButton } from '../components/JobButton.js';
import type { RunEstimates } from '../estimates-api.js';
import { useTreeBusy } from '../fixes/tree.js';
import { shortId } from '../format.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { useRunEstimates } from '../run/estimates.js';
import { sentEstimate } from '../spending.js';
import { guardedWayOn, useApp } from '../state.js';
import { errorText } from '../toast.js';
import { answerWords } from './answer-words.js';
import type { CauseView } from './model.js';
import './job-footer.js';

/**
 * Find cause… on a write the run really made after an untrusted read: a quiet link on the
 * inspector's summary line, after Add check…, and the dialog it opens. A part only the served
 * dashboard hands in (served-parts.ts), as a copy runs nothing; the run's page loads it as its
 * inspector first shows on a run that has a write to ask about. Once the finding has an answer about
 * the write, the link is Test another read…, on the first read no answer names yet. The server
 * words each fact, the price and the gate's rule (injection-cause.ts, estimates.ts): this picks and
 * joins its words.
 */

type Facts = CauseView['facts'][number];
type Answer = CauseView['answers'][number];

/** The command Find cause… runs: the read it makes neutral, the write it asks about. */
export const causeCommand = (runId: string, read: number, write: number): string => `shadowlap injection ${shortId(runId)} --clean ${read} --write ${write}`;

/** The read the dialog starts on: Find cause's pick, else, asked again, the first read no answer about the write names. */
export function causeRead(f: Facts, asked: readonly Answer[]): number {
  if (!asked.length) return f.pick;
  return f.reads.find((n) => !asked.some((a) => a.read.callNo === n)) ?? f.pick;
}

/** A read's price from the run's estimates: undefined while they come (or where nothing starts), null for none. */
const priceOf = (prices: RunEstimates | null | undefined, read: number) => (prices === undefined ? undefined : (prices?.cause[read] ?? null));

export function FindCause({ runId, callNo, cause }: { runId: string; callNo: number; cause: CauseView }) {
  const [open, setOpen] = useState(false);
  const f = cause.facts.find((x) => x.write === callNo);
  // Each read's price comes with the run's estimates, asked once for the run as the link first shows.
  const prices = useRunEstimates(runId, f ? null : undefined);
  if (!f) return null;
  const asked = cause.answers.filter((a) => a.write.callNo === callNo);
  const read = causeRead(f, asked);
  const write = `#${f.write} ${f.name}`;
  const one = f.reads.length > 1 ? 'an untrusted read' : `#${read} ${cause.reads.find((r) => r.callNo === read)?.name ?? ''}`;
  const card = asked[0]
    ? { tip: `Test another read for ${write}`, sub: `The finding has the answer: ${answerWords(asked[0])}. Ask of another read, or again` }
    : { tip: `Find cause of ${write}`, sub: `Replays the run with ${one} made neutral until the gate decides whether #${f.write} comes back` };
  return (
    <>
      <JobButton className="linkbtn iask" data-act="injcause" form estimate={priceOf(prices, read)} tip={card.tip} sub={card.sub} command={`$ ${causeCommand(runId, read, f.write)}`} start={() => setOpen(true)} ask={() => setOpen(true)}>
        {asked.length ? ACTIONS.testAnotherRead.label : ACTIONS.findCause.label}
      </JobButton>
      {open ? <CauseDialog runId={runId} f={f} again={asked.length > 0} first={read} cause={cause} prices={prices} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The dialog: the gate, the read to make neutral, the command and its price, and the consent a command from elsewhere asks. */
function CauseDialog({ runId, f, again, first, cause, prices, onClose }: { runId: string; f: Facts; again: boolean; first: number; cause: CauseView; prices: RunEstimates | null | undefined; onClose: () => void }) {
  const app = useApp();
  const id = useId();
  const [read, setRead] = useState(first);
  const [consent, setConsent] = useState<{ why: string; confirm: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const busy = useTreeBusy('reads', 'ask it');
  const ok = again ? ACTIONS.testAnotherRead.confirm : confirmWords(ACTIONS.findCause.label);
  const estimate = priceOf(prices, read);
  // The yes to a command someone else recorded sends the same fields again; any other refusal stays in the dialog, in the server's words.
  const start = (yes?: string): Promise<boolean> =>
    app.client.startJob(JOB_KINDS.injection, { runId, clean: read, writes: [f.write], ...sentEstimate(estimate), ...(yes === undefined ? {} : { yes }) }).then(
      (job) => {
        app.watchJob(Promise.resolve(job));
        return true;
      },
      (err: unknown) => {
        const ask = yes === undefined ? consentAsked(err) : null;
        setConsent(ask ? { why: ask.why, confirm: ask.confirm } : null);
        if (!ask) setRefused(errorText(err));
        return false;
      },
    );
  if (consent) return <ConsentDialog why={consent.why} ok={ok} onClose={onClose} onOk={() => guardedWayOn(app.guard, () => start(consent.confirm))} />;
  const rule = cause.rule?.replace(/^gate: /, '');
  return (
    <Dialog
      title={
        <>
          {again ? 'Test another read for ' : 'Find cause of '}
          <code className="rnm">{`#${f.write} ${f.name}`}</code>
        </>
      }
      lead={`Replays the run with an untrusted read made neutral until the gate decides whether #${f.write} comes back.`}
      doc="proveCause"
      className="injdlg"
      warn={refused ? { text: refused } : null}
      facts={[
        !!rule && {
          label: 'Gate',
          value: (
            <DialogTip title={`If #${f.write} goes away`} tip="what the read brought in caused it">
              {rule}
            </DialogTip>
          ),
        },
      ]}
      command={causeCommand(runId, read, f.write)}
      cost={{ price: 'Billed by your provider', parts: ['live from the read, writes stubbed'], estimate }}
      ok={ok}
      okWhy={busy}
      onOk={() => guardedWayOn(app.guard, () => start())}
      onClose={onClose}
    >
      <p className="cmdlbl" id={id}>
        Read to make neutral
      </p>
      <div className="checklist injreads" role="radiogroup" aria-labelledby={id}>
        {f.reads.map((n) => {
          const r = cause.reads.find((x) => x.callNo === n);
          return (
            <label key={n}>
              <input type="radio" name={id} value={n} checked={n === read} onChange={() => setRead(n)} />
              <span>
                <code>{`#${n} ${r?.name ?? ''}`}</code>
                <small>{f.holds && n === f.pick ? `its result holds ${f.holds}, which #${f.write} sends` : r ? `untrusted · ${TRUST_FROM[r.from]}` : 'untrusted'}</small>
              </span>
            </label>
          );
        })}
      </div>
    </Dialog>
  );
}
