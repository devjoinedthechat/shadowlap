import { consentAsked } from '../actions.js';
import { JOB_KINDS } from '../api.js';
import type { RowStep } from '../list-keys.js';
import { blameAsksOnItsPage } from '../palette.js';
import { href } from '../route.js';
import { currentRoute, navigate } from '../router.js';
import type { AppState } from '../state.js';
import type { NextStepRow } from '../types.js';
import { stepEntry } from './next-step.js';

/**
 * A run's next step on its row, for ⌘K on it in a list: what the run's lime button says and what it
 * runs or where it goes, as This run's first entry has them, but no key: `b`, `r` and `c` press it on
 * its page only, and a key shows only where pressing it does what it says. The palette's own script
 * builds it, so the first look holds none of a step's words.
 */

/** How long a step picked on a row waits for its run's page to draw the button it presses. */
export const PRESS_WAIT_MS = 10_000;

/** How often it looks again while the page draws. */
const LOOK_MS = 100;

/**
 * Opens the run and presses its lime button once the page draws it, as This run's entry presses it,
 * so the step asks and waits as its button does, and one that is off says why. It presses nothing
 * where the page leads with another step by then, and gives up on another page or after the wait.
 */
export function openAndPress(runId: string, key: string, toast: (text: string) => void): void {
  navigate(href.run(runId));
  const until = Date.now() + PRESS_WAIT_MS;
  const look = (): void => {
    const route = currentRoute();
    if (route.page !== 'run' || route.id !== runId) return;
    const drawn = document.querySelector('.rhead h1.rnm')?.getAttribute('title') === runId;
    const lead = drawn ? document.querySelector<HTMLButtonElement>('.rhead [data-next]') : null;
    if (!lead) {
      if (Date.now() < until) setTimeout(look, LOOK_MS);
      return;
    }
    if (lead.getAttribute('data-next') !== key) return;
    const why = lead.getAttribute('title');
    if (!lead.disabled) lead.click();
    else if (why) toast(why);
  };
  setTimeout(look);
}

/** What starts a row's Replay or Run blame where it is: the app's. */
type Starts = Pick<AppState, 'client' | 'guard' | 'watchJob'>;

/**
 * Replay from a row, as the header's Replay starts it, on the run it replays (`target`): here, unless
 * it asks first, for your command (its label's `…`) or whether to run someone else's (a 409 that
 * asks), which the run's page does.
 */
function replayHere(app: Starts, target: string, label: string, onPage: () => void): void {
  if (label.endsWith('…')) return onPage();
  app.guard(
    () =>
      void app.client.action(target, 'r', null).then(
        (job) => app.watchJob(Promise.resolve(job)),
        (err: unknown) => (consentAsked(err) ? onPage() : app.watchJob(Promise.reject(err))),
      ),
  );
}

/**
 * Run blame from a row, as the palette's own Run blame starts it: here, unless it asks first, for your
 * command on a capture, the check, or a yes to someone else's command, which the run's page does.
 */
function blameHere(app: Starts, runId: string, capture: boolean, onPage: () => void): void {
  if (capture) return onPage();
  app.guard(
    () =>
      void app.client.startJob(JOB_KINDS.blame, { runId }).then(
        (job) => app.watchJob(Promise.resolve(job)),
        (err: unknown) => (blameAsksOnItsPage(err) ? onPage() : app.watchJob(Promise.reject(err))),
      ),
  );
}

/** Picking a row's step: a link goes there, Replay and Run blame start here with `app`, and any other step opens the run to press it. */
function pick(app: Starts | undefined, runId: string, next: NextStepRow, onPage: () => void): void {
  if (next.href) return navigate(next.href);
  if (app && next.key === 'replay') return replayHere(app, next.runId ?? runId, next.label, onPage);
  if (app && next.key === 'blame') return blameHere(app, runId, next.capture === true, onPage);
  onPage();
}

/**
 * The palette's builder for a run row's next step and its Replay: a link goes where it goes, Replay
 * and Run blame start where they are when `app` is given, and any other step opens the run and
 * presses that button there. None while it can't start (`off`), nor a job while actions are paused,
 * as This run leaves it out then.
 */
export function rowStep(actionsOff: string | null, toast: (text: string) => void, app?: Starts): RowStep {
  return (runId, next) => {
    if (next.off || (!next.href && actionsOff)) return null;
    const { group, key, ...entry } = stepEntry(next);
    return { ...entry, run: () => pick(app, runId, next, () => openAndPress(runId, next.key, toast)) };
  };
}
