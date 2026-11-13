import { useEffect, useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { ActionItem } from '../api.js';
import type { RunEstimates } from '../estimates-api.js';
import { useApp, type AppState } from '../state.js';

/** A row's price: the server's estimate, null for none, undefined until it answers, false for a row that bills nothing. */
export type RowPrice = Estimate | null | undefined | false;

/**
 * What a run's billed jobs would cost at a call (`GET /api/runs/:id/estimates?at=`): Run blame and each
 * fork menu row, worked out beside the server. Asked when the menu opens on a call, never as a call is
 * selected, and kept for the page by run and call, so the menu opened again there says them at once.
 */
const held = new Map<string, RunEstimates>();

/**
 * The estimates at `callNo` (null, the whole run's): undefined until the server answers, and where
 * nothing can start (an exported copy, a read-only dashboard, a stand-in with no client), so a card
 * has no line; null after a read that failed, so each billed row asks. `callNo` undefined asks nothing yet.
 */
export function useRunEstimates(runId: string, callNo: number | null | undefined): RunEstimates | null | undefined {
  const app = useApp() as Partial<AppState>;
  const api = app.client?.estimates;
  const off = !api || !!app.exported || !!app.actionsOff;
  const k = `${runId}:${callNo ?? 'run'}`;
  const [failed, setFailed] = useState<string | null>(null);
  const [, redraw] = useState(0);
  useEffect(() => {
    if (off || callNo === undefined || held.has(k)) return;
    let live = true;
    api.runEstimates(runId, callNo).then(
      (e) => {
        held.set(k, e);
        if (live) redraw((n) => n + 1);
      },
      () => live && setFailed(k),
    );
    return () => {
      live = false;
    };
  }, [api, off, runId, callNo, k]);
  if (off || callNo === undefined) return undefined;
  return failed === k ? null : held.get(k);
}

/** Rows that bill nothing, whatever the run: Replay, a suggested normalizer, Pack. */
const FREE_ROWS = new Set(['r', 'n', 'p']);

/**
 * A fork menu row's price as its card and its press take it: `false` for a row that bills nothing (it
 * starts with no estimate at all, before the server answers too), so a recording's Repeat and its
 * stubbed replay, which replay only; else the server's estimate, null for none, undefined until it
 * answers. The browser tells a fork by its Repeat's `asksFirst`, which the engine sets where a repeat
 * runs live.
 */
export function rowPriced(e: RunEstimates | null | undefined, action: Pick<ActionItem, 'key'>, fork: boolean): RowPrice {
  if (FREE_ROWS.has(action.key) || (!fork && (action.key === 'e' || action.key === 's'))) return false;
  if (e === undefined) return undefined;
  return e?.actions[action.key] ?? null;
}

/** What the page already holds at a call, asking nothing: a control that shows as a call is selected (Edit and fork) says its amount only then. */
export function heldRunEstimates(runId: string, callNo: number | null): RunEstimates | undefined {
  return held.get(`${runId}:${callNo ?? 'run'}`);
}

/** For tests: forget what the page held. */
export function forgetRunEstimates(): void {
  held.clear();
}
