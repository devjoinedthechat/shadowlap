import { useEffect } from 'react';
import { Page } from '../components/Page.js';
import { href, type Route } from '../route.js';
import { navigate } from '../router.js';
import { copyCompares, exportStartRun } from '../runs.js';
import { useApp } from '../state.js';
import { ComparePage } from './Compare.js';
import { RunPage } from './Run.js';
import { RunsPage } from './Runs.js';

/**
 * The pages an exported copy holds (main-copy.tsx), and no other: its runs, a run's page, and
 * Compare between them when it holds two or more. It opens on the run that was shared, the one the
 * runs it came from lead to, whichever order the copy lists them in, and any other page opens its
 * runs; until then the page waits empty. They are the dashboard's own pages, imported here rather
 * than loaded when they open (pages/lazy.tsx), since a file has no server to load a page's script
 * from: the copy is one script, with these pages and the parts they show in it.
 */
export function CopyPages({ route }: { route: Route }) {
  const { meta, runs } = useApp();
  const compares = route.page === 'compare' && copyCompares(meta?.runIds);
  useEffect(() => {
    if (!meta || !runs) return;
    const start = exportStartRun(meta.runIds ?? [], runs);
    if (route.page === 'overview' && start) navigate(href.run(start), true);
    else if (route.page !== 'run' && route.page !== 'runs' && !compares && route.page !== 'overview') navigate(href.runs(), true);
  }, [meta, runs, route, compares]);
  switch (route.page) {
    case 'runs':
      return <RunsPage filter={route.filter} />;
    case 'run':
      // Not keyed on the id, as the dashboard draws it: a short id settling on the full one is the run already loaded.
      return <RunPage id={route.id} call={route.call} view={route.view} />;
    case 'compare':
      return compares ? <ComparePage a={route.a} b={route.b} /> : <Page>{null}</Page>;
    default:
      return <Page>{null}</Page>;
  }
}
