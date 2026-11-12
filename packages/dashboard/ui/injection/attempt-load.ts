import { useEffect, useState } from 'react';
import { useServedParts } from '../served-parts.js';
import type { RunInjection } from '../types.js';
import type { AttemptPage } from './AttemptPage.js';

/*
 * What only an injection attempt's page does (AttemptPage.tsx), loaded once for the page however
 * many places ask: kept once it comes, and a failure kept too, so an attempt's page then draws
 * unmarked for as long as the page is open, as a part whose script failed stays out.
 */

let page: AttemptPage | null = null;
let coming: Promise<AttemptPage | null> | null = null;

/** Loads it with `load` (the served dashboard's, pages/served.tsx) unless it is in or on its way. */
export function loadAttemptPage(load: () => Promise<AttemptPage>): Promise<AttemptPage | null> {
  if (!coming)
    coming = load().then(
      (m) => (page = m),
      () => null,
    );
  return coming;
}

/** What an attempt's page marks and opens on, once its script is in: null on any other run, in a copy (nothing hands it in), and while it comes. */
export function useAttemptPage(attempt: RunInjection['attempt'] | undefined): AttemptPage | null {
  const load = useServedParts().attemptPage;
  const [shown, setShown] = useState(() => page);
  const wanted = !!attempt;
  useEffect(() => {
    if (!wanted || shown || !load) return;
    let live = true;
    void loadAttemptPage(load).then((m) => {
      if (live && m) setShown(m);
    });
    return () => {
      live = false;
    };
  }, [wanted, shown, load]);
  return wanted ? shown : null;
}
