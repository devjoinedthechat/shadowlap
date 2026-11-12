import { createElement, type ComponentType, type ReactNode } from 'react';
import { onShow, type OnShow } from '../ui/components/OnShow.js';
import { StepDialog } from '../ui/run/StepDialogs.js';
import { ServedPartsContext, type ServedParts } from '../ui/served-parts.js';

/** A part the served dashboard hands in, its script already in, as once it first came: it draws at once. */
export function shownNow<P extends object>(part: ComponentType<P>): OnShow<P> {
  const shown = onShow(() => Promise.resolve(part));
  shown.preload();
  return shown;
}

/** The dialogs the served dashboard hands the run page's steps and Tests' Pack as golden… (ui/run/StepDialogs.tsx). */
export const STEP_PARTS: ServedParts = { StepDialog: shownNow(StepDialog) };

/** `child` as the served dashboard draws it, with the step dialogs handed in. */
export const withStepDialogs = (child: ReactNode) => createElement(ServedPartsContext.Provider, { value: STEP_PARTS }, child);
