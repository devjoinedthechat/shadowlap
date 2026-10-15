import { useState } from 'react';
import type { BisectOffer, BlameOffer } from '../api.js';
import { CmdLine } from '../components/bits.js';
import { Dialog, PromptDialog } from '../components/Dialog.js';
import { shortId } from '../format.js';
import { bisectCopy, blameCommand, readExpect } from './offers.js';

/**
 * The run page's dialogs that start another slice's job: Run blame when the run's failing check is
 * not known, Find the commit, and Update golden. Each says what will run; the server builds it.
 */

/** Run blame on a run whose failed check nothing names: asks for it, as `--expect` takes it. */
export function BlameDialog({ runId, offer, onRun, onClose }: { runId: string; offer: BlameOffer; onRun: (expect: Record<string, unknown>) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const read = readExpect(text);
  const failed = offer.failed.length ? offer.failed.join('; ') : null;
  return (
    <Dialog
      title={`Blame ${shortId(runId)}`}
      text={`Blame replays the run up to each model call it probes, asks that call again and runs the rest live with writes stubbed, to find the answer that lost the run. It needs the check a passing run meets${failed ? `: this run failed ${failed}` : ''}. Give it as under expect in shadowlap.config.json.`}
      ok="Run blame"
      okDisabled={'error' in read}
      onClose={onClose}
      onOk={() => 'expect' in read && onRun(read.expect)}
    >
      <div className="form one">
        <label>
          What a passing run must do
          <textarea spellCheck={false} placeholder='{"tools":{"send_email":0}}' value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      </div>
      <CmdLine>{blameCommand(runId, 'expect' in read ? read.expect : '…')}</CmdLine>
    </Dialog>
  );
}

/** Find the commit: a commit where it still worked, from the revisions its runs were made at, or any other. */
export function BisectDialog({ runId, offer, onRun, onClose }: { runId: string; offer: BisectOffer; onRun: (good: string) => void; onClose: () => void }) {
  const copy = bisectCopy(runId, offer);
  return (
    <PromptDialog
      title={copy.title}
      text={copy.text}
      label={copy.label}
      initial={copy.initial}
      placeholder="a commit, a tag or a branch"
      {...(copy.choices.length ? { choices: copy.choices } : {})}
      command={copy.command('…')}
      ok="Find the commit"
      onRun={onRun}
      onClose={onClose}
    />
  );
}

/** Update golden: re-records it live with writes stubbed, replaced only when its checks pass. */
export function UpdateGoldenDialog({ golden, normalizer, onOk, onClose }: { golden: string; normalizer: boolean; onOk: () => void; onClose: () => void }) {
  return (
    <Dialog
      title={`Update ${golden}?`}
      text={`Re-records it live with writes stubbed and replaces it only when its checks pass.${normalizer ? ' What diverged changes on every run: a normalizer is the lasting fix, and keeps older recordings matching.' : ''}`}
      ok="Update golden"
      onClose={onClose}
      onOk={onOk}
    >
      <CmdLine>{`shadowlap test ${golden} --update`}</CmdLine>
    </Dialog>
  );
}
