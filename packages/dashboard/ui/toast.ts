import { messageOf } from '../../engine/src/message-of.js';
/**
 * Toasts, one at a time, centred on the content. A notice has the dim dot and goes after 5 seconds,
 * as the design's do, and is said in one polite region. An error (a job the server refused, a change
 * that failed, a job that failed behind a hidden drawer) has a red dot, is read out at once
 * (`role=alert`) and stays for 8 seconds: the reason it gives is what the person has to act on, and a
 * notice that looks like a success is easy to miss. Each is said in a live region that stays on the
 * page, so a screen reader hears it change. No DOM here: the tests import it, and
 * `components/Toast.tsx` shows it.
 */

export type ToastKind = 'notice' | 'error';

/** How long a toast stays, by kind. */
export const TOAST_MS: Readonly<Record<ToastKind, number>> = { notice: 5000, error: 8000 };

/**
 * A toast can carry one thing to do about it: Undo after a change made in one click, a job's way on,
 * or a way out of what holds a control. A button in the toast, which then stays this long, held while
 * the pointer or the focus is on it. Done, or once the toast goes while the focus is in it, the focus
 * goes back to `returnTo`, the control the change was made with, rather than to the page's body.
 */
export interface ToastAction {
  label: string;
  run: () => void;
  returnTo?: HTMLElement | null;
  /** It undoes what the toast says was done: only this answers ⌘Z and the undo key, never a way on. */
  undo?: boolean;
  /** It takes the focus as it comes (a press from the keyboard on what waits), and its time starts once the focus leaves it. */
  focus?: boolean;
  /** Called once, when the toast goes, however it goes, a newer one replacing it included. `acted`: its button or × was pressed, or its key. */
  onGone?: (acted: boolean) => void;
}
export const ACTION_TOAST_MS = 8000;

/** The key that does what an Undo on the screen offers, from anywhere but a field being typed in, while single keys are on. */
export const UNDO_KEY = 'u';

/** What the Undo button names as its keys. */
export const UNDO_SHORTCUTS = `Meta+Z Control+Z ${UNDO_KEY}`;

/** What the undo key does now (components/Toast.tsx sets it while a toast with an Undo shows): true when it did something. */
export const toastKey: { current: (() => boolean) | null } = { current: null };

/** What the live region says of a toast's button. */
export function actionSaid(action: Pick<ToastAction, 'label' | 'undo'>, mac: boolean): string {
  return action.undo ? `. Undo with ${mac ? 'Command' : 'Control'} Z` : ` · ${action.label} in the notice`;
}

let announcer: ((text: string) => void) | null = null;

/** Set by components/Toast.tsx, which holds the region. */
export function setAnnouncer(fn: ((text: string) => void) | null): void {
  announcer = fn;
}

/** Says `text` in the one polite live region, which is there from the start: what a toast says, how many results the palette has. */
export function announce(text: string): void {
  announcer?.(text);
}

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
  return sentence(messageOf(err));
}
