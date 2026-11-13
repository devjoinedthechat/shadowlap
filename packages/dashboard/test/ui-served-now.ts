import { createElement, type ComponentType, type ReactNode } from 'react';
import { ApplyConfigDialog } from '../ui/changes/ApplyConfigDialog.js';
import { MigrateToDialog } from '../ui/components/MigrateToDialog.js';
import { onShow, type OnShow } from '../ui/components/OnShow.js';
import { PackWithGate } from '../ui/injection/PackWithGate.js';
import { TestDialog } from '../ui/injection/TestDialog.js';
import { SERVED_PARTS } from '../ui/pages/served.js';
import { StepDialog } from '../ui/run/StepDialogs.js';
import { ServedPartsContext, type ServedParts } from '../ui/served-parts.js';

/** A part the served dashboard hands in, its script already in, as once it first came: it draws at once. */
export function shownNow<P extends object>(part: ComponentType<P>): OnShow<P> {
  const shown = onShow(() => Promise.resolve(part));
  shown.preload();
  return shown;
}

/** The dialogs the served dashboard hands the run page's steps and Tests' Pack as golden… (ui/run/StepDialogs.tsx), and Run injection test…'s and Pack with injection gate…'s (ui/injection/). */
export const STEP_PARTS: ServedParts = { StepDialog: shownNow(StepDialog), TestDialog: shownNow(TestDialog), PackWithGate: shownNow(PackWithGate) };

/** `child` as the served dashboard draws it, with the step dialogs handed in. */
export const withStepDialogs = (child: ReactNode) => createElement(ServedPartsContext.Provider, { value: STEP_PARTS }, child);

/** The dialogs the served dashboard hands Migrate to… (ui/components/MigrateToDialog.tsx) and the Migrate report's Apply config change (ui/changes/ApplyConfigDialog.tsx). */
export const MIGRATE_PARTS: ServedParts = { MigrateToDialog: shownNow(MigrateToDialog), ApplyConfigDialog: shownNow(ApplyConfigDialog) };

/** `child` as the served dashboard draws it, with Migrate's dialogs handed in. */
export const withMigrateDialogs = (child: ReactNode) => createElement(ServedPartsContext.Provider, { value: MIGRATE_PARTS }, child);

/** `child` as the served dashboard draws it, with every part its entry hands in (ui/pages/served.tsx), each loading as it first shows. */
export const withServed = (child: ReactNode) => createElement(ServedPartsContext.Provider, { value: SERVED_PARTS }, child);
