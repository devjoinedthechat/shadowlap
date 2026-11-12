import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { StepHooks } from './components/JobButton.js';
import { useApp } from './state.js';
import type { Price } from './tests-estimates.js';
import { errorText } from './toast.js';

/**
 * What a step drawn away from its own page reads as it is looked at or pressed: its estimate, and the
 * dialog it asks in once what that needs has come. A run's step on a list's row (steps/RunStep.tsx:
 * Needs a look's and Runs › Failed's issues'), Needs a look's other steps, a Fixes row's, and a
 * crash's Find breaking commit and Revert (revert/CrashStep.tsx) share them. No step's words or
 * rules here.
 */

/**
 * A step's estimate, asked for once the pointer or the focus reaches it (never as the page opens: a
 * list carries none), or as it first shows where it leads a page (`eager`), undefined until it comes
 * and null for none. `when` runs what a press does with it: at once where it has come, else once it
 * has, so a press before it came waits for it.
 */
export function usePriced(load: (() => Promise<Price>) | null, eager = false): { estimate: Price; on: StepHooks; when: (f: (e: Price) => void) => () => void } {
  const [estimate, setEstimate] = useState<Price>(load ? undefined : null);
  const asked = useRef<Promise<Price> | null>(null);
  const prime = (): Promise<Price> =>
    (asked.current ??= (load ? load() : Promise.resolve(null))
      .then(
        (e) => e ?? null,
        () => null,
      )
      .then((e) => {
        setEstimate(e);
        return e;
      }));
  // As it first shows: `prime` asks no more than once.
  useEffect(() => {
    if (eager) void prime();
  });
  const when = (f: (e: Price) => void) => () => (estimate !== undefined ? f(estimate) : void prime().then(f));
  return { estimate, on: { onPointerEnter: () => void prime(), onFocus: () => void prime() }, when };
}

/** The dialog a step asks in, drawn once what it needs has come (the fix, the goldens, the run's offers, its script). */
export function useAsking(): [ReactNode, (build: (close: () => void) => Promise<ReactNode>) => void] {
  const { toast } = useApp();
  const [node, setNode] = useState<ReactNode>(null);
  const close = () => setNode(null);
  return [node, (build) => void build(close).then(setNode, (err: unknown) => toast(errorText(err), 'error'))];
}
