import { createContext, useContext, type ComponentProps } from 'react';
import type { OnShow } from './components/OnShow.js';
import type { InjectionResults } from './injection/InjectionResults.js';
import type { ShareMenu } from './run/ShareMenu.js';
import type { StepDialog } from './run/StepDialogs.js';

/** What Share's menu takes (run/ShareMenu.tsx), named here so a page draws it without importing it. */
export type ShareMenuProps = ComponentProps<typeof ShareMenu>;
export type InjectionResultsProps = ComponentProps<typeof InjectionResults>;
export type StepDialogProps = ComponentProps<typeof StepDialog>;

/**
 * The parts a page draws only where the dashboard runs, never in an exported copy, handed in by the
 * served entry (App.tsx, from pages/served.tsx) as it hands the shell its pages: a copy's script then
 * holds none of their code, and a page that finds one missing draws nothing in its place. What keeps
 * each undrawn in a copy is pinned by a test (test/ui-exported-copy.test.ts: a copy's run page draws
 * no Share, so nothing there opens Share's menu; a copy keeps no injection results, so its run page
 * draws no test's finding to open them from; a copy's run page draws no step that asks).
 */
export interface ServedParts {
  /** Share's menu (run/ShareMenu.tsx), with its Export dataset…: loaded ahead as the pointer or the focus reaches Share, so it opens at once. */
  ShareMenu?: OnShow<ShareMenuProps>;
  /** An injection test's results in the inspector's place (injection/InjectionResults.tsx), with the matrix they draw: loaded ahead as the pointer or the focus reaches Show results. */
  InjectionResults?: OnShow<InjectionResultsProps>;
  /** The dialogs the run page's steps ask in, Pack as golden…'s too (run/StepDialogs.tsx): loaded as one first shows. */
  StepDialog?: OnShow<StepDialogProps>;
}

export const ServedPartsContext = createContext<ServedParts>({});

/** The parts the served dashboard handed in; none in a copy. */
export const useServedParts = (): ServedParts => useContext(ServedPartsContext);
