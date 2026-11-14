import { useEffect, useState } from 'react';
import { useLatest } from '../../hooks.js';
import { useApp } from '../../state.js';
import type { CiWorkflowOptions, CiWorkflowsView } from '../../types.js';
import { onSettingsChanged } from './events.js';

/**
 * The CI tab's panels for what was changed, which Gates reads too (its suite risk, the goldens on
 * each kind's defaults, and what an inconclusive golden does in CI): the server's answer, kept while
 * the next one is asked so nothing empties as you type, with the options it answered for
 * (`servedFor`). Asked again when the window comes back (the file or Push from CI may have changed
 * meanwhile), when Settings changed from elsewhere, in another project, and on Retry (`reload`).
 */
export function useCiWorkflows(o: Partial<CiWorkflowOptions>): { view: CiWorkflowsView | null; error: Error | null; reload: () => void; servedFor: string | null } {
  const { client, meta } = useApp();
  const options = useLatest(o);
  const [seen, setSeen] = useState(0);
  const key = `${JSON.stringify(o)}:${meta?.project?.id ?? ''}:${seen}`;
  const [served, setServed] = useState<{ view: CiWorkflowsView | null; error: Error | null; servedFor: string | null }>({ view: null, error: null, servedFor: null });
  useEffect(() => {
    const again = () => document.visibilityState === 'visible' && setSeen((n) => n + 1);
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    const off = onSettingsChanged(() => setSeen((n) => n + 1));
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
      off();
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const asked = options.current;
    client.ciWorkflows(asked).then(
      (view) => alive && setServed({ view, error: null, servedFor: JSON.stringify(asked) }),
      (err: unknown) => alive && setServed((s) => ({ ...s, error: err instanceof Error ? err : new Error(String(err)) })),
    );
    return () => {
      alive = false;
    };
  }, [client, key, options]);
  return { ...served, reload: () => setSeen((n) => n + 1) };
}
