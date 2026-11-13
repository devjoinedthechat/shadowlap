import { useEffect, useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { ActionItem } from '../api.js';
import { useApp, type AppState } from '../state.js';
import { rowPriced, useRunEstimates, type RowPrice } from './estimates.js';

/**
 * What only a fork's dialog and the fork menu read (ActionDialog.tsx, ForkMenu.tsx), kept off the run
 * page: whether the run is a fork, and the dialog's estimate, Switch model's as its field names the
 * model. The page's own rows are priced by estimates.ts.
 */

/** Whether the run is a fork, as its Repeat says: a fork's attempts run live. */
export function isFork(actions: readonly Pick<ActionItem, 'key' | 'asksFirst'>[]): boolean {
  return !!actions.find((a) => a.key === 'e')?.asksFirst;
}

/** How long Switch model's field rests before the model in it is priced. */
const MODEL_WAIT = 250;

/**
 * Switch model's estimate as its field names the model: asked with `model=` once the field has
 * rested 250 ms, and undefined until that model's answer comes, so the line is always the field's
 * and an answer for a model since changed is dropped. An empty field asks nothing.
 */
export function useModelEstimate(runId: string, callNo: number | null, model: string): Estimate | null | undefined {
  const app = useApp() as Partial<AppState>;
  const api = app.client?.estimates;
  const off = !api || !!app.exported || !!app.actionsOff || callNo === null || !model;
  const [got, setGot] = useState<{ model: string; e: Estimate | null } | null>(null);
  useEffect(() => {
    if (off) return;
    let live = true;
    const wait = setTimeout(() => {
      api.runEstimates(runId, callNo, model).then(
        (r) => live && setGot({ model, e: r.actions.m ?? null }),
        () => live && setGot({ model, e: null }),
      );
    }, MODEL_WAIT);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [api, off, runId, callNo, model]);
  return !off && got?.model === model ? got.e : undefined;
}

/**
 * What a fork's dialog bills, as its Cost line says it and the job it starts keeps it: the row's
 * price as the menu showed it, else the run's estimates at the call, asked as the dialog opens (a
 * press from the next step or the banner brings none). Switch model's follows the model in its
 * field (`model`), and is as recorded while the field is empty.
 */
export function useDialogEstimate(runId: string, p: { action: Pick<ActionItem, 'key'>; callNo: number | null; estimate?: RowPrice }, fork: boolean, model = ''): RowPrice {
  const asked = useRunEstimates(runId, p.callNo);
  const named = p.action.key === 'm' ? model.trim() : '';
  const typed = useModelEstimate(runId, p.callNo, named);
  if (p.estimate === false) return false;
  if (named) return typed;
  return p.estimate ?? rowPriced(asked, p.action, fork);
}
