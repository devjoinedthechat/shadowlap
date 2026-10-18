/**
 * Which element of an overlay takes the focus when it opens. No DOM here: the tests import it, and
 * `components/Dialog.tsx` queries for it.
 */

/**
 * What a dialog focuses when it opens: its first field, else its action, but Cancel when the action
 * is red (`danger`), so pressing Enter again doesn't do what can't be undone. `initialFocus: 'cancel'`
 * starts on Cancel whatever the dialog holds.
 */
export function dialogFocus(tone: 'lime' | 'danger' | 'solid' | undefined, initialFocus?: 'cancel'): string {
  if (initialFocus === 'cancel') return '.dlg-cancel';
  return `textarea, input:not([type="checkbox"]):not([type="hidden"]), select, ${tone === 'danger' ? '.dlg-cancel' : '.dlg-ok'}`;
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
