import { useId, useState } from 'react';
import type { BisectOffer } from '../api.js';
import { ConfirmDialog, Dialog } from '../components/Dialog.js';
import { COMMIT_NAME, GoodCommitField } from '../components/GoodCommit.js';
import { Id, namedIn } from '../components/Id.js';
import { shortId } from '../format.js';
import { deleteFacts, deleteLead } from '../runspage/bulk.js';
import { bisectCopy } from './offers.js';

/**
 * The run page's dialog that starts another slice's job: Find breaking commit. It says what will run;
 * the server builds it. Run blame's check dialog is Fixes' (fixes/RunBlame.tsx), Update golden is one
 * with Tests' (components/UpdateGolden.tsx), and Add normalizer and update asks in the Tests screen's
 * own dialog (pages/TestsDialogs.tsx).
 */

/** Find breaking commit…: a commit where it worked, from the revisions its runs were made at, or any other. */
export function BisectDialog({ runId, offer, onRun, onClose }: { runId: string; offer: BisectOffer; onRun: (good: string) => unknown; onClose: () => void }) {
  const copy = bisectCopy(runId, offer);
  const id = useId();
  const [picked, setPicked] = useState(copy.initial);
  const [typed, setTyped] = useState('');
  const good = typed.trim() || picked;
  return (
    <Dialog
      title={namedIn(copy.title, offer.target.kind === 'golden' ? offer.target.golden : shortId(runId))}
      lead={copy.lead}
      doc="bisect"
      facts={copy.facts}
      command={copy.command(good || '<commit>')}
      cost={copy.cost}
      ok={copy.ok}
      okDisabled={!COMMIT_NAME.test(good)}
      onOk={() => onRun(good)}
      onClose={onClose}
    >
      <GoodCommitField id={id} label={copy.label} choices={copy.choices} picked={picked} typed={typed} onPick={setPicked} onType={setTyped} />
      {copy.note ? <p className="dlgnote fieldhint">{copy.note}</p> : null}
    </Dialog>
  );
}

/** Delete run, as Runs' Delete and `shadowlap rm` delete it: with the attempts bundled under it, counted before you press. */
export function DeleteRunDialog({ runId, attempts, onOk, onClose }: { runId: string; attempts: number; onOk: () => unknown; onClose: () => void }) {
  return (
    <ConfirmDialog
      title={
        <>
          Delete <Id id={shortId(runId)} />?
        </>
      }
      lead={deleteLead(1, attempts)}
      doc="deletingRuns"
      facts={deleteFacts(1, [])}
      command={`shadowlap rm ${shortId(runId)}`}
      ok="Delete run"
      danger
      onClose={onClose}
      onOk={onOk}
    />
  );
}
