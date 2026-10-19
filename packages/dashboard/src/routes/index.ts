import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';
import * as activity from './activity.js';
import * as changes from './changes.js';
import * as compare from './compare.js';
import * as files from './files.js';
import * as fixes from './fixes.js';
import * as jobs from './jobs.js';
import * as meta from './meta.js';
import * as projects from './projects.js';
import * as runs from './runs.js';
// The run page: what it offers to do with a run, show --json, and the Share menu's exports.
import * as runPage from './run-page.js';
import * as search from './search.js';
import * as settings from './settings.js';
import * as tests from './tests.js';
import * as training from './training.js';
import * as uploads from './uploads.js';
// overview-runs: the Overview, the Runs page, imports and the team store.
import * as imports from './imports.js';
import * as overview from './overview.js';
import * as runsList from './runs-list.js';
import * as teamStore from './store.js';
// Error-path presets and production coverage: their results, read models and jobs.
import * as chaos from './chaos.js';
import * as coverage from './coverage.js';

/** A feature's routes (and job kinds): `routes/<feature>.ts` exports `register(router, ctx)`. */
export interface RouteModule {
  register(router: Router, ctx: RouteContext): void;
}

/**
 * Every feature the API serves. Adding one is its module and one line here; see router.ts for what
 * a module looks like.
 */
export const ROUTE_MODULES: RouteModule[] = [
  meta,
  changes,
  runs,
  runPage,
  search,
  compare,
  jobs,
  files,
  uploads,
  activity,
  // overview-runs
  overview,
  runsList,
  teamStore,
  imports,
  fixes,
  tests,
  settings,
  // Several projects behind one dashboard: the switcher, Add a project, the setup, removing one.
  projects,
  // Training: pairs, tasks, scores and the models to score (#/training).
  training,
  // Error-path presets (a run's presets matrix) and production coverage (Tests' Not covered panel).
  chaos,
  coverage,
];

export function registerRoutes(router: Router, ctx: RouteContext): void {
  for (const m of ROUTE_MODULES) m.register(router, ctx);
}
