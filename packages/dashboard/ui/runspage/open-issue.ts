import type { MouseEvent } from 'react';
import { ISSUE_ASK } from '../page-ask.js';
import { navigate } from '../router.js';

/*
 * Opening an issue on Runs › Failed from a link elsewhere (Fixes, a fix's page, the palette): the
 * issue is noted, the link goes to its Failed address, and Runs opens it there, its runs shown and
 * the row in view, once its issues are in (FailedIssues.tsx). The issue opened is never in the
 * address, as Show 50 more isn't: a bookmark opens Failed with its issues closed. Small, with no page
 * in it: Fixes and the palette import it.
 */

/** Opens the issue `key` (src/issue-keys.ts) at `href`, an address under Failed: for Enter and the palette, which go there themselves. A null key, a run Failed doesn't count, opens the address alone. */
export function openIssue(href: string, key: string | null): void {
  if (key !== null) ISSUE_ASK.ask(key);
  navigate(href);
}

/** A link's click that opens the issue `key` where the link goes; a click with a modifier, or a null key, opens the address alone. */
export const issueClick =
  (key: string | null) =>
  (e: MouseEvent<HTMLAnchorElement>): void => {
    if (key === null || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    ISSUE_ASK.ask(key);
  };

/** Whether the issue `key` was asked for and not opened yet; taking it forgets it. */
export const takeIssue = (key: string): boolean => ISSUE_ASK.take(key);
