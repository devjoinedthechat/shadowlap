import { useId, useState, type ReactNode } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { eitherWay, type UpdatePlan } from '../update-plan.js';
import { CommandRow } from './CommandRow.js';
import { CostLine } from './CostLine.js';
import { Dialog, type WayOn } from './Dialog.js';
import { Code, Copy } from './Copy.js';
import { DialogSteps } from './DialogFacts.js';
import { withReason } from '../update-reason.js';
import { ReasonField, useUpdateReason } from './UpdateReason.js';

/** A command's name over it, with its way to unfold on a phone, where two commands wouldn't leave a sheet room for the rest. */
function CommandName({ name, controls, open, onToggle }: { name: string; controls: string; open: boolean; onToggle: () => void }) {
  return (
    <p className="cmdlbl">
      {name}
      <button className="linkbtn updshow" type="button" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
        {open ? 'Hide command' : 'Show command'}
      </button>
    </p>
  );
}

/**
 * Update golden, on Tests and on a test replay's page (`updatePlan`): the golden or the diverged
 * goldens as rows between hairlines, what happens, and when what diverged is a value made anew on
 * every run the normalizer's way on, lime, beside Update anyway, each with its own command and what
 * it bills (several goldens' normalizer and update bills what the update does, said once, under the
 * update's). A golden that only lacks a judge's verdict names no row: nothing diverged. Where one
 * diverged, it asks why the change is meant, optionally (UpdateReason.tsx): the reason goes with
 * either way on that updates, and the commands follow what is typed.
 */
export function UpdateGoldenDialog({ plan, estimate, onUpdate, onInstead, onClose }: { plan: UpdatePlan; estimate?: Estimate | null | undefined; onUpdate: (reason: string) => ReturnType<WayOn>; onInstead?: ((reason: string) => ReturnType<WayOn>) | undefined; onClose: () => void }) {
  const one = plan.goldens.length === 1 ? plan.goldens[0]! : null;
  const instead = onInstead ? plan.instead : null;
  const id = useId();
  const [shown, setShown] = useState({ instead: false, update: false });
  const why = useUpdateReason();
  // Nothing diverged where only a judge's verdict is asked: no change to give a reason for.
  const asksWhy = plan.goldens.length > 0;
  const command = withReason(plan.command, why.reason);
  const steps = <DialogSteps steps={plan.steps.map(([what, where]) => ({ what, where }))} {...(plan.advise ? { head: 'If you update anyway' } : {})} />;
  return (
    <Dialog
      title={plan.title}
      lead={plan.lead}
      doc={plan.doc}
      facts={plan.facts}
      ok={plan.ok}
      {...(instead ? { tone: 'plain' as const, alt: { label: instead.label, onClick: () => onInstead!(why.reason) } } : {})}
      onOk={() => onUpdate(why.reason)}
      // The reason is optional: the dialog opens on its way on as it did, the lime one where there are two.
      {...(asksWhy ? { startFocus: instead ? '.dlg-alt' : '.dlg-ok' } : {})}
      onClose={onClose}
      command={instead ? { command, id: `${id}update`, className: `updany${shown.update ? ' open' : ''}` } : command}
      // The update's estimate once it has come, in place of the words that say what it bills: for several
      // goldens' normalizer and update too, which bills the same, said under the update's command.
      cost={{ ...plan.cost, estimate: estimate && instead?.run === 'normalize-update-all' ? eitherWay(estimate) : estimate }}
    >
      {!plan.goldens.length ? null : one ? (
        <div className="rmp">
          <span className="pn">
            <b>{one.name}</b>
            <small className="gpath">{one.path}</small>
          </span>
          <code className="rs">{one.where}</code>
        </div>
      ) : (
        <div className="ondisk first">
          <span className="k">Diverged</span>
          <ul className="plain">
            {plan.goldens.map((g) => (
              <li key={g.path}>
                <i aria-hidden="true" />
                <span>{g.name}</span>
                <code>{g.where}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.advise ? null : steps}
      {plan.advise ? (
        <div className="advise">
          <b>{plan.advise.title}</b>
          <Copy phrases>
            {plan.advise.path ? (
              <>
                <Code>{plan.advise.path}</Code>{' '}
              </>
            ) : null}
            {adviceParts(plan.advise.text, instead?.label ?? null)}
          </Copy>
        </div>
      ) : null}
      {instead ? (
        <>
          <CommandName name={instead.label} controls={`${id}instead`} open={shown.instead} onToggle={() => setShown({ ...shown, instead: !shown.instead })} />
          <CommandRow id={`${id}instead`} className={`updany${shown.instead ? ' open' : ''}`} command={instead.command.map((line) => withReason(line, why.reason))} />
          {instead.cost ? <CostLine {...instead.cost} flow /> : null}
        </>
      ) : null}
      {plan.advise ? steps : null}
      {asksWhy ? <ReasonField reason={why} enter={!instead} /> : null}
      {plan.note ? (
        <Copy className="dlgnote fieldhint">{plan.note.map((part, i) => (typeof part === 'string' ? part : <Code key={i}>{part.code}</Code>))}</Copy>
      ) : null}
      {instead ? <CommandName name={plan.ok} controls={`${id}update`} open={shown.update} onToggle={() => setShown({ ...shown, update: !shown.update })} /> : null}
    </Dialog>
  );
}

/** The advice's words as `Copy` sets them, the action it names (`name`, Add normalizer and update, say) kept whole on its line. */
function adviceParts(text: string, name: string | null): ReactNode[] {
  const at = name ? text.indexOf(name) : -1;
  if (!name || at < 0) return [text];
  return [
    text.slice(0, at),
    <span key="name" className="nw">
      {name}
    </span>,
    text.slice(at + name.length),
  ];
}
