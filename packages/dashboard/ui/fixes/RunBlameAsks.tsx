import { probesPart } from '../../../engine/src/cost-words.js';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { AskNote } from '../components/AskNote.js';
import type { CostLineProps } from '../components/CostLine.js';
import { ConfirmDialog, ConsentDialog, PromptDialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { onShow } from '../components/OnShow.js';
import { shortId } from '../format.js';
import { ACTIONS } from '../labels.js';
import { guardedWayOn, useApp } from '../state.js';
import type { BlameAsking } from './RunBlame.js';

/** The check a blame needs, asked for in a dialog the run page rarely opens: a part of its own (CheckDialog.tsx). */
const CheckDialog = onShow(() => import('./CheckDialog.js').then((m) => m.CheckDialog));

/**
 * What Run blame asks in once pressed (RunBlame.tsx): a capture's command, a yes above Spending, the
 * check a blame needs, or a consent the server asks for. Only the served dashboard draws them, so it
 * hands them in (served-parts.ts, from pages/served.tsx), a part that loads the first time one asks.
 * Each starts the blame with `start`, which closes it or asks again, and the check's dialog shows
 * the server's refusal of the check it was given.
 */
export function RunBlameAsks({ runId, asking, estimate, form, line, failed, start, onClose }: {
  runId: string;
  asking: NonNullable<BlameAsking>;
  /** What it bills, for the dialogs' cost line. */
  estimate: Estimate | null | undefined;
  /** It asks for its command or its check, so its yes runs it whatever Spending says. */
  form: boolean;
  /** The command it runs, where the button knows it. */
  line: string | undefined;
  /** The checks the run failed, named in the check's dialog. */
  failed: readonly string[];
  start: (fields: Record<string, unknown>) => Promise<string | null>;
  onClose: () => void;
}) {
  const app = useApp();
  const title = namedIn(`${ACTIONS.runBlame.label} on ${shortId(runId)}`, shortId(runId));
  const cost: CostLineProps = { price: 'Billed by your provider', parts: [probesPart()], ...(estimate ? { estimate } : {}) };
  switch (asking.kind) {
    case 'command':
      return (
        <PromptDialog
          title={title}
          lead="Finds the model call that lost the run."
          doc="blame"
          label={`${shortId(runId)} came from a capture and has no command. What starts your agent?`}
          placeholder="python agent.py"
          command={(command) => (line ?? `shadowlap blame ${shortId(runId)} -- <your command>`).replace('<your command>', () => command || '<your command>')}
          cost={cost}
          ok={ACTIONS.runBlame.label}
          onClose={onClose}
          onRun={(command) => app.guard(() => void start({ command }))}
        />
      );
    case 'ask':
      return (
        <ConfirmDialog
          title={title}
          lead="Finds the model call that lost the run."
          doc="blame"
          command={line ?? `shadowlap blame ${shortId(runId)}`}
          cost={cost}
          footNote={<AskNote estimate={estimate} form={form} />}
          ok={ACTIONS.runBlame.label}
          onClose={onClose}
          onOk={() => app.guard(() => void start({}))}
        />
      );
    case 'check':
      return (
        <CheckDialog
          runId={runId}
          line={failed.length ? `It failed “${failed[0]!}”${failed.length > 1 ? ` and ${failed.length - 1} more` : ''}, a check shadowlap.config.json doesn’t give` : null}
          command={asking.command}
          cost={cost}
          onClose={onClose}
          onRun={(expect) => guardedWayOn(app.guard, () => start({ expect, ...(asking.command ? { command: asking.command } : {}) })) || Promise.resolve(null)}
        />
      );
    case 'consent':
      return <ConsentDialog why={asking.why} ok={ACTIONS.runBlame.label} onClose={onClose} onOk={() => app.guard(() => void start({ ...asking.fields, yes: asking.confirm }))} />;
  }
}
