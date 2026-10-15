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
  const { setSideOpen, exported, meta } = useApp();

  // The phone sidebar closes on navigation.
  useEffect(() => setSideOpen(false), [route, setSideOpen]);

  // An exported copy holds runs and Compare between them: it opens on its first run.
  useEffect(() => {
    if (!exported || !meta) return;
    const first = meta.runIds?.[0];
    if (route.page === 'overview' && first) navigate(href.run(first), true);
    else if (route.page !== 'run' && route.page !== 'runs' && route.page !== 'compare' && route.page !== 'overview') navigate(href.runs(), true);
  }, [exported, meta, route]);

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
