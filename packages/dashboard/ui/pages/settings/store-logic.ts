import { setupDone } from '../../../src/store-steps.js';
import type { StoreSetupView } from '../../store-api.js';

/**
 * The team store's setup page, worked out apart from the page so it can be tested: which step is
 * done, which is the current one, and which are still to do. The steps' rule is the server's own
 * (src/store-steps.ts), which Needs a look and the palette read too.
 */

export type SetupStepState = 'done' | 'cur' | 'todo';

export interface SetupStates {
  connect: SetupStepState;
  push: SetupStepState;
  ci: SetupStepState;
  team: SetupStepState;
}

/**
 * Each step done, in order, and the first not done is the current one: every step unlocks the
 * next. Nothing only on this machine leaves nothing to push, so that step counts as done.
 */
export function setupStates(view: Pick<StoreSetupView, 'connected' | 'pushed' | 'runs' | 'setup'>, finishedNow = false): SetupStates {
  const done = setupDone({ connected: view.connected, pushed: view.pushed, onlyLocal: view.runs.onlyLocal, ci: view.setup.ci, finished: finishedNow || view.setup.finishedAt !== null });
  const first = done.indexOf(false);
  const state = (i: number): SetupStepState => (done[i] ? 'done' : i === first ? 'cur' : 'todo');
  return { connect: state(0), push: state(1), ci: state(2), team: state(3) };
}
