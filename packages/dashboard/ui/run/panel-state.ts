import { useSyncExternalStore } from 'react';

/**
 * What a finding opened in the inspector's place on a run's page (InspectorPanel.tsx): its diff, or
 * results, `key` naming which (`injection:<result id>`, `presets`). One at a time, the newest opened.
 * Kept here, outside the page, so it outlives a visit to another run: a cell of the results opens its
 * attempt's run, and Esc comes back to them still open. A pick of a call gives the inspector back on
 * its own run's page only, never on the run you came from.
 */
export type Panel = { runId: string; kind: 'diff' } | { runId: string; kind: 'results'; key: string };

let open: Panel | null = null;
const listeners = new Set<() => void>();

function set(next: Panel | null): void {
  open = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const current = (): Panel | null => open;

/** The panel open on a run's page, or null. */
export const panelOn = (runId: string): Panel | null => (open?.runId === runId ? open : null);

/** The panel open on a run's page, drawn again as it opens and closes. */
export function usePanel(runId: string): Panel | null {
  const p = useSyncExternalStore(subscribe, current, current);
  return p?.runId === runId ? p : null;
}

export const openDiff = (runId: string): void => set({ runId, kind: 'diff' });

/** Opens results on a run's page: from its finding's toggle, or before a link navigates there. */
export const openResults = (runId: string, key: string): void => set({ runId, kind: 'results', key });

/** Gives the inspector back on a run's page: a pick of a call, Hide, Esc, the inspector's keys. */
export function closePanelOn(runId: string): void {
  if (open?.runId === runId) set(null);
}

/** Forgets the panel: for the tests, whose pages share this module. */
export function resetPanel(): void {
  open = null;
}
