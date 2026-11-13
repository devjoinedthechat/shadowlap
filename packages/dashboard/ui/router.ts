import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tokenInUse } from './api.js';
import { routeDrawn, routeHeard, startFocusManager } from './focus-manager.js';
import { closeLeftBehind } from './overlays/modal-store.js';
import { parseRoute, routeHref, tokenLinkStep, type Route } from './route.js';

/**
 * Follows the address bar. Routes are parsed in `route.ts`; this only listens. A replace (selecting
 * a call, switching a view) rewrites the URL without a history entry and still tells the app.
 */

const REPLACED = 'shadowlap:route';

/** What hears the address move before the route it brings is drawn (onAddressMove). */
const moving = new Set<(e: HashChangeEvent) => void>();

/**
 * Hears each move of the address (Back, Forward, a link, a commit) before the router draws the route
 * it brings, the page still as it was, until the call it returns: Runs keeps its place in the view
 * left. A listener of a page's own would hear it too late, as React draws a hashchange's route before
 * the event's later listeners run.
 */
export function onAddressMove(fn: (e: HashChangeEvent) => void): () => void {
  moving.add(fn);
  return () => void moving.delete(fn);
}

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
  const shown = useRef(route);
  shown.current = route;
  // The focus manager goes with the route: it starts on what this page shows, and hears each change below.
  useLayoutEffect(() => startFocusManager(), []);
  useLayoutEffect(() => routeDrawn(), [route]);
  useEffect(() => {
    const on = (e: Event) => {
      // The link a dashboard printed, opened over this page: its view, or a fresh start with its token.
      const step = tokenLinkStep(location.hash, tokenInUse());
      if (step?.kind === 'reload') return location.reload();
      if (step?.kind === 'open') history.replaceState(history.state, '', `${location.pathname}${location.search}${step.to}`);
      if (e.type === 'hashchange') for (const fn of [...moving]) fn(e as HashChangeEvent);
      const next = currentRoute();
      // A page of its own, not a call or a view picked in this one (a replace), takes what is open over this one with it.
      if (e.type === 'hashchange' && routeHref(shown.current) !== routeHref(next)) closeLeftBehind();
      routeHeard(e.type);
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
