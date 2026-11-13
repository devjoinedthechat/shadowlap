import { useId, useState } from 'react';
import { dialogCopy, withExpect, type DialogCopy } from './fork-dialog.js';
import type { PendingAction } from './actions.js';
import { useDialogEstimate } from './dialog-estimates.js';
import type { RowPrice } from './estimates.js';
import { AskNote } from '../components/AskNote.js';
import { ConfirmDialog, PromptDialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { shortId } from '../format.js';

/**
 * The dialog an action asks its one thing in, or only whether to start, in the words fork-dialog.ts
 * gives it. Its Cost line says the estimate once it has come, Switch model's for the model in its
 * field, and the job starts with what the line said; an ask's footer says why it asks where
 * Spending's threshold is why. Plant instruction… asks a second thing, Judged by, the checks its
 * attempts are judged by (`--expect`), starting from the run's own (`expect`).
 */
export function ActionDialog({ runId, capture, forkAt, pending, expect, onRun, onClose }: { runId: string; capture: boolean; forkAt: number | null | undefined; pending: PendingAction; expect?: unknown; onRun: (v: string | undefined, estimate: RowPrice, judged?: string) => boolean; onClose: () => void }) {
  const [model, setModel] = useState('');
  const estimate = useDialogEstimate(runId, pending, forkAt != null || !!pending.action.asksFirst, model);
  const copy = dialogCopy(pending.action, {
    id: shortId(runId),
    callNo: pending.callNo,
    capture,
    forkAt: forkAt ?? null,
    ...(pending.callName !== undefined ? { callName: pending.callName } : {}),
    ...(pending.recorded !== undefined ? { recorded: pending.recorded } : {}),
    ...(pending.modelCall ? { modelCall: true } : {}),
    ...(expect && typeof expect === 'object' ? { expect: JSON.stringify(expect) } : {}),
  });
  const [judged, setJudged] = useState(copy.judgedBy?.initial ?? '');
  const { title, lead, doc, warn, facts, factsUnder, cost, ok } = copy;
  const billed = estimate === false ? {} : { ...(cost ? { cost: estimate ? { ...cost, estimate } : cost } : {}), footNote: <AskNote estimate={estimate} form={!!pending.action.prompt} /> };
  const slots = { title: copy.titleName ? namedIn(title, copy.titleName) : title, lead, ok, onClose, ...(doc ? { doc } : {}), ...(warn ? { warn } : {}), ...(facts ? { facts } : {}), ...(cost ? { cost } : {}), ...billed };
  // Nothing to fill in: it asks only whether to start, as it runs live.
  if (!pending.action.prompt) return <ConfirmDialog {...slots} {...(copy.command ? { command: copy.command('') } : {})} onOk={() => onRun(undefined, estimate)} />;
  return (
    <PromptDialog
      {...slots}
      {...(pending.action.key === 'm' ? { onAnswer: setModel } : {})}
      {...(factsUnder ? { factsUnder } : {})}
      {...(copy.label ? { label: copy.label } : {})}
      {...(copy.fieldName ? { fieldName: copy.fieldName } : {})}
      {...(copy.command ? { command: copy.judgedBy ? (a: string) => withExpect(copy.command!(a), judged) : copy.command } : {})}
      {...(copy.judgedBy ? { after: () => <JudgedBy field={copy.judgedBy!} value={judged} onChange={setJudged} /> } : {})}
      {...(copy.choices ? { choices: copy.choices } : {})}
      {...(copy.startFrom ? { startFrom: copy.startFrom } : {})}
      multiline={copy.multiline}
      initial={copy.initial}
      placeholder={copy.placeholder}
      onRun={(v) => onRun(v, estimate, copy.judgedBy ? judged.trim() : undefined)}
    />
  );
}

/** Judged by: the checks, as `--expect` takes them, in mono and never spellchecked, its note under it. */
function JudgedBy({ field, value, onChange }: { field: NonNullable<DialogCopy['judgedBy']>; value: string; onChange: (v: string) => void }) {
  const note = useId();
  return (
    <>
      <div className="form one">
        <label>
          {field.label}
          <input type="text" className="cvin" spellCheck={false} autoComplete="off" value={value} aria-describedby={note} onChange={(e) => onChange(e.target.value)} />
        </label>
      </div>
      <p className="muted fieldhint" id={note}>
        {field.note}
      </p>
    </>
  );
}
