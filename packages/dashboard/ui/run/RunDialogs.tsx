import type { BisectOffer } from '../api.js';
import { Dialog, PromptDialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { commandText } from '../goldens.js';
import { bisectCopy, type UpdateGoldenCopy } from './offers.js';

/**
 * The run page's dialogs that start another slice's job: Find the commit, and Update golden. Each
 * says what will run; the server builds it. Run blame's check dialog is Fixes' (fixes/RunBlame.tsx),
 * and Add normalizer and update asks in the Tests screen's own dialog (pages/TestsDialogs.tsx).
 */

/** Find breaking commit…: a commit where it still worked, from the revisions its runs were made at, or any other. */
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
      ok={copy.ok}
      onRun={onRun}
      onClose={onClose}
    />
  );
}

/**
 * Update golden, as the Tests screen words it (`updateGoldenCopy`): what happens (re-recorded live
 * with writes stubbed, its checks run, replaced only if they pass, reviewed in a pull request); when
 * what diverged is a value made anew on every run, that a normalizer is the lasting fix, with the
 * button that adds it (and updates the golden after it when the rule alone can't make the replay
 * match); once the rule is in the config, that the run after this update matches.
 */
export function UpdateGoldenDialog({ golden, copy, onAddNormalizer, onOk, onClose }: { golden: string; copy: UpdateGoldenCopy; onAddNormalizer: () => void; onOk: () => void; onClose: () => void }) {
  const { name, advise, note } = copy;
  const steps: Array<[string, string]> = [
    ['Re-recorded live', 'writes stubbed'],
    ['Its checks run', copy.checks],
    ['Replaced only if they pass', 'in your working tree'],
    ['You review the change', 'in your pull request'],
  ];
  return (
    <Dialog title={`Update ${name}?`} text="Use this when the change was intended. The new recording replaces the old one, and you review it in your pull request." ok={copy.ok} onClose={onClose} onOk={onOk}>
      <div className="rmp">
        <span className="pa">
          <Icon name="tests" />
        </span>
        <span className="pn">
          <b>{name}</b>
          <small>{golden}</small>
        </span>
        <span className="rs">{copy.at}</span>
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
      {advise ? (
        <div className="dz advise">
          <b>A normalizer fixes this for good</b>
          <small>
            <code>{advise.path}</code> {advise.text}
          </small>
          {advise.instead ? (
            <button className="btn sm" type="button" onClick={onAddNormalizer}>
              {advise.instead}
            </button>
          ) : null}
        </div>
      ) : null}
      {note ? (
        <p className="hintx unote">
          {note.path ? (
            <>
              The normalizer for <code>{note.path}</code> is in shadowlap.config.json already
            </>
          ) : (
            'The normalizer is in shadowlap.config.json already'
          )}
          , so the run after this update matches.
        </p>
      ) : null}
      <div className="cmdline upd">
        <b>$</b>
        {commandText(['test', golden, '--update'])}
      </div>
    </Dialog>
  );
}
