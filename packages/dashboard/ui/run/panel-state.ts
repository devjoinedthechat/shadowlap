import { useCallback, useSyncExternalStore } from 'react';

/**
 * What a finding opened in the inspector's place on a run's page (InspectorPanel.tsx): its diff, the
 * change at its first bad commit, or results, `key` naming which (`injection:<result id>`, `presets`).
 * One at a time on a run's page, the newest opened. Kept here, outside the page, so it outlives a
 * visit to another run: a cell of the results opens its attempt's run, and Esc comes back to them
 * still open. Each run keeps its results while another opens its own or a diff; a diff or a change is
 * one at a time across runs, the newest opened, as the mock's Show diff is. A pick of a call gives the
 * inspector back on its own run's page only, never on the run you came from.
 */
export type Panel = { runId: string; kind: 'diff' } | { runId: string; kind: 'change' } | { runId: string; kind: 'results'; key: string };

/** The run whose diff or change is open, if any. */
let diff: Panel | null = null;
/** Each run's open results, by its id. */
const results = new Map<string, Panel>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The panel open on a run's page, or null: the same object until it changes, as a store's reads must be. */
export const panelOn = (runId: string): Panel | null => results.get(runId) ?? (diff?.runId === runId ? diff : null);

/** The panel open on a run's page, drawn again as it opens and closes. */
export function usePanel(runId: string): Panel | null {
  const read = useCallback(() => panelOn(runId), [runId]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Opens a run's diff, or the change at its first bad commit (`kind`), in place of its results. Another run's diff or change closes; its results stay. */
export function openDiff(runId: string, kind: 'diff' | 'change' = 'diff'): void {
  results.delete(runId);
  diff = { runId, kind };
  changed();
}

/** Opens results on a run's page, in place of its diff: from its finding's toggle, or before a link navigates there. */
export function openResults(runId: string, key: string): void {
  if (diff?.runId === runId) diff = null;
  results.set(runId, { runId, kind: 'results', key });
  changed();
}

/** Gives the inspector back on a run's page: a pick of a call, Hide, Esc, the inspector's keys. Another run's panel stays. */
export function closePanelOn(runId: string): void {
  if (!panelOn(runId)) return;
  results.delete(runId);
  if (diff?.runId === runId) diff = null;
  changed();
}

/** Forgets every run's panel: for the tests, whose pages share this module. */
export function resetPanel(): void {
  diff = null;
  results.clear();
}
