import { useEffect } from 'react';
import { href } from '../route.js';
import { navigate } from '../router.js';

/**
 * Which golden's reports are open on Tests, by name, kept while the dashboard is open rather than
 * with the page: Esc's way back from a link inside a report (an attempt's run, a proof's call, Open
 * failing attempt) lands on that link, so the report it sits in is open when Tests draws again.
 */
const open = new Set<string>();

export const reportOpen = (name: string): boolean => open.has(name);

/** The names of the reports open now. */
export const openReports = (): string[] => [...open];

export function setReportOpen(name: string, on: boolean): void {
  if (on) open.add(name);
  else open.delete(name);
}

/**
 * Which reports show a gate's attempts past 24, which fold behind its caret: kept as the reports'
 * open set is, so Esc's way back from an attempt opened from that list finds its link.
 */
const attempts = new Set<string>();

export const attemptsShown = (name: string): boolean => attempts.has(name);

/** The names of the reports whose attempts are shown now. */
export const shownAttempts = (): string[] => [...attempts];

export function setAttemptsShown(name: string, on: boolean): void {
  if (on) attempts.add(name);
  else attempts.delete(name);
}

/** The golden a link asks Tests to open the report of (`#/tests?report=<name>`, links.ts `links.tests`), by name; null for any other address. */
export function askedReport(hash: string): string | null {
  const m = /^#\/tests\?(?:[^#]*&)?report=([^&#]*)/.exec(hash);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * The report a link asks for, on arriving at Tests or while there: it opens, `show` scrolls it into
 * view, and the address goes back to `#/tests` at once, as `?update` does, so going back never opens
 * it again.
 */
export function useAskedReport(show: (name: string) => void): void {
  useEffect(() => {
    const take = () => {
      const name = askedReport(location.hash);
      if (name === null) return;
      navigate(href.tests(), true);
      setReportOpen(name, true);
      show(name);
    };
    take();
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, [show]);
}
