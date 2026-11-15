import { useId } from 'react';
import { stopAt } from '../../src/decisions-argv.js';
import { Switch } from '../components/Switch.js';
import { toggled, ToggleChips } from '../components/ToggleChips.js';
import type { PreviewEstimates } from '../estimates-api.js';
import { goldenName } from '../format.js';

/**
 * What a new preview keeps to besides its change, in its dialog: of every golden, those picked; the
 * calls of one scope (the agent's, say, and not a simulated user's); for a model switch, the recorded
 * model it switches from, and for a field, the calls made with one model; whether it then verifies,
 * live, the runs it can't clear; and Stop at $, as Run injection test's. Each as `decisions` takes it
 * (decisions-argv.ts), so the command its dialog shows is the one its job runs.
 */
export interface Narrow {
  /** The goldens picked, of every golden it opened on; null for all of them. */
  goldens: readonly string[] | null;
  /** '' for every scope, `none` for the calls made in none, else a scope's name. */
  scope: string;
  /** '' for the default (the model the runs use most for a switch, every model for a field), else a recorded model. */
  from: string;
  thenVerify: boolean;
  /** Stop at $, as typed. */
  budget: string;
}

/** Nothing narrowed: what a preview asks as it opens. */
export const WHOLE: Narrow = { goldens: null, scope: '', from: '', thenVerify: false, budget: '' };

/** What the narrowing adds to the change, as the job and its estimate take it. */
export function narrowed(n: Narrow): { scope?: string; from?: string[]; thenVerify?: true; budget?: number } {
  const budget = stopAt(n.budget);
  return { ...(n.scope ? { scope: n.scope } : {}), ...(n.from ? { from: [n.from] } : {}), ...(n.thenVerify ? { thenVerify: true as const } : {}), ...(budget ? { budget } : {}) };
}

/** Why the way on waits for the narrowing: a Stop at $ that is no amount, or no golden left to ask. */
export function narrowWhy(n: Narrow): string | null {
  if (n.budget.trim() && stopAt(n.budget) === null) return 'Stop at $ is an amount in dollars above 0, such as 2.00';
  return n.goldens && !n.goldens.length ? 'Pick a golden to ask' : null;
}

/** A scope as its picker names it: its own name, or the calls made in none. */
const scopeLabel = (scope: string | null): string => scope ?? 'calls in no scope';

/** A preview's way, as its narrowing differs: a switch picks the model it switches from, a field the calls made with one; the changed prompt neither. */
export type NarrowWay = 'model' | 'field' | 'code';

/**
 * The narrowing's fields, under the change's own: Switch from (or Calls made with) where the runs use
 * more than one model, Scope where they called in more than one, Stop at $, the goldens as chips
 * where it opened on every golden (`goldens`, their pack folders), and Then verify.
 */
export function NarrowFields({ n, onChange, est, goldens, way }: { n: Narrow; onChange: (n: Narrow) => void; est: PreviewEstimates | undefined; goldens: readonly string[] | null; way: NarrowWay }) {
  const set = (patch: Partial<Narrow>) => onChange({ ...n, ...patch });
  const recorded = way === 'code' ? [] : (est?.recorded ?? []);
  const scopes = way === 'code' ? [] : (est?.scopes ?? []);
  return (
    <>
      <div className="form narrow">
        {recorded.length > 1 ? (
          <label>
            {way === 'model' ? 'Switch from' : 'Calls made with'}
            <select value={n.from} onChange={(e) => set({ from: e.currentTarget.value })}>
              <option value="">{way === 'model' ? 'the model used most' : 'every model'}</option>
              {recorded.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {scopes.length > 1 ? (
          <label>
            Scope
            <select value={n.scope} onChange={(e) => set({ scope: e.currentTarget.value })}>
              <option value="">every scope</option>
              {scopes.map((s) => (
                <option key={s.scope ?? ''} value={s.scope ?? 'none'}>
                  {scopeLabel(s.scope)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Stop at $
          <input type="number" min={0.01} step={0.5} placeholder="none" value={n.budget} onChange={(e) => set({ budget: e.currentTarget.value })} />
        </label>
      </div>
      {goldens && goldens.length > 1 ? <GoldenPicks all={goldens} picked={n.goldens ?? goldens} onPick={(picked) => set({ goldens: picked.length === goldens.length ? null : picked })} /> : null}
      <div className="nverify">
        <Switch on={n.thenVerify} onChange={(thenVerify) => set({ thenVerify })}>
          Then verify what it can’t clear
        </Switch>
      </div>
    </>
  );
}

/** The goldens it asks, a chip each, with how many of all and All and None, as Run injection test picks its templates. */
function GoldenPicks({ all, picked, onPick }: { all: readonly string[]; picked: readonly string[]; onPick: (picked: string[]) => void }) {
  const head = useId();
  return (
    <>
      <div className="nsec">
        <span className="k" id={head}>
          Goldens
        </span>
        <span className="n">
          {picked.length} of {all.length}
        </span>
        <span className="sp" />
        <button className="linkbtn" type="button" onClick={() => onPick([...all])}>
          All
        </button>
        <button className="linkbtn" type="button" onClick={() => onPick([])}>
          None
        </button>
      </div>
      <ToggleChips chips={all.map((id) => ({ id, label: goldenName(id) }))} picked={picked} labelledBy={head} onToggle={(id) => onPick(toggled(all, picked, id))} />
    </>
  );
}
