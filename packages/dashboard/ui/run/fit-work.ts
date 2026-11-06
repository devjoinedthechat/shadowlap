/**
 * From 1001px to 1159px, where the inspector sits under the calls, the calls list keeps to the height
 * that leaves the inspector's head (its call and its tabs) in the window as the page opens, so it
 * shows the inspector is there: never less than 240px, nor more than half the window. The header's
 * height decides it, so it runs once the header is fitted: as the page draws, on a resize, once the
 * web fonts load. At every other width the stylesheet's height holds.
 *
 * The header is fitted after every draw, and a long run's page draws again with each page of calls
 * that comes, so the height is set only when it differs from the list's own. Only then is the
 * selected call brought back, when the shorter list left it out of sight: a page arriving while the
 * reader scrolls the list leaves it where they took it.
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
  list.style.maxHeight = want;
  const sel = want ? list.querySelector<HTMLElement>('tr[aria-selected="true"]') : null;
  if (!sel) return;
  const at = sel.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
  if (at - HEAD < list.scrollTop || at + sel.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, at - (list.clientHeight - sel.offsetHeight) / 2);
}
