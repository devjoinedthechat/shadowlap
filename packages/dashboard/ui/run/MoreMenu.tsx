import { useState } from 'react';
import type { RunDetail, RunOffers } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { onShow } from '../components/OnShow.js';
import { Popover } from '../components/Popover.js';
import { shortId } from '../format.js';
import { useApp } from '../state.js';
import { pendingRunOf, useDeleteRun } from './delete-run.js';
import type { MoreRow } from './fit-head.js';

/*
 * The header's …, a part of its own that only the served dashboard hands in (served-parts.ts): a run
 * page needs it rarely, and an exported copy draws none of the header's actions, so its script holds
 * none of it, nor Delete run's helper (delete-run.ts).
 */

/** Delete run's dialog, which a run's page rarely opens: a part of its own, with Find breaking commit's (OnShow.tsx). */
const DeleteRunDialog = onShow(() => import('./RunDialogs.js').then((m) => m.DeleteRunDialog));

/** Why a recording can't be deleted yet: the server refuses it. */
const DELETE_WAITS = 'A run that is still recording can’t be deleted';

/**
 * The header's … once opened: what a run page needs rarely. The buttons the header folded in, where
 * they would have wrapped, each as it was (its card, its wait, a press of the button itself, so its
 * own dialog opens as from the header), then Delete run, which waits while the run records. The
 * header keeps it once asked for, so Delete run's dialog outlives the menu.
 */
export function MoreMenu({ more, rows, run, offers, live }: { more: { open: boolean; anchor: HTMLElement | null; close: () => void }; rows: readonly MoreRow[]; run: RunDetail; offers: RunOffers | null; live: boolean }) {
  const { guard, toast } = useApp();
  const [deleting, setDeleting] = useState(false);
  const deleteRun = useDeleteRun();
  const id = shortId(run.run.runId);
  const pick = (row: MoreRow) => {
    more.close();
    if (row.off) toast(row.why ?? row.label, 'notice');
    else row.press();
  };
  return (
    <>
      {more.open && more.anchor ? (
        <Popover anchor={more.anchor} onClose={more.close} label="More actions" className="fkm more narrow">
          {rows.map((row) =>
            row.href && !row.why ? (
              <a key={row.key} role="menuitem" href={row.href} data-tip={row.tip ?? undefined} onClick={more.close}>
                <b>{row.label}</b>
              </a>
            ) : (
              <button key={row.key} type="button" role="menuitem" aria-disabled={row.why ? 'true' : undefined} data-why={row.why ?? undefined} data-tip={row.tip ?? undefined} onClick={() => pick(row)}>
                <b>{row.label}</b>
              </button>
            ),
          )}
          {rows.length ? <hr /> : null}
          <ActionButton role="menuitem" className="dz" why={live ? DELETE_WAITS : null} tip={`Delete ${id}`} sub="Removes the run, its attempts and the recorded data nothing else uses; asks first" command={`$ shadowlap rm ${id}`} onClick={() => guard(() => (more.close(), setDeleting(true)))}>
            <b>Delete run</b>
            <small>rm</small>
          </ActionButton>
        </Popover>
      ) : null}
      {deleting ? (
        // As Runs' Delete and `shadowlap rm` delete it: with the attempts bundled under it, named here
        // and counted when it is done.
        <DeleteRunDialog runId={run.run.runId} attempts={run.attempts ?? 0} onClose={() => setDeleting(false)} onOk={() => deleteRun(pendingRunOf(run, offers))} />
      ) : null}
    </>
  );
}
