import { consentAsked } from '../actions.js';
import type { RowStep } from '../list-keys.js';
import { href } from '../route.js';
import { currentRoute, navigate } from '../router.js';
import type { AppState } from '../state.js';
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

/** What starts a row's Replay where it is: the app's. */
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
 * The palette's builder for a run row's next step and its Replay: a link goes where it goes, Replay
 * starts where it is when `app` is given, and any other step opens the run and presses that button
 * there. None while it can't start (`off`), nor a job while actions are paused, as This run leaves it
 * out then.
 */
export function rowStep(actionsOff: string | null, toast: (text: string) => void, app?: Starts): RowStep {
  return (runId, next) => {
    if (next.off || (!next.href && actionsOff)) return null;
    const { group, key, ...entry } = stepEntry(next);
    const onPage = () => openAndPress(runId, next.key, toast);
    return { ...entry, run: () => (next.href ? navigate(next.href) : next.key === 'replay' && app ? replayHere(app, next.runId ?? runId, next.label, onPage) : onPage()) };
  };
}
