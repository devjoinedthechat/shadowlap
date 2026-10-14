import { useEffect, useState } from 'react';

export type Route = { page: 'home' } | { page: 'run'; runId: string; callNo: number | null } | { page: 'compare'; a: string; b: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'run' && parts[1]) {
    const n = parts[2] === 'call' ? Number(parts[3]) : NaN;
    return { page: 'run', runId: parts[1], callNo: Number.isInteger(n) ? n : null };
  }
  if (parts[0] === 'compare' && parts[1] && parts[2]) return { page: 'compare', a: parts[1], b: parts[2] };
  return { page: 'home' };
}

export const href = {
  home: () => '#/',
  run: (runId: string, callNo?: number | null) => `#/run/${runId}${callNo ? `/call/${callNo}` : ''}`,
  compare: (a: string, b: string) => `#/compare/${a}/${b}`,
};

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, '', to);
  else location.hash = to;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
