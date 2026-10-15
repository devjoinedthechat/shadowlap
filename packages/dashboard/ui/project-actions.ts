import { useSyncExternalStore } from 'react';

/**
 * Removing a project from the dashboard, as the project switcher's × does: Settings → Project's
 * "Remove from dashboard" opens the same dialog. The projects feature provides it from the
 * component that holds the dialog (`provideProjectRemoval`), and takes it back when that unmounts;
 * Settings reads it with `useProjectRemoval`. Without one, the only project there is can't be
 * removed, and the button says so.
 */

export interface ProjectRef {
  name: string;
  path: string;
  /** The project's id in the dashboard's list, when the server sends one. */
  id?: string;
}

export interface ProjectRemoval {
  /** Opens the Remove dialog for the project. */
  open(project: ProjectRef): void;
  /** Why it can't be removed now (the only project), or null. */
  blocked(project: ProjectRef): string | null;
}

let current: ProjectRemoval | null = null;
const listeners = new Set<() => void>();

/** Provides the dialog (or takes it back with null); returns what undoes it, for an effect's cleanup. */
export function provideProjectRemoval(removal: ProjectRemoval | null): () => void {
  current = removal;
  for (const l of listeners) l();
  return () => {
    if (current !== removal) return;
    current = null;
    for (const l of listeners) l();
  };
}

export function useProjectRemoval(): ProjectRemoval | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}

/** Why the only project can't be removed: what the button says when no dialog is provided. */
export const ONLY_PROJECT = 'The only project can’t be removed';
