import { useSyncExternalStore, type ComponentType } from 'react';

/**
 * Removing the current project from the dashboard, as the project switcher's × does: Settings →
 * Project's Remove project… opens the projects feature's own dialog. That feature provides
 * the dialog and the current project (`provideProjectRemoval`, from the component that holds the
 * project list) and takes them back when it unmounts; Settings renders the dialog in its own page,
 * so it shows wherever the sidebar is. Without one (a dashboard that serves one folder), the only
 * project there is can't be removed, and the button says so.
 */

export interface ProjectRemoval {
  /** The current project's id in the dashboard's list, and why it can't be removed now (the only one), or null. */
  current(): { id: string; blocked: string | null } | null;
  /** The projects feature's Remove dialog for a project. */
  Dialog: ComponentType<{ id: string; onClose: () => void }>;
}

let provided: ProjectRemoval | null = null;
const listeners = new Set<() => void>();

/** Provides the dialog (or takes it back with null); returns what undoes it, for an effect's cleanup. */
export function provideProjectRemoval(removal: ProjectRemoval | null): () => void {
  provided = removal;
  for (const l of listeners) l();
  return () => {
    if (provided !== removal) return;
    provided = null;
    for (const l of listeners) l();
  };
}

export function useProjectRemoval(): ProjectRemoval | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => provided,
    () => provided,
  );
}

/** Why the only project can't be removed: what the button says when no dialog is provided. */
export const ONLY_PROJECT = 'The only project can’t be removed';
