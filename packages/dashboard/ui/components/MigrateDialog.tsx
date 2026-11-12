import { useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { JOB_KINDS } from '../api.js';
import type { MigrateEstimateView } from '../estimates-api.js';
import { FixJobButton, useConsentStart } from '../fixes/FixJobButton.js';
import { useLoad } from '../hooks.js';
import { migrateCommand, type MigrateSwitch } from '../migrate-command.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import { ActionButton } from './ActionButton.js';
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

/** The `migrate` job's fields: every golden where it names none and no run. */
const fieldsOf = (s: MigrateSwitch): Record<string, unknown> => ({ to: s.to, ...(s.from.length ? { from: [...s.from] } : {}), ...(s.goldens.length ? { goldens: [...s.goldens] } : s.runs?.length ? { runs: [...s.runs] } : {}) });


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
 * plain with why while it can't start (a server without the job, a job holding the tree, `why`: a
 * field that names no other model). None in an exported copy.
 */
export function MigrateButton({ s, label = `Migrate to ${s.to}`, lime = false, className = 'btn', why = null }: { s: MigrateSwitch; label?: string; lime?: boolean; className?: string; why?: string | null }) {
  const { estimate, preview } = useMigrateEstimate(s, !why);
  if (why)
    return (
      <ActionButton className={className} why={why} tip={MIGRATE_CARD} command={`$ ${migrateCommand(s)}`}>
        {label}
      </ActionButton>
    );
  return (
    <FixJobButton
      kind={JOB_KINDS.migrate}
      fields={fieldsOf(s)}
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

/** Migrate's dialog opened without its button, as the palette's Migrate <a> to <b> asks for it; it stays for the consent ask its OK may bring. */
export function MigrateAskNow({ s }: { s: MigrateSwitch }) {
  const app = useApp();
  const [open, setOpen] = useState(true);
  const { estimate, preview } = useMigrateEstimate(s);
  const { start, consent } = useConsentStart(JOB_KINDS.migrate, fieldsOf(s));
  return (
    <>
      {open ? <MigrateDialog s={s} estimate={estimate} preview={preview} onOk={() => app.guard(() => void start(sentEstimate(estimate)))} onClose={() => setOpen(false)} /> : null}
      {consent}
    </>
  );
}
