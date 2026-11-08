import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { useLatest } from '../hooks.js';

/**
 * Folds an element until found: `hidden="until-found"` while `shut`, so find in page opens it, its
 * `beforematch` calling `found`. Set from an effect, before the page paints, because React types
 * `hidden` as a boolean and would write `hidden=""`: the element takes no `hidden` prop, so React
 * never rewrites it. A browser without until-found treats it as plain hidden; its toggle still opens it.
 */
export function useUntilFound(ref: RefObject<HTMLElement | null>, shut: boolean, found: () => void): void {
  const latest = useLatest(found);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (shut) el.setAttribute('hidden', 'until-found');
    else el.removeAttribute('hidden');
  }, [ref, shut]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => latest.current();
    el.addEventListener('beforematch', on);
    return () => el.removeEventListener('beforematch', on);
  }, [ref, latest]);
}

/** An id made from a golden's name, for what a report's toggles control: `grp-refund-flow`. */
export const partId = (prefix: string, name: string): string => `${prefix}-${name.replace(/[^\w-]/g, '-')}`;
