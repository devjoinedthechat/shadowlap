import { useEffect, useSyncExternalStore, type ComponentType } from 'react';
import { onShow } from '../components/OnShow.js';
import { tabAbout } from '../about.js';
import { JobDrawer } from '../components/Drawer.js';
import { HoverCardLayer } from '../components/HoverCard.js';
import { Sprite } from '../components/Icon.js';
import { ToastHost } from '../components/Toast.js';
import { useFixTitle } from '../fixes/data.js';
import { TestsAskHost } from '../fixes/TestsJobButton.js';
import { OverlaySlots } from '../overlays/slots.js';
import { setupShowsOn } from '../projects.js';
import type { Route } from '../route.js';
import { useRoute } from '../router.js';
import { useApp } from '../state.js';
import { docTitle, onOpenRunAbout, openRunAbout, TAB_ABOUT_MAX } from '../title.js';
import { ExpiredCard, OfflineBar } from './Connection.js';
import { Keyboard } from './Keyboard.js';
import { Sidebar } from './Sidebar.js';
import { SkipLink } from './SkipLink.js';
import { StatusBar } from './StatusBar.js';
import { TopBar } from './TopBar.js';

/** The palette and the shortcuts sheet wait in scripts of their own, which load as the shell first draws, so they answer at once and with the server gone. */
const Palette = onShow(() => import('./Palette.js').then((m) => m.Palette));
const Shortcuts = onShow(() => import('./Shortcuts.js').then((m) => m.Shortcuts));

/**
 * What the shell draws where the page goes, for the route the address bar holds: the dashboard's
 * pages, each loaded when it first opens (`DashboardPages`, pages/lazy.tsx), or an exported copy's
 * runs, run pages and Compare (`CopyPages`, pages/copy.tsx). The shell imports neither, so the
 * script each is built into (ui-bundles.mjs) holds only its own.
 */
export type Pages = ComponentType<{ route: Route }>;

/** The app: top bar, sidebar, the page, the status bar, and what sits over them. */
export function Shell({ pages: PageSlot }: { pages: Pages }) {
  const route = useRoute();
  const { setSideOpen, closeJobs, conn } = useApp();
  useDocTitle(route);

  // The phone sidebar closes on navigation; a job's drawer closes when the page changes (not when a
  // call or a view is picked), and a toast says when the job finishes.
  useEffect(() => setSideOpen(false), [route, setSideOpen]);
  const pageKey = route.page === 'run' ? `run:${route.id}` : route.page;
  useEffect(() => closeJobs(), [pageKey, closeJobs]);

  return (
    <>
      <Sprite />
      {/* The first stop for Tab: past the top bar and the sidebar to the page. Not while the link has
          expired, when the card over the page is all there is to reach. */}
      {conn === 'expired' ? null : <SkipLink />}
      <div className="app" id="app">
        <TopBar route={route} />
        <Sidebar route={route} />
        <main className="view" id="view" tabIndex={-1}>
          <PageSlot route={route} />
        </main>
        <StatusBar />
      </div>
      <div id="conn">
        <OfflineBar />
      </div>
      <ExpiredCard />
      {/* Beside the app, so a modal can put the app out of reach: a menu, a modal and the job's drawer, each in a place of its own. */}
      <OverlaySlots />
      <Palette route={route} />
      <Shortcuts onRun={route.page === 'run'} />
      <JobDrawer />
      {/* A Tests job that would run goldens live asks here, whichever page or the palette started it. */}
      <TestsAskHost />
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
  // The run page's own read of the run, which an attempt, left out of the run list, has too.
  const open = useSyncExternalStore(onOpenRunAbout, openRunAbout);
  const shown = route.page === 'run' && open && (open.runId === route.id || (route.id.length >= 10 && open.runId.startsWith(route.id))) ? open.about : null;
  // The about line (decision 10) as a tab can hold it: the longest of its forms that keeps to the
  // count, keeping the line's end, as the design's docTitle does.
  const about = tabAbout(shown ?? row?.about, TAB_ABOUT_MAX);
  const problem = meta?.project?.problem ? { name: meta.project.name } : null;
  const title = docTitle(route, { setup, problem, fixTitle, about });
  useEffect(() => {
    document.title = title;
  }, [title]);
}
