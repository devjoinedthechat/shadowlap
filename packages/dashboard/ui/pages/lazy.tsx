import type { ComponentType } from 'react';
import { LoadFailed, PageHeader } from '../components/bits.js';
import { onShow, type OnShow } from '../components/OnShow.js';
import { Page } from '../components/Page.js';
import { heldAsk } from '../held.js';
import { setupShowsOn } from '../projects.js';
import type { Route } from '../route.js';
import { useRoute } from '../router.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';
import { pageTitle } from '../title.js';
import { NotFoundPage } from './NotFound.js';
import { Elsewhere } from './held-elsewhere.js';

/**
 * The pages the dashboard's shell routes to, each in a script of its own that loads the first time
 * the page opens (`onShow`): esbuild splits the bundle at each `import()` (ui-bundles.mjs), so the
 * app's first script holds the shell and what the pages share, and a page's own code comes when it
 * is asked for. While it loads the page waits empty, as it does before the project is known; a page
 * whose code didn't come says so under its title, with Retry (`PageFailed`). An exported copy is
 * built from an entry of its own (main-copy.tsx) with the pages it shows (pages/copy.tsx), so
 * nothing here is in it.
 */

function onOpen<P extends object>(load: () => Promise<ComponentType<P>>): OnShow<P> {
  return onShow(load, { waiting: <Page>{null}</Page>, failed: <PageFailed /> });
}

/**
 * A page whose code didn't come: its title, as the browser's tab names it, over one line that says
 * so, with Retry (`LoadFailed`), which loads the page again. A run's page is titled by the run's
 * id, in the code face; Changes' tabs (`Verdicts · Changes`) say diffs over it, as their head does.
 */
function PageFailed() {
  const route = useRoute();
  const { exported, meta, runs } = useApp();
  const setup = setupShowsOn(route, { exported, meta, runs });
  const run = route.page === 'run' && !setup;
  // What the page is, as its own eyebrow names it: a run, Changes' diffs.
  const kind = run ? 'run' : !setup && (route.page === 'changes' || route.page === 'compare') ? 'diffs' : null;
  const eyebrow = [projectOf(meta)?.name, kind].filter(Boolean).join(' · ');
  const problem = meta?.project?.problem ? { name: meta.project.name } : null;
  return (
    <Page>
      <PageHeader eyebrow={eyebrow || undefined} title={pageTitle(route, { setup, problem })} className={run ? 'rerr' : undefined} />
      <LoadFailed what="page" />
    </Page>
  );
}

export const OverviewPage = onOpen(() => import('./Overview.js').then((m) => m.OverviewPage));
export const RunsPage = onOpen(() => import('./Runs.js').then((m) => m.RunsPage));
export const RunPage = onOpen(() => import('./Run.js').then((m) => m.RunPage));
export const ChangesPage = onOpen(() => import('./Changes.js').then((m) => m.ChangesPage));
export const ComparePage = onOpen(() => import('./Compare.js').then((m) => m.ComparePage));
export const FixesPage = onOpen(() => import('./Fixes.js').then((m) => m.FixesPage));
export const TestsPage = onOpen(() => import('./Tests.js').then((m) => m.TestsPage));
export const TrainingPage = onOpen(() => import('./Training.js').then((m) => m.TrainingPage));
export const SettingsPage = onOpen(() => import('./Settings.js').then((m) => m.SettingsPage));
export const NewProjectPage = onOpen(() => import('./NewProject.js').then((m) => m.NewProjectPage));
export const SetupPage = onOpen<{ asked?: boolean }>(() => import('./Setup.js').then((m) => m.SetupPage));
export const StoreSetupPage = onOpen(() => import('./settings/StoreSetup.js').then((m) => m.StoreSetupPage));

/**
 * The dashboard's page for a route, or the project's setup in its place: on every page but Settings
 * while the project has no runs, and on the Overview while its setup isn't finished
 * (`setupShowsOn`). Until that can be told, the page waits rather than flashing. A link to a run, a
 * fix or a pair asks first whether another project holds it (pages/held-elsewhere.tsx), the one part
 * this list shows itself.
 */
export function DashboardPages({ route }: { route: Route }) {
  const { exported, meta, runs } = useApp();
  const setup = setupShowsOn(route, { exported, meta, runs });
  if (setup === null) return <Page>{null}</Page>;
  if (!setup) return <PageFor route={route} />;
  const page = <SetupPage asked={route.page === 'setup'} />;
  const ask = heldAsk(route);
  return ask ? <Elsewhere ask={ask} waiting={<Page>{null}</Page>} fallback={page} /> : page;
}

function PageFor({ route }: { route: Route }) {
  switch (route.page) {
    case 'overview':
      return <OverviewPage />;
    case 'runs':
      return <RunsPage filter={route.filter} />;
    case 'run':
      // Not keyed on the id: a short id settling on the full one is the run already loaded, which
      // RunPage keeps; another run starts the page empty there.
      return <RunPage id={route.id} call={route.call} view={route.view} />;
    case 'changes':
      return <ChangesPage tab={route.tab} id={route.id} />;
    case 'compare':
      return <ComparePage a={route.a} b={route.b} />;
    case 'fixes':
      return <FixesPage id={route.id} step={route.step} sub={route.sub} />;
    case 'tests':
      return <TestsPage />;
    case 'training':
      return <TrainingPage tab={route.tab} />;
    case 'settings':
      return <SettingsPage tab={route.tab} />;
    case 'new':
      return <NewProjectPage />;
    case 'setup':
      return <SetupPage asked />;
    case 'store-setup':
      return <StoreSetupPage />;
    default:
      return <NotFoundPage />;
  }
}
