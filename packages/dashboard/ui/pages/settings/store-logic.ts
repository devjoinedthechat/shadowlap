import type { StoreSetupView } from '../../store-api.js';

/**
 * What Settings → Store shows, worked out apart from the page so it can be tested: no store yet,
 * the setup's four steps, or the store as it stands; and in the setup, which step is done, which
 * is the current one, and which are still to do.
 */

export type SetupStepState = 'done' | 'cur' | 'todo';

export interface SetupStates {
  connect: SetupStepState;
  push: SetupStepState;
  ci: SetupStepState;
  team: SetupStepState;
}

/** Each step done, in order, the first not done is the current one: every step unlocks the next. */
export function setupStates(view: Pick<StoreSetupView, 'connected' | 'pushed' | 'runs' | 'setup'>, finishedNow = false): SetupStates {
  const done = [
    view.connected,
    // Nothing only on this machine: there is nothing to push, so the step is done.
    view.connected && (view.pushed || view.runs.onlyLocal === 0),
    view.setup.ci !== null,
    finishedNow || view.setup.finishedAt !== null,
  ];
  const first = done.indexOf(false);
  const state = (i: number): SetupStepState => (done[i] && (first === -1 || i < first) ? 'done' : i === first ? 'cur' : 'todo');
  return { connect: state(0), push: state(1), ci: state(2), team: state(3) };
}

export type StoreTabMode = 'no-store' | 'setup' | 'store';

/**
 * No store yet, until someone starts the setup; the setup while it is under way (started on this
 * page, or here before and not finished, or finished a moment ago, so its last step and Go to the
 * overview stay in view); the store as it stands otherwise, which is also what a store set with the
 * CLI shows.
 */
export function storeTabMode(o: { configured: boolean; setupActive: boolean; starting: boolean; finishedNow: boolean }): StoreTabMode {
  if (o.finishedNow || o.starting) return 'setup';
  if (!o.configured) return 'no-store';
  return o.setupActive ? 'setup' : 'store';
}
