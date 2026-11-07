/**
 * From 1001px to 1159px, where the inspector sits under the calls, the calls list keeps to the height
 * that leaves the inspector's head (its call and its tabs) in the window as the page opens, so it
 * shows the inspector is there: never less than 240px, nor more than half the window. The header's
 * height decides it, so it runs once the header is fitted: as the page draws, on a resize, once the
 * web fonts load. At every other width the stylesheet's height holds.
 *
 * The header is fitted after every draw, and a long run's page draws again with each page of calls
 * that comes, so the height is set only when it differs from the list's own. The selected call is
 * brought back only when it was in sight and the shorter list left it out: a list the reader
 * scrolled away from it stays where they took it, as the paging line goes and the list grows too.
 */

/** The list's sticky head, which covers its top rows. */
const HEAD = 34;

export function fitWork(rv: HTMLElement | null): void {
  // Nothing to fit where nothing is laid out (a test's document).
  if (typeof innerWidth !== 'number' || !rv) return;
  const list = rv.querySelector<HTMLElement>('#vbody');
  if (!list) return;
  let want = '';
  if (innerWidth >= 1001 && innerWidth <= 1159) {
    const top = list.getBoundingClientRect().top - rv.getBoundingClientRect().top + rv.scrollTop;
    want = `${Math.round(Math.max(240, Math.min(rv.clientHeight - 120 - top, innerHeight / 2)))}px`;
  }
  if (list.style.maxHeight === want) return;
  const sel = list.querySelector<HTMLElement>('tr[aria-selected="true"]');
  const was = !!sel && inSight(list, sel);
  list.style.maxHeight = want;
  if (!sel || !was || inSight(list, sel)) return;
  list.scrollTop = Math.max(0, rowTop(list, sel) - (list.clientHeight - sel.offsetHeight) / 2);
}

/** A row's top in its list's own coordinates. */
const rowTop = (list: HTMLElement, row: HTMLElement) => row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;

/** Whether a row shows whole in its list, under the list's sticky head. */
function inSight(list: HTMLElement, row: HTMLElement): boolean {
  const at = rowTop(list, row);
  return at - HEAD >= list.scrollTop && at + row.offsetHeight <= list.scrollTop + list.clientHeight;
}
