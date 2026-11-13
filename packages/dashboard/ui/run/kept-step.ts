import { useSyncExternalStore } from 'react';
import type { NextStep } from '../types.js';

/**
 * The step a run's page leads with, as it last read it (`at`, this browser's clock), for a drawer to
 * offer once its job has ended there: an injection test's Re-run injection test, a cause's Pack with
 * injection gate…. One run's page at a time; null once it closes.
 */
export interface KeptStep {
  runId: string;
  key: NextStep['key'];
  label: string;
  at: number;
}

let kept: KeptStep | null = null;
const listeners = new Set<() => void>();

/** What a run's page leads with, each time it reads its step; null once it leads with nothing or closes. */
export function keepStep(runId: string | null, step: Pick<NextStep, 'key' | 'label'> | null): void {
  kept = runId && step ? { runId, key: step.key, label: step.label, at: Date.now() } : null;
  for (const on of listeners) on();
}

const subscribe = (on: () => void) => {
  listeners.add(on);
  return () => {
    listeners.delete(on);
  };
};

/** The step the run's page on the screen last read. */
export const useKeptStep = (): KeptStep | null => useSyncExternalStore(subscribe, () => kept);
