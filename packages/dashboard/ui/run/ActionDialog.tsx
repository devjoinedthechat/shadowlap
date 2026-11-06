import { useState } from 'react';
import { dialogCopy } from './fork-dialog.js';
import type { PendingAction } from './actions.js';
import { useDialogEstimate, type RowPrice } from './estimates.js';
import { AskNote } from '../components/AskNote.js';
import { ConfirmDialog, PromptDialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { shortId } from '../format.js';

/**
 * The dialog an action asks its one thing in, or only whether to start, in the words fork-dialog.ts
 * gives it. Its Cost line says the estimate once it has come, Switch model's for the model in its
 * field, and the job starts with what the line said; an ask's footer says why it asks where
 * Spending's threshold is why.
 */
export function ActionDialog({ runId, capture, forkAt, pending, onRun, onClose }: { runId: string; capture: boolean; forkAt: number | null | undefined; pending: PendingAction; onRun: (v: string | undefined, estimate: RowPrice) => boolean; onClose: () => void }) {
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
  });
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
      {...(copy.command ? { command: copy.command } : {})}
      {...(copy.choices ? { choices: copy.choices } : {})}
      {...(copy.startFrom ? { startFrom: copy.startFrom } : {})}
      multiline={copy.multiline}
      initial={copy.initial}
      placeholder={copy.placeholder}
      onRun={(v) => onRun(v, estimate)}
    />
  );
}
