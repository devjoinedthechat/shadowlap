import { useEffect, useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { FixEstimates } from '../estimates-api.js';
import type { TipEst } from '../components/HoverCard.js';
import { ACTIONS } from '../labels.js';
import { tipEst } from '../spending.js';
import { useApp, type AppState } from '../state.js';
import type { FixDetail } from '../types.js';

/**
 * What a fix's billed jobs would cost (`GET /api/fixes/:id/estimates`): Run repair, Run blame again
 * and with a stronger model, and each Verify step's, worked out beside the server.
 */

/** How long the Model field rests before Run blame with stronger model is priced at it, as Switch model's does. */
const MODEL_WAIT = 250;

/** One read for each answer of the fix's, however many of its buttons ask. */
const asked = new WeakMap<object, Promise<FixEstimates>>();

/**
 * The fix's estimates, asked as its page opens and again whenever its answer moves (a job ended, a
 * dialog read it again): undefined until the server answers for that answer, and where nothing can
 * start (an exported copy, a read-only dashboard, a stand-in with no client); null after a read that
 * failed, so each billed button asks.
 */
export function useFixEstimates(fix: Pick<FixDetail, 'fixId'>): FixEstimates | null | undefined {
  const app = useApp() as Partial<AppState>;
  const api = app.client?.estimates;
  const off = !api || !!app.exported || !!app.actionsOff;
  const [got, setGot] = useState<{ fix: object; e: FixEstimates | null } | null>(null);
  useEffect(() => {
    if (off) return;
    let live = true;
    let read = asked.get(fix);
    if (!read) {
      read = api.fixEstimates(fix.fixId);
      asked.set(fix, read);
    }
    read.then(
      (e) => live && setGot({ fix, e }),
      () => live && setGot({ fix, e: null }),
    );
    return () => {
      live = false;
    };
  }, [api, off, fix]);
  return off || got?.fix !== fix ? undefined : got.e;
}

/**
 * Run blame with stronger model's estimate at the model its field names: asked with `model=` once the
 * field has rested 250 ms, undefined until that model's answer comes, so the line is always the
 * field's; an empty field asks nothing.
 */
export function useStrongerEstimate(fixId: string, model: string): Estimate | null | undefined {
  const app = useApp() as Partial<AppState>;
  const api = app.client?.estimates;
  const off = !api || !!app.exported || !!app.actionsOff || !model;
  const [got, setGot] = useState<{ model: string; e: Estimate | null } | null>(null);
  useEffect(() => {
    if (off) return;
    let live = true;
    const wait = setTimeout(() => {
      api.fixEstimates(fixId, model).then(
        (r) => live && setGot({ model, e: r.blameStronger }),
        () => live && setGot({ model, e: null }),
      );
    }, MODEL_WAIT);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [api, off, fixId, model]);
  return !off && got?.model === model ? got.e : undefined;
}

/** What Run blame again or with a stronger model bills, as the fix's estimates price the blame its page offers next. */
export function blameNextPrice(kind: 'again' | 'stronger', e: FixEstimates | null | undefined): Estimate | null | undefined {
  if (e === undefined) return undefined;
  return (kind === 'again' ? e?.blameAgain : e?.blameStronger) ?? null;
}

/** Run repair's sentence: whom it asks for rewrites, the repairer the config names or, with none, your own Claude Code. */
export const repairSub = (repairer: string | null): string => `Asks ${repairer ?? 'your own Claude Code'} for rewrites; each is tried in a worktree of its own`;

/**
 * Run repair's card: whom it asks for rewrites, or why it would end with no fix to try (`aside`), its
 * command, and what it bills, asking first on every setting, for what it does. Apply fix bills nothing
 * and has none.
 */
export function repairCard(f: Pick<FixDetail, 'actions' | 'repairer'>, kind: string, aside: string | null, e: FixEstimates | null | undefined): { tip?: string; sub?: string; command?: string; est?: TipEst | null } {
  if (kind !== 'repair') return {};
  const command = f.actions.repair?.command;
  return { tip: ACTIONS.runRepair.label, sub: aside ?? repairSub(f.repairer.configured ? f.repairer.name : null), ...(command ? { command: `$ ${command}` } : {}), est: tipEst(e === undefined ? undefined : (e?.repair ?? null)) };
}

/** A Verify step's Run more attempts or Verify again, as the fix's estimates price it: none for a step they don't price. */
export function verifyPrice(e: FixEstimates | null | undefined, verifyId: string): Estimate | null | undefined {
  return e === undefined ? undefined : (e?.verify[verifyId] ?? null);
}
