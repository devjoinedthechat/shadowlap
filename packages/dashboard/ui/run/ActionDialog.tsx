import { dialogCopy } from './fork-dialog.js';
import type { PendingAction } from './actions.js';
import { ConfirmDialog, PromptDialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { shortId } from '../format.js';

/** The dialog an action asks its one thing in, or only whether to start, in the words fork-dialog.ts gives it. */
export function ActionDialog({ runId, capture, forkAt, pending, onRun, onClose }: { runId: string; capture: boolean; forkAt: number | null | undefined; pending: PendingAction; onRun: (v?: string) => boolean; onClose: () => void }) {
  const copy = dialogCopy(pending.action, {
    id: shortId(runId),
    callNo: pending.callNo,
    capture,
    forkAt: forkAt ?? null,
    ...(pending.callName !== undefined ? { callName: pending.callName } : {}),
    ...(pending.recorded !== undefined ? { recorded: pending.recorded } : {}),
  });
  const { title, lead, doc, warn, facts, factsUnder, cost, ok } = copy;
  const slots = { title: copy.titleName ? namedIn(title, copy.titleName) : title, lead, ok, onClose, ...(doc ? { doc } : {}), ...(warn ? { warn } : {}), ...(facts ? { facts } : {}), ...(cost ? { cost } : {}) };
  // Nothing to fill in: it asks only whether to start, as it runs live.
  if (!pending.action.prompt) return <ConfirmDialog {...slots} {...(copy.command ? { command: copy.command('') } : {})} onOk={() => onRun()} />;
  return (
    <PromptDialog
      {...slots}
      {...(factsUnder ? { factsUnder } : {})}
      {...(copy.label ? { label: copy.label } : {})}
      {...(copy.fieldName ? { fieldName: copy.fieldName } : {})}
      {...(copy.command ? { command: copy.command } : {})}
      {...(copy.choices ? { choices: copy.choices } : {})}
      {...(copy.startFrom ? { startFrom: copy.startFrom } : {})}
      multiline={copy.multiline}
      initial={copy.initial}
      placeholder={copy.placeholder}
      onRun={onRun}
    />
  );
}
