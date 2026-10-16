import { useState } from 'react';
import type { BisectOffer, BlameOffer } from '../api.js';
import { CmdLine } from '../components/bits.js';
import { Dialog, PromptDialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { shortId } from '../format.js';
import { bisectCopy, blameCommand, failedChecksText, readExpect } from './offers.js';

/**
 * The run page's dialogs that start another slice's job: Run blame when nothing names the run's
 * failing check, Find the commit, and Update golden. Each says what will run; the server builds it.
 */

/** Run blame on a run whose failed check nothing names: asks for it, as `--expect` takes it. */
export function BlameDialog({ runId, offer, onRun, onClose }: { runId: string; offer: BlameOffer; onRun: (expect: Record<string, unknown>) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const read = readExpect(text);
  const failed = failedChecksText(offer.failed);
  return (
    <Dialog
      title={`Blame ${shortId(runId)}`}
      text={`Blame replays the run up to each model call it probes, asks that call again and runs the rest live with writes stubbed, to find the answer that lost the run. It needs the check a passing run meets${failed ? `: this run failed ${failed}, and nothing names that check` : ''}. Give it as under expect in shadowlap.config.json.`}
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
      <CmdLine>{blameCommand(runId, 'expect' in read ? read.expect : undefined)}</CmdLine>
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
      command={(good) => copy.command(good || '…')}
      ok="Find the commit"
      onRun={onRun}
      onClose={onClose}
    />
  );
}

/**
 * Update golden, as the Tests screen words it: what happens (re-recorded live with writes stubbed, its
 * checks run, replaced only if they pass, reviewed in a pull request), and, when what diverged is a
 * value made anew on every run, that a normalizer is the lasting fix, with the button to add it instead.
 */
export function UpdateGoldenDialog({ golden, at, checks, perRun, onAddNormalizer, onOk, onClose }: { golden: string; at: string; checks: number | null; perRun: { path: string; looks: string } | null; onAddNormalizer: (() => void) | null; onOk: () => void; onClose: () => void }) {
  const name = golden.replace(/^goldens\//, '');
  const steps: Array<[string, string]> = [
    ['Re-recorded live', 'writes stubbed'],
    ['Its checks run', checks === null ? 'from shadowlap.config.json' : `${checks} ${checks === 1 ? 'check' : 'checks'}`],
    ['Replaced only if they pass', 'in your working tree'],
    ['You review the change', 'in your pull request'],
  ];
  return (
    <Dialog title={`Update ${name}?`} text="Use this when the change was intended. The new recording replaces the old one, and you review it in your pull request." ok={perRun ? 'Update anyway' : 'Update'} onClose={onClose} onOk={onOk}>
      <div className="rmp">
        <span className="pa">
          <Icon name="tests" />
        </span>
        <span className="pn">
          <b>{name}</b>
          <small>{golden}</small>
        </span>
        <span className="rs">{at}</span>
      </div>
      <div className="ondisk steps">
        <span className="k">What happens</span>
        <ul>
          {steps.map(([what, where], i) => (
            <li key={what}>
              <i aria-hidden="true">{i + 1}</i>
              <span>{what}</span>
              <code>{where}</code>
            </li>
          ))}
        </ul>
      </div>
      {perRun ? (
        <div className="dz advise">
          <b>A normalizer fixes this for good</b>
          <small>
            <code>{perRun.path}</code> looks like {perRun.looks}, which changes every run. Updating re-records it, and the next run diverges again.
          </small>
          {onAddNormalizer ? (
            <button className="btn sm" type="button" onClick={onAddNormalizer}>
              Add the normalizer instead
            </button>
          ) : null}
        </div>
      ) : null}
      <CmdLine>{`shadowlap test ${golden} --update`}</CmdLine>
    </Dialog>
  );
}
