import { useEffect, useState } from 'react';
import { tokenInUse } from './api.js';
import { parseRoute, routeHref, tokenLinkStep, type Route } from './route.js';

/**
 * Follows the address bar. Routes are parsed in `route.ts`; this only listens. A replace (selecting
 * a call, switching a view) rewrites the URL without a history entry and still tells the app.
 */

const REPLACED = 'shadowlap:route';

export function currentRoute(): Route {
  return parseRoute(location.hash);
}

export function navigate(to: string, replace = false): void {
  if (replace) {
    if (location.hash === to) return;
    history.replaceState(history.state, '', `${location.pathname}${location.search}${to}`);
    window.dispatchEvent(new Event(REPLACED));
  } else if (location.hash === to) {
    window.dispatchEvent(new Event(REPLACED));
  } else {
    location.hash = to;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const on = () => {
      // The link a dashboard printed, opened over this page: its view, or a fresh start with its token.
      const step = tokenLinkStep(location.hash, tokenInUse());
      if (step?.kind === 'reload') return location.reload();
      if (step?.kind === 'open') history.replaceState(history.state, '', `${location.pathname}${location.search}${step.to}`);
      const next = currentRoute();
      setRoute((prev) => (routeHref(prev) === routeHref(next) ? prev : next));
    };
    window.addEventListener('hashchange', on);
    window.addEventListener(REPLACED, on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener(REPLACED, on);
    };
  }, []);
  return route;
}

/** The `?state=offline` and `?state=expired` previews of the connection states. */
export function previewState(): 'offline' | 'expired' | null {
  const m = /[?&]state=(offline|expired)\b/.exec(location.search);
  return (m?.[1] as 'offline' | 'expired' | undefined) ?? null;
}
