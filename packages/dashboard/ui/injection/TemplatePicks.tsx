import { useEffect, useId, useRef, useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { PayloadTemplate } from '../../../engine/src/injection.js';
import { toggled, ToggleChips } from '../components/ToggleChips.js';
import { useApp } from '../state.js';

/*
 * What Run injection test… and Pack with injection gate… pick alike (TestDialog.tsx, PackWithGate.tsx),
 * both parts only the served dashboard hands in: the templates, a chip each with All and None, and
 * what the picks bill, asked of the server (the estimators read node modules, so the browser never
 * works out a price).
 */

/** A plan as the server prices it: how many payloads, attempts each, Stop at $, and whether it is each test session's gate. */
export interface PlanPicks {
  payloads: number;
  repeat: number;
  budget?: number | null;
  gate?: boolean;
}

/**
 * What the picks bill, from the server: the opener's price for the plan nobody picked, then asked
 * again 250 ms after a pick, the last answer kept until the next comes. A golden whose recording
 * only its pack holds is priced by its opener alone.
 */
export function usePlanEstimate(runId: string | null, plan: PlanPicks, first: Estimate | null | undefined): Estimate | null | undefined {
  const { client } = useApp();
  const [estimate, setEstimate] = useState(first);
  const { payloads, repeat, budget = null, gate = false } = plan;
  const key = `${payloads}:${repeat}:${budget ?? ''}`;
  const priced = useRef(first === undefined ? null : key);
  useEffect(() => {
    if (!runId || !payloads || priced.current === key) return;
    let alive = true;
    const t = setTimeout(() => {
      void client.injectionEstimate({ runId, payloads, repeat, budget, ...(gate ? { gate } : {}) }).then(
        (e) => {
          if (!alive) return;
          priced.current = key;
          setEstimate(e);
        },
        () => undefined,
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [client, runId, payloads, repeat, budget, gate, key]);
  return estimate;
}

/** Templates: how many of the set are picked, why it starts from fewer where it does, All and None, and a chip for each. */
export function TemplatePicks({ all, why, picked, onPick }: { all: readonly PayloadTemplate[]; why?: string | null; picked: readonly string[]; onPick: (ids: string[]) => void }) {
  const head = useId();
  const ids = all.map((t) => t.id);
  return (
    <>
      <div className="injsec">
        <span className="k" id={head}>
          Templates
        </span>
        <span className="injn">
          {picked.length} of {all.length}
        </span>
        {why ? (
          <span className="injwhy">
            <span className="injdot" aria-hidden="true">
              ·{' '}
            </span>
            {why}
          </span>
        ) : null}
        <span className="sp" />
        <button className="linkbtn" type="button" onClick={() => onPick(ids)}>
          All
        </button>
        <button className="linkbtn" type="button" onClick={() => onPick([])}>
          None
        </button>
      </div>
      <ToggleChips chips={all} picked={picked} labelledBy={head} onToggle={(id) => onPick(toggled(ids, picked, id))} />
    </>
  );
}
