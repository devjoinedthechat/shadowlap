import { useState } from 'react';
import type { BisectRevision, TestsView } from '../api.js';
import { CmdLine } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { commandText, revisionChoices, updatePlan, type UpdatePlan } from '../goldens.js';

/**
 * The Tests screen's dialogs: Update golden (one or several, in the style of Remove project), Find
 * the commit when it needs a good commit or costs tokens, and Add normalizer when the rule alone
 * can't make the replay match, so the golden is updated after it.
 */

/**
 * Update golden, or Update goldens… for every diverged one: what happens, the amber note when the
 * divergence is a value that changes every run (a normalizer is the lasting fix, offered instead
 * when the server runs it) or when the rule already in the config makes a re-run pass, and the
 * command. `has` says which jobs the server runs; `onInstead` runs the amber box's button.
 */
export function UpdateGoldensDialog({ view, paths, has, onUpdate, onInstead, onClose }: { view: TestsView; paths: string[]; has: (kind: string) => boolean; onUpdate: () => void; onInstead: (instead: NonNullable<UpdatePlan['instead']>) => void; onClose: () => void }) {
  const plan = updatePlan(view, paths, has);
  const one = plan.goldens.length === 1 ? plan.goldens[0]! : null;
  return (
    <Dialog title={plan.title} text={plan.text} ok={plan.ok} onOk={onUpdate} onClose={onClose}>
      {one ? (
        <div className="rmp">
          <span className="pa">
            <Icon name="tests" />
          </span>
          <span className="pn">
            <b>{one.name}</b>
            <small>{one.path}</small>
          </span>
          <span className="rs">{one.where}</span>
        </div>
      ) : (
        <div className="ondisk first">
          <span className="k">Diverged</span>
          <ul>
            {plan.goldens.map((g) => (
              <li key={g.path} className="gone">
                <i aria-hidden="true">✕</i>
                <span>{g.name}</span>
                <code>{g.where}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ondisk steps">
        <span className="k">What happens</span>
        <ul>
          {plan.steps.map(([what, how], i) => (
            <li key={what}>
              <i aria-hidden="true">{i + 1}</i>
              <span>{what}</span>
              <code>{how}</code>
            </li>
          ))}
        </ul>
      </div>
      {plan.advise ? (
        <div className="dz advise">
          <b>{plan.advise.title}</b>
          <small>
            {plan.advise.path ? (
              <>
                <code>{plan.advise.path}</code>{' '}
              </>
            ) : null}
            {plan.advise.text}
          </small>
          {plan.instead ? (
            <button className="btn sm" type="button" onClick={() => onInstead(plan.instead!)}>
              {plan.instead.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {plan.note ? (
        <p className="hintx unote">
          {plan.note.map((part, i) => (typeof part === 'string' ? <span key={i}>{part}</span> : <code key={i}>{part.code}</code>))}
        </p>
      ) : null}
      <div className="cmdline upd">
        <b>$</b>
        {plan.command}
      </div>
    </Dialog>
  );
}

/** The select's option that turns it into a field for any commit, tag or branch. */
const ANOTHER = '\u0000another';

/**
 * Find the commit for a golden when it can't just start: no revision where it passed under today's
 * checks is known, or a search from it (`tried`) named no first bad commit, so it asks for a commit
 * where it still worked, offering the commits the golden was tested at with their subjects (as the
 * mock's select does), starting on an older one than `tried`, or any other; or the golden may fork,
 * so each replay runs live from where it forks and the search costs tokens, which it says first.
 */
export function FindCommitDialog({ name, golden, range, live, revisions, tried, onRun, onClose }: { name: string; golden: string; range: { good: string; bad: string | null } | null; live: boolean; revisions: readonly BisectRevision[]; tried: string | null; onRun: (good: string, bad: string | null) => void; onClose: () => void }) {
  const choices = revisionChoices(revisions, tried);
  const [picked, setPicked] = useState(choices.initial);
  const [own, setOwn] = useState(!choices.initial);
  const [typed, setTyped] = useState('');
  const rev = range ? range.good : own ? typed.trim() : picked;
  const ok = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,199}$/.test(rev);
  const args = ['bisect', golden, '--good', rev || '<commit>', ...(range?.bad ? ['--bad', range.bad] : [])];
  const between = range ? `between ${range.good} and ${range.bad ?? 'HEAD'}` : 'between a good one and HEAD';
  const cost = live ? 'It may fork, so each replay runs live from where it forks: this costs tokens.' : 'Replays are free, so this costs no tokens.';
  const run = () => ok && onRun(rev, range?.bad ?? null);
  return (
    <Dialog title={`Find the commit that broke ${name}`} text={`Replays ${name} at commits ${between}, halving each time, and names the first where it fails. ${cost}`} ok="Find the commit" okDisabled={!ok} onOk={run} onClose={onClose}>
      {range ? null : (
        <div className="form one">
          <label>
            A commit where it still worked
            {own ? (
              <input
                type="text"
                value={typed}
                placeholder="a sha, a tag or a branch"
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    run();
                  }
                }}
              />
            ) : (
              <select
                value={picked}
                onChange={(e) => {
                  if (e.target.value === ANOTHER) setOwn(true);
                  else setPicked(e.target.value);
                }}
              >
                {choices.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
                <option value={ANOTHER}>Another commit…</option>
              </select>
            )}
          </label>
        </div>
      )}
      <CmdLine>{commandText(args)}</CmdLine>
    </Dialog>
  );
}

/**
 * Add normalizer when the rules alone can't make the replay match (the request carries a field the
 * recording never had, or more changed): the rules are added, then the golden is updated, which
 * re-records it live. It asks first, as Update golden does, with each command.
 */
export function NormalizeUpdateDialog({ name, steps, onRun, onClose }: { name: string; steps: string[][]; onRun: () => void; onClose: () => void }) {
  const rules = steps.length - 1;
  return (
    <Dialog
      title={`Add the normalizer and update ${name}?`}
      text={`The ${rules === 1 ? 'rule' : 'rules'} alone can’t make the replay match, so ${name} is re-recorded live after ${rules === 1 ? 'it' : 'them'}, with writes stubbed, and replaced only if its checks pass. Without ${rules === 1 ? 'the rule' : 'them'}, the next run diverges again.`}
      ok="Add and update"
      onOk={onRun}
      onClose={onClose}
    >
      {steps.map((s) => (
        <CmdLine key={s.join(' ')}>{commandText(s)}</CmdLine>
      ))}
    </Dialog>
  );
}
