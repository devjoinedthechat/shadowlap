/**
 * Which element of an overlay takes the focus when it opens, and where Tab goes inside one. No DOM
 * here: the tests import it, and `overlays/focus-back.ts` and `components/Dialog.tsx` query for it.
 */

/** The fields a dialog's focus can start on: a tick, a radio or a file's input never does. */
const DIALOG_FIELD = 'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]), select';

/**
 * What a dialog focuses when it opens, the first of these that shows and is enabled: Cancel in one
 * that deletes or removes (`danger`), so pressing Enter again doesn't do what can't be undone, or when
 * `initialFocus: 'cancel'` asks for it (a command someone else recorded); else its first field, then
 * its way on, the second way on before the first. On a touch screen (`touch`) it skips the fields,
 * whose keyboard would open over the dialog: its way on, else Cancel while the way on waits.
 */
export function dialogFocus(tone: 'lime' | 'danger' | 'plain' | undefined, initialFocus?: 'cancel', touch = false): readonly string[] {
  if (initialFocus === 'cancel' || tone === 'danger') return ['.dlg-cancel'];
  return touch ? ['.dlg-alt', '.dlg-ok', '.dlg-cancel'] : [DIALOG_FIELD, '.dlg-alt', '.dlg-ok'];
}

/**
 * Where Tab (or Shift+Tab, `back`) goes inside a modal dialog, given its controls that take the
 * focus in order: from the last on to the first, from the first back to the last, and from outside
 * it (the page behind, or nothing) to its first or last. Null when the browser's own step stays
 * inside. A dialog with no control keeps the focus on itself (`'self'`).
 */
export function trapTab<T>(controls: readonly T[], active: T | null, back: boolean): T | 'self' | null {
  if (!controls.length) return 'self';
  const at = active === null ? -1 : controls.indexOf(active);
  if (at < 0) return back ? controls.at(-1)! : controls[0]!;
  if (back && at === 0) return controls.at(-1)!;
  if (!back && at === controls.length - 1) return controls[0]!;
  return null;
}
