import { useEffect, useLayoutEffect } from 'react';
import type { RunsFilterRead } from '../../src/links.js';
import { navigate } from '../router.js';
import { keepRunsView } from '../runs-view.js';
import { ALL_RUNS, runsHref, runsLinkQuery } from './query.js';
import { forgetScroll, keepScroll } from './scroll.js';

/**
 * Runs' steps in the history. The words typed take the place of the step they were typed in as they
 * settle; committing a view (a chip, a sort, days, Enter in the filter) is a step of its own, and
 * first puts the step it leaves back to the view that step landed on, so Back undoes the words typed
 * and the commit together. `landed` is that view: where the last commit, or the last move of the
 * address (Back, Forward, a link), landed; null while Runs isn't showing.
 */
let landed: string | null = null;

/** The address now; none in the tests' page. */
const hashNow = (): string | null => (typeof location === 'undefined' ? null : location.hash);

/** A view of Runs as the page writes it, or null for another page's address. */
const runsView = (hash: string | null): string | null => (hash && /^#\/runs\/?(\?|$)/.test(hash) ? runsHref(runsLinkQuery(hash) ?? ALL_RUNS) : null);

/** Shows `next`, a step of its own in the history. */
export function commitRuns(next: RunsFilterRead): void {
  const to = runsHref(next);
  const hash = hashNow();
  const at = landed ?? hash ?? to;
  landed = to;
  if (to === at) return navigate(to, true);
  keepScroll(at);
  forgetScroll(to);
  // Quietly: the page hears only the step after it.
  if (hash !== at) history.replaceState(history.state, '', `${location.pathname}${location.search}${at}`);
  navigate(to);
}

/** Shows `next` in place of the step the address is at: the words as they settle, days kept to the weeks. */
export function replaceRuns(next: RunsFilterRead): void {
  navigate(runsHref(next), true);
}

/**
 * Runs showing `f`: notes it as the view to open again (runs-view.ts), puts the address in the one
 * form the page writes, in place of its step (`#/runs?TYPES=Forks` as `#/runs?types=fork`, a value it
 * can't read left out), and notes where Runs landed as it opens and as its address moves.
 */
export function useRunsAddress(f: RunsFilterRead): void {
  useLayoutEffect(() => {
    keepRunsView(f);
    const href = runsHref(f);
    const hash = hashNow();
    if (runsView(hash) && hash !== href) navigate(href, true);
  }, [f]);
  useEffect(() => {
    const on = () => void (landed = runsView(hashNow()));
    on();
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('hashchange', on);
      landed = null;
    };
  }, []);
}
