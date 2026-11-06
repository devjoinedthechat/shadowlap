import type { RowStep } from '../list-keys.js';
import { href } from '../route.js';
import { currentRoute, navigate } from '../router.js';
import { stepEntry } from './next-step.js';

/**
 * A run's next step on its row, for ⌘K on it in a list: what the run's lime button says, what it
 * runs or where it goes, and its key by what it presses (`r`, `c` or `b`), as This run's first entry
 * has them. The palette's own script builds it, so the first look holds none of a step's words.
 */

/** How long a step picked on a row waits for its run's page to draw the button it presses. */
export const PRESS_WAIT_MS = 10_000;

/** How often it looks again while the page draws. */
const LOOK_MS = 100;

/**
 * Opens the run and presses its lime button once the page draws it, as This run's entry presses it,
 * so the step asks and waits as its button does, and one that is off says why. It presses nothing
 * where the page leads with another step by then, and gives up on another page or after the wait. The
 * page is drawn once its heading names the run (`data-run`).
 */
export function openAndPress(runId: string, key: string, toast: (text: string) => void): void {
  navigate(href.run(runId));
  const until = Date.now() + PRESS_WAIT_MS;
  const look = (): void => {
    const route = currentRoute();
    if (route.page !== 'run' || route.id !== runId) return;
    const drawn = document.querySelector('.rhead h1.rnm')?.getAttribute('data-run') === runId;
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

/**
 * The palette's builder for a run row's next step: a link goes where it goes, any other step opens
 * the run and presses that button there. None while it can't start (`off`), nor a job while actions
 * are paused, as This run leaves it out then.
 */
export function rowStep(actionsOff: string | null, toast: (text: string) => void): RowStep {
  return (runId, next) => {
    if (next.off || (!next.href && actionsOff)) return null;
    const { group, ...entry } = stepEntry(next);
    return { ...entry, run: () => (next.href ? navigate(next.href) : openAndPress(runId, next.key, toast)) };
  };
}
