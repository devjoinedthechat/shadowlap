import { useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { JOB_KINDS } from '../api.js';
import type { MigrateEstimateView } from '../estimates-api.js';
import { FixJobButton, useConsentStart } from '../fixes/FixJobButton.js';
import { useLoad, useSettled } from '../hooks.js';
import { migrateCommand, type MigrateSwitch } from '../migrate-command.js';
import { useServedParts } from '../served-parts.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import { ActionButton } from './ActionButton.js';

/**
 * Migrate to a model's one ask, wherever its press is: a retiring model's row on Needs a look, a
 * preview's next step, Migrate's start page and its report's menu, and the palette. Its title, what it
 * asks and verifies, what it writes, the preview of the same switch that asked these already, its
 * command, and the ceiling it bills (`GET /api/migrate/estimate`); OK starts the `migrate` job, which
 * asks once more before a golden from someone else's pack runs their command. The dialog is a part the
 * served dashboard hands in (MigrateToDialog.tsx), loaded the first time a press asks.
 */

/** Migrate to <model>'s one card, on every press of it. */
export const MIGRATE_CARD = 'Verify runs the agent live from the switched calls, writes stubbed';

/** What a switch asks: its goldens, else its runs, else (neither named) every golden, as its job and its price both take it. */
const targetsOf = (s: MigrateSwitch): { goldens: readonly string[]; runs: readonly string[] } => (s.goldens.length ? { goldens: s.goldens, runs: [] } : { goldens: [], runs: s.runs ?? [] });

/** The `migrate` job's fields: every golden where it names none and no run; its scope and Stop at $ where the dialog gives them. */
const fieldsOf = (s: MigrateSwitch): Record<string, unknown> => {
  const { goldens, runs } = targetsOf(s);
  return { to: s.to, ...(s.from.length ? { from: [...s.from] } : {}), ...(goldens.length ? { goldens: [...goldens] } : runs.length ? { runs: [...runs] } : {}), ...(s.scope ? { scope: s.scope } : {}), ...(s.budget ? { budget: s.budget } : {}) };
};

/**
 * What a switch bills on what its job asks, its goldens or runs, in the scope it keeps to and held to
 * its Stop at $, the preview that asked it already, and the scopes its runs called in; nothing in an
 * exported copy or a read-only dashboard, undefined while it is worked out. A field's switch is read
 * once it has held still (`useSettled`), not on each keystroke: each read reads every golden's calls
 * on the pool.
 */
export function useMigrateEstimate(s: MigrateSwitch, ask = true): { estimate: Estimate | null | undefined; preview: MigrateEstimateView['preview']; scopes: MigrateEstimateView['scopes'] } {
  const { client, exported, actionsOff } = useApp();
  const on = ask && !exported && !actionsOff && !!s.to;
  const { goldens: g, runs: r } = targetsOf(s);
  const now = on ? JSON.stringify([s.to, s.from, g, r, s.scope ?? null, s.budget ?? null]) : '';
  const key = useSettled(now);
  const priced = useLoad(() => {
    if (!key) return null;
    const [to, from, goldens, runs, scope, budget] = JSON.parse(key) as [string, string[], string[], string[], string | null, number | null];
    return client.estimates?.migrateEstimate?.(to, from, goldens, runs, { scope, budget }) ?? null;
  }, `migrate-estimate:${key}`);
  // While the field still moves, what was read is another switch's: worked out, not shown.
  if (key !== now) return { estimate: on ? undefined : null, preview: null, scopes: [] };
  return { estimate: priced.data ? priced.data.estimate : priced.error || !on ? null : undefined, preview: priced.data?.preview ?? null, scopes: priced.data?.scopes ?? [] };
}

/**
 * Migrate to <model>, priced, asking first on every press: lime where it is the page's next step,
 * plain with why while it can't start (a server without the job, a job holding the tree, `why`: a
 * field that names no other model). None in an exported copy.
 */
export function MigrateButton({ s, label = `Migrate to ${s.to}`, lime = false, className = 'btn', why = null }: { s: MigrateSwitch; label?: string; lime?: boolean; className?: string; why?: string | null }) {
  const { MigrateToDialog } = useServedParts();
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
      ask={(start, close) => (MigrateToDialog ? <MigrateToDialog s={s} estimate={estimate} preview={preview} onOk={start} onClose={close} /> : null)}
    />
  );
}

/** Migrate's dialog opened without its button, as the palette's Migrate <a> to <b> asks for it; it stays for the consent ask its OK may bring. */
export function MigrateAskNow({ s }: { s: MigrateSwitch }) {
  const app = useApp();
  const { MigrateToDialog } = useServedParts();
  const [open, setOpen] = useState(true);
  const { estimate, preview } = useMigrateEstimate(s);
  const { start, consent } = useConsentStart(JOB_KINDS.migrate, fieldsOf(s));
  return (
    <>
      {open && MigrateToDialog ? <MigrateToDialog s={s} estimate={estimate} preview={preview} onOk={(more) => app.guard(() => void start({ ...sentEstimate(estimate), ...more }))} onClose={() => setOpen(false)} /> : null}
      {consent}
    </>
  );
}
