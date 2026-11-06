import { sameRun } from './format.js';
import { parseRoute, type Route } from './route.js';

/**
 * Which element of an overlay takes the focus when it opens, where Tab goes inside one, and what a
 * move between pages does to the focus and the way back. No DOM here: the tests import it, and
 * `overlays/focus-back.ts`, `components/Dialog.tsx` and `focus-manager.ts` use it.
 */

/** The fields a dialog's focus can start on: a tick, a radio or a file's input never does. */
const DIALOG_FIELD = 'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]), select';

/**
 * What a dialog focuses when it opens, the first of these that shows and is enabled: Cancel in one
 * that deletes or removes (`danger`), so pressing Enter again doesn't do what can't be undone, or when
 * `initialFocus: 'cancel'` asks for it (a command someone else recorded); else its first field, then
 * its way on, the second way on before the first, else Cancel while the way on waits (Run repair,
 * reading its repairer). On a touch screen (`touch`) it skips the fields, whose keyboard would open
 * over the dialog.
 */
export function dialogFocus(tone: 'lime' | 'danger' | 'plain' | undefined, initialFocus?: 'cancel', touch = false): readonly string[] {
  if (initialFocus === 'cancel' || tone === 'danger') return ['.dlg-cancel'];
  return touch ? ['.dlg-alt', '.dlg-ok', '.dlg-cancel'] : [DIALOG_FIELD, '.dlg-alt', '.dlg-ok', '.dlg-cancel'];
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

/**
 * What counts as one page to the focus: a step within it (a run's call or view, a fix's step, a
 * filter on Runs, a pick in Compare) leaves the focus where it was, and a new page gives it to the
 * page's heading. A Settings or Training tab is a page of its own, and so is each tab of Changes and
 * a revision's page there (`#/changes` and `#/changes/verdicts` are one).
 */
export function pageSig(r: Route): string {
  if (r.page === 'run') return `run:${r.id}`;
  if (r.page === 'fixes') return r.id ? `fixes:${r.id}` : 'fixes';
  if (r.page === 'settings' || r.page === 'training') return `${r.page}:${r.tab ?? ''}`;
  if (r.page === 'changes') return `changes:${r.tab}:${r.id ?? ''}`;
  return r.page;
}

/** Whether two pages are one: a run's short id, as a link may hold it, is the run. */
export function samePage(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (!a?.startsWith('run:') || !b?.startsWith('run:')) return false;
  const [x, y] = [a.slice(4), b.slice(4)];
  return sameRun(x, y) || sameRun(y, x);
}

/** A page Esc leaves the way you came: a run, a fix, or a revision's page under Changes. Any other page empties the way back. */
export const isDetail = (r: Route): boolean => r.page === 'run' || ((r.page === 'fixes' || (r.page === 'changes' && r.tab === 'verdicts')) && r.id !== null);

/** A link no list's row holds: where it leads, and which of the page's links there it was. */
export interface LinkNote {
  href: string;
  i: number;
}

/** A page on the way back: its address, the row you left there, or else the link. */
export interface TrailStop {
  sig: string;
  hash: string;
  row: string | null;
  link: LinkNote | null;
}

/**
 * The way back after a move to `to`. A page that isn't a detail page empties it; a step by Esc (`up`)
 * or along a list (`side`) adds nothing; a page already on it cuts it back to there, so it never
 * loops; opening a run above this one in its family (`above`) adds nothing; else it gains the page left.
 */
export function trailAfter(trail: readonly TrailStop[], o: { to: Route; how: 'up' | 'side' | null; above: boolean; from: TrailStop }): readonly TrailStop[] {
  if (!isDetail(o.to)) return [];
  if (o.how) return trail;
  const sig = pageSig(o.to);
  const at = trail.findIndex((x) => samePage(x.sig, sig));
  if (at >= 0) return trail.slice(0, at);
  return o.above ? trail : [...trail, o.from];
}

/** Whether a row's key, where it leads, is the page left. */
function leadsTo(key: string, left: string): boolean {
  return samePage(pageSig(parseRoute(key)), left);
}

/** The row Esc lands on: the one you opened it from if it still leads there, else the first that does, else the one you opened it from. */
export function backRowKey(keys: readonly string[], left: string, own: string | null): string | null {
  const has = own !== null && keys.includes(own);
  if (has && leadsTo(own, left)) return own;
  return keys.find((k) => leadsTo(k, left)) ?? (has ? own : null);
}
