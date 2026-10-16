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
