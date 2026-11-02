import type { ComponentType } from 'react';
import { onShow, type OnShow } from '../components/OnShow.js';
import { Page } from '../components/Page.js';

/**
 * The pages the shell routes to, each in a script of its own that loads the first time the page
 * opens (`onShow`): esbuild splits the bundle at each `import()` (build-ui.mjs), so the app's first
 * script holds the shell and what the pages share, and a page's own code comes when it is asked for.
 * While it loads the page waits empty, as it does before the project is known. An exported copy is
 * built as one script with every page in it, so it asks nothing of a network.
 */

function onOpen<P extends object>(load: () => Promise<ComponentType<P>>): OnShow<P> {
  return onShow(load, <Page>{null}</Page>);
}

export const OverviewPage = onOpen(() => import('./Overview.js').then((m) => m.OverviewPage));
export const RunsPage = onOpen(() => import('./Runs.js').then((m) => m.RunsPage));
export const RunPage = onOpen(() => import('./Run.js').then((m) => m.RunPage));
export const ComparePage = onOpen(() => import('./Compare.js').then((m) => m.ComparePage));
export const FixesPage = onOpen(() => import('./Fixes.js').then((m) => m.FixesPage));
export const TestsPage = onOpen(() => import('./Tests.js').then((m) => m.TestsPage));
export const TrainingPage = onOpen(() => import('./Training.js').then((m) => m.TrainingPage));
export const SettingsPage = onOpen(() => import('./Settings.js').then((m) => m.SettingsPage));
export const NewProjectPage = onOpen(() => import('./NewProject.js').then((m) => m.NewProjectPage));
export const SetupPage = onOpen<{ asked?: boolean }>(() => import('./Setup.js').then((m) => m.SetupPage));
export const StoreSetupPage = onOpen(() => import('./settings/StoreSetup.js').then((m) => m.StoreSetupPage));
