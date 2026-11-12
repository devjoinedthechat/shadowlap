import { useEffect, useId, useRef, useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { PayloadTemplate } from '../../../engine/src/injection.js';
import { ErrorState, failedRead, Skeleton } from '../components/States.js';
import { toggled, ToggleChips } from '../components/ToggleChips.js';
import type { Loaded } from '../hooks.js';
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
 * only its pack holds (`runId` null) is priced from its pack.
 */
export function usePlanEstimate(on: { runId: string | null; golden?: string | null | undefined }, plan: PlanPicks, first: Estimate | null | undefined): Estimate | null | undefined {
  const { client } = useApp();
  const [estimate, setEstimate] = useState(first);
  const { payloads, repeat, budget = null, gate = false } = plan;
  const { runId } = on;
  const golden = runId ? null : (on.golden ?? null);
  const key = `${payloads}:${repeat}:${budget ?? ''}`;
  const priced = useRef(first === undefined ? null : key);
  useEffect(() => {
    if ((!runId && !golden) || !payloads || priced.current === key) return;
    let alive = true;
    const t = setTimeout(() => {
      void client.injectionEstimate({ runId, ...(golden ? { golden } : {}), payloads, repeat, budget, ...(gate ? { gate } : {}) }).then(
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
  }, [client, runId, golden, payloads, repeat, budget, gate, key]);
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

/**
 * The dialog's body until its reads come: the run's untrusted reads as quiet bars, or a read that
 * failed in the line every page says (`failedRead`), with Retry, which asks again what failed.
 */
export function ReadsWait({ loads }: { loads: readonly Loaded<unknown>[] }) {
  const failed = loads.find((l) => l.error)?.error;
  if (!failed) return <Skeleton what="the run’s untrusted reads" lines={3} />;
  return <ErrorState retry={() => loads.forEach((l) => l.error && l.reload())}>{failedRead(failed)}</ErrorState>;
}
