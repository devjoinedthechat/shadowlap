import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { migrateArgv } from '../../src/decisions-argv.js';
import type { MigrateEstimateView } from '../estimates-api.js';
import { FixJobButton } from '../fixes/FixJobButton.js';
import { useLoad } from '../hooks.js';
import { quoteArg } from '../job-title.js';
import { useApp } from '../state.js';
import { Dialog } from './Dialog.js';

/**
 * Migrate to a model's one ask, wherever its press is: a retiring model's row on Needs a look, a
 * preview's next step, Migrate's start page and its report's menu, and the palette. Its title, what it
 * asks and verifies, what it writes, the preview of the same switch that asked these already, its
 * command, and the ceiling it bills (`GET /api/migrate/estimate`); OK starts the `migrate` job, which
 * asks once more before a golden from someone else's pack runs their command.
 */

/** Migrate to <model>'s one card, on every press of it. */
export const MIGRATE_CARD = 'Verify runs the agent live from the switched calls, writes stubbed';

/** What one migration switches: to `to`, from `from`, on the goldens named (paths), else the runs. */
export interface MigrateSwitch {
  from: readonly string[];
  to: string;
  goldens: readonly string[];
  runs?: readonly string[];
}

/** The command the job runs, quoted as a shell takes it. */
export const migrateCommand = (s: MigrateSwitch): string => ['shadowlap', ...migrateArgv({ to: s.to, targets: s.goldens.length ? s.goldens : (s.runs ?? []), from: s.from })].map(quoteArg).join(' ');

/** What a switch bills and the preview that asked it already; nothing in an exported copy or a read-only dashboard, undefined while it is worked out. */
export function useMigrateEstimate(s: MigrateSwitch, ask = true): { estimate: Estimate | null | undefined; preview: MigrateEstimateView['preview'] } {
  const { client, exported, actionsOff } = useApp();
  const on = ask && !exported && !actionsOff && !!s.to;
  const priced = useLoad(() => (on ? (client.estimates?.migrateEstimate?.(s.to, s.from, s.goldens) ?? null) : null), `migrate-estimate:${s.to}:${s.from.join(',')}:${s.goldens.join(',')}:${on ? 1 : 0}`);
  return { estimate: priced.data ? priced.data.estimate : priced.error || !on ? null : undefined, preview: priced.data?.preview ?? null };
}

/** The dialog: title, lead, Writes and Preview, the command, the cost line and Migrate to <model>. */
export function MigrateDialog({ s, estimate, preview, onOk, onClose }: { s: MigrateSwitch; estimate: Estimate | null | undefined; preview: MigrateEstimateView['preview']; onOk: () => unknown; onClose: () => void }) {
  const was = s.from.join(', ') || 'the recorded model';
  return (
    <Dialog
      title={`Migrate ${was} to ${s.to}`}
      lead={`Asks ${was}’s calls again under ${s.to}, then verifies end to end the runs the preview can’t clear.`}
      doc="migrate"
      facts={[
        { label: 'Writes', value: 'a config change and a pull request body, beside the store', quiet: 'your files stay as they are' },
        preview ? { label: 'Preview', value: <><code>{preview.sessionId.slice(0, 13)}</code> asked these already</>, quiet: `migrate asks${preview.verified ? ' and verifies' : ''} again, its answers not reused` } : null,
      ]}
      command={migrateCommand(s)}
      cost={{ price: 'Billed by your provider', estimate }}
      ok={`Migrate to ${s.to}`}
      onOk={onOk}
      onClose={onClose}
    />
  );
}

/**
 * Migrate to <model>, priced, asking first on every press: lime where it is the page's next step,
 * plain with why while it can't start (a server without the job, a job holding the tree). None in an
 * exported copy.
 */
export function MigrateButton({ s, label = `Migrate to ${s.to}`, lime = false, className = 'btn' }: { s: MigrateSwitch; label?: string; lime?: boolean; className?: string }) {
  const { estimate, preview } = useMigrateEstimate(s);
  const fields = { to: s.to, ...(s.from.length ? { from: [...s.from] } : {}), ...(s.goldens.length ? { goldens: [...s.goldens] } : { runs: [...(s.runs ?? [])] }) };
  return (
    <FixJobButton
      kind="migrate"
      fields={fields}
      label={label}
      verb="migrate"
      lead={lime}
      className={className}
      tip={MIGRATE_CARD}
      command={migrateCommand(s)}
      estimate={estimate}
      form
      ask={(start, close) => <MigrateDialog s={s} estimate={estimate} preview={preview} onOk={() => start({})} onClose={close} />}
    />
  );
}
