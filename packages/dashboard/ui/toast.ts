/**
 * Toasts, one at a time at the bottom of the window. A notice has the lime dot and goes after 2.6
 * seconds, as the design's do. An error (a job the server refused, a change that failed, a job that
 * failed with its drawer closed) has a red dot, is read out at once (`role=alert`) and stays until
 * it is dismissed or for 8 seconds: the reason it gives is what the person has to act on, and a
 * notice that looks like a success and goes in 2.6 seconds is easy to miss. Each is said in a live
 * region that stays on the page, so a screen reader hears it change. No DOM here: the tests import
 * it, and `components/Toast.tsx` shows it.
 */

export type ToastKind = 'notice' | 'error';

/** How long a toast stays, by kind. */
export const TOAST_MS: Readonly<Record<ToastKind, number>> = { notice: 2600, error: 8000 };

/**
 * A notice can carry one thing to do about it, as Undo after a change made in one click: a button
 * in the toast, which then stays this long, and the undo key (`UNDO_KEY`) anywhere. Done, or once the
 * toast goes while the focus is in it, the focus goes back to `returnTo`, the control the change was
 * made with, rather than to the page's body.
 */
export interface ToastAction {
  label: string;
  run: () => void;
  returnTo?: HTMLElement | null;
}
export const ACTION_TOAST_MS = 7000;

/** The key that does what the toast on screen offers (its Undo), from anywhere but a field being typed in. */
export const UNDO_KEY = 'u';

/** What the undo key does now (components/Toast.tsx sets it while a toast with an action shows): true when it did something. */
export const toastKey: { current: (() => boolean) | null } = { current: null };

/**
 * A message as a sentence, starting with a capital: the server's reasons start in lower case ("the
 * repairer in shadowlap.config.json changed since this page loaded…"). Only a plain first word is
 * raised: a first word that is a name (`fx-01K…`, `runIds:`, `baseUrl`, `shadowlap`, a file) is left
 * as it is.
 */
export function sentence(text: string): string {
  const first = /^([a-z]+)\s/.exec(text)?.[1];
  if (!first || first === 'shadowlap') return text;
  return `${first[0]!.toUpperCase()}${text.slice(1)}`;
}

/** What an error toast says for an error: its message, as a sentence. */
export function errorText(err: unknown): string {
  return sentence(err instanceof Error ? err.message : String(err));
}
