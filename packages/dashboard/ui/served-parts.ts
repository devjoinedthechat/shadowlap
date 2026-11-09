import { createContext, useContext, type ComponentProps, type ComponentType } from 'react';
import type { OnShow } from './components/OnShow.js';
import type { ChangeBoxProps } from './revert/ChangeBox.js';
import type { RevertDialogProps } from './revert/RevertDialog.js';
import type { ShareMenu } from './run/ShareMenu.js';

/** What Share's menu takes (run/ShareMenu.tsx), named here so a page draws it without importing it. */
export type ShareMenuProps = ComponentProps<typeof ShareMenu>;

/**
 * The parts a page draws only where the dashboard runs, never in an exported copy, handed in by the
 * served entry (App.tsx, from pages/served.tsx) as it hands the shell its pages: a copy's script then
 * holds none of their code, and a page that finds one missing draws nothing in its place. What keeps
 * each undrawn in a copy is pinned by a test: test/ui-exported-copy.test.ts (a copy's run page draws
 * no Share, so nothing there opens Share's menu) and test/ui-revert-copy.test.ts (a copy's run has no
 * revert step and no offers, so no first bad commit to show, and its Tests page is not in it).
 */
export interface ServedParts {
  /** Share's menu (run/ShareMenu.tsx), with its Export dataset…: loaded ahead as the pointer or the focus reaches Share, so it opens at once. */
  ShareMenu?: OnShow<ShareMenuProps>;
  /** Revert's dialog (revert/RevertDialog.tsx), which every Revert button opens. */
  RevertDialog?: ComponentType<RevertDialogProps>;
  /** The first bad commit's change in its file's box (revert/ChangeBox.tsx), in the run page's inspector's place: Tests draws it at once. */
  ChangeBox?: ComponentType<ChangeBoxProps>;
}

export const ServedPartsContext = createContext<ServedParts>({});

/** The parts the served dashboard handed in; none in a copy. */
export const useServedParts = (): ServedParts => useContext(ServedPartsContext);
