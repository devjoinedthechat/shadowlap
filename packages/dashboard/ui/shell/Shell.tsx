import { useEffect } from 'react';
import { JobDrawer } from '../components/Drawer.js';
import { HoverCardLayer } from '../components/HoverCard.js';
import { Sprite } from '../components/Icon.js';
import { ToastHost } from '../components/Toast.js';
import { ComparePage } from '../pages/Compare.js';
import { FixesPage } from '../pages/Fixes.js';
import { NewProjectPage } from '../pages/NewProject.js';
import { NotFoundPage } from '../pages/NotFound.js';
import { OverviewPage } from '../pages/Overview.js';
import { ReleasesPage } from '../pages/Releases.js';
import { RunPage } from '../pages/Run.js';
import { RunsPage } from '../pages/Runs.js';
import { SettingsPage } from '../pages/Settings.js';
import { SetupPage } from '../pages/Setup.js';
import { TestsPage } from '../pages/Tests.js';
import { TrainingPage } from '../pages/Training.js';
import { href, type Route } from '../route.js';
import { navigate, useRoute } from '../router.js';
import { exportStartRun } from '../runs.js';
import { useApp } from '../state.js';
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

  // The phone sidebar closes on navigation; a job's drawer closes when the page changes (not when a
  // call or a view is picked), and a toast says when the job finishes.
  useEffect(() => setSideOpen(false), [route, setSideOpen]);
  const pageKey = route.page === 'run' ? `run:${route.id}` : route.page;
  useEffect(() => closeJobs(), [pageKey, closeJobs]);

  // An exported copy holds runs and Compare between them: it opens on the run that was shared, the
  // one the runs it came from lead to, whichever order the copy lists them in.
  useEffect(() => {
    if (!exported || !meta || !runs) return;
    const start = exportStartRun(meta.runIds ?? [], runs);
    if (route.page === 'overview' && start) navigate(href.run(start), true);
    else if (route.page !== 'run' && route.page !== 'runs' && route.page !== 'compare' && route.page !== 'overview') navigate(href.runs(), true);
  }, [exported, meta, runs, route]);

  return (
    <>
      <Sprite />
      <div className="app" id="app">
        <TopBar route={route} />
        <Sidebar route={route} />
        <main className="view" id="view" tabIndex={-1}>
          <PageFor route={route} />
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

function PageFor({ route }: { route: Route }) {
  switch (route.page) {
    case 'overview':
      return <OverviewPage />;
    case 'runs':
      return <RunsPage />;
    case 'run':
      return <RunPage key={route.id} id={route.id} call={route.call} view={route.view} />;
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
      return <SetupPage />;
    case 'releases':
      return <ReleasesPage id={route.id} />;
    default:
      return <NotFoundPage />;
  }
}
