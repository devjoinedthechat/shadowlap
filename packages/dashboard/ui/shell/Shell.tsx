import { useEffect } from 'react';
import { tabAbout } from '../about.js';
import { JobDrawer } from '../components/Drawer.js';
import { HoverCardLayer } from '../components/HoverCard.js';
import { Sprite } from '../components/Icon.js';
import { ToastHost } from '../components/Toast.js';
import { ComparePage } from '../pages/Compare.js';
import { FixesPage } from '../pages/Fixes.js';
import { NewProjectPage } from '../pages/NewProject.js';
import { NotFoundPage } from '../pages/NotFound.js';
import { OverviewPage } from '../pages/Overview.js';
import { RunPage } from '../pages/Run.js';
import { RunsPage } from '../pages/Runs.js';
import { SettingsPage } from '../pages/Settings.js';
import { SetupPage } from '../pages/Setup.js';
import { StoreSetupPage } from '../pages/settings/StoreSetup.js';
import { TestsPage } from '../pages/Tests.js';
import { TrainingPage } from '../pages/Training.js';
import { Page } from '../components/Page.js';
import { useFixTitle } from '../fixes/data.js';
import { setupShowsOn } from '../projects.js';
import { href, type Route } from '../route.js';
import { navigate, useRoute } from '../router.js';
import { copyCompares, exportStartRun } from '../runs.js';
import { useApp } from '../state.js';
import { docTitle, TAB_ABOUT_MAX } from '../title.js';
import { ExpiredCard, OfflineBar } from './Connection.js';
import { Keyboard } from './Keyboard.js';
import { Palette } from './Palette.js';
import { Shortcuts } from './Shortcuts.js';
import { Sidebar } from './Sidebar.js';
import { StatusBar } from './StatusBar.js';
import { TopBar } from './TopBar.js';

/** The app: top bar, sidebar, the page, the status bar, and what sits over them. */
export function Shell() {
  const route = useRoute();
  const { setSideOpen, exported, meta, runs, closeJobs } = useApp();
  useDocTitle(route);

  // The phone sidebar closes on navigation; a job's drawer closes when the page changes (not when a
  // call or a view is picked), and a toast says when the job finishes.
  useEffect(() => setSideOpen(false), [route, setSideOpen]);
  const pageKey = route.page === 'run' ? `run:${route.id}` : route.page;
  useEffect(() => closeJobs(), [pageKey, closeJobs]);

  // An exported copy holds runs and Compare between them (when it holds two or more): it opens on the
  // run that was shared, the one the runs it came from lead to, whichever order the copy lists them in.
  useEffect(() => {
    if (!exported || !meta || !runs) return;
    const start = exportStartRun(meta.runIds ?? [], runs);
    const compares = route.page === 'compare' && copyCompares(meta.runIds);
    if (route.page === 'overview' && start) navigate(href.run(start), true);
    else if (route.page !== 'run' && route.page !== 'runs' && !compares && route.page !== 'overview') navigate(href.runs(), true);
  }, [exported, meta, runs, route]);

  return (
    <>
      <Sprite />
      <div className="app" id="app">
        <TopBar route={route} />
        <Sidebar route={route} />
        <main className="view" id="view" tabIndex={-1}>
          <SetupOr route={route} />
        </main>
        <StatusBar />
      </div>
      <OfflineBar />
      <ExpiredCard />
      <Palette route={route} />
      <Shortcuts onRun={route.page === 'run'} />
      <JobDrawer />
      <ToastHost />
      <HoverCardLayer />
      <Keyboard />
    </>
  );
}

/**
 * The tab's title, from the route and what the page knows of it (title.ts): the setup when it shows
 * in place of the page, a fix by its title once the fixes read model has it, a run by its id.
 */
function useDocTitle(route: Route): void {
  const { exported, meta, runs } = useApp();
  const fixTitle = useFixTitle(route.page === 'fixes' ? route.id : null);
  const setup = setupShowsOn(route, { exported, meta, runs });
  const row = route.page === 'run' ? runs?.find((r) => r.runId === route.id || (route.id.length >= 10 && r.runId.startsWith(route.id))) : undefined;
  // The about line (decision 10), once the run list carries one, as a tab can hold it: the longest
  // of its forms that keeps to the count, keeping the line's end, as the design's docTitle does.
  const about = tabAbout(row?.about, TAB_ABOUT_MAX);
  const problem = meta?.project?.problem ? { name: meta.project.name } : null;
  const title = docTitle(route, { setup, problem, fixTitle, about });
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/**
 * The project's setup in place of the page: on every page but Settings while the project has no
 * runs, and on the Overview while its setup isn't finished (`setupShowsOn`). Until that can be
 * told, the page waits rather than flashing.
 */
function SetupOr({ route }: { route: Route }) {
  const { exported, meta, runs } = useApp();
  const setup = setupShowsOn(route, { exported, meta, runs });
  if (setup === null) return <Page>{null}</Page>;
  return setup ? <SetupPage asked={route.page === 'setup'} /> : <PageFor route={route} />;
}

function PageFor({ route }: { route: Route }) {
  switch (route.page) {
    case 'overview':
      return <OverviewPage />;
    case 'runs':
      return <RunsPage />;
    case 'run':
      // Not keyed on the id: a short id settling on the full one is the run already loaded, which
      // RunPage keeps; another run starts the page empty there.
      return <RunPage id={route.id} call={route.call} view={route.view} />;
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
