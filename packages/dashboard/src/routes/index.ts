import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';
import * as activity from './activity.js';
import * as changes from './changes.js';
// Checks: a check tried on the recordings, nothing replayed (the check builder's preview).
import * as checks from './checks.js';
import * as codingAgents from './coding-agents.js';
import * as compare from './compare.js';
import * as decisions from './decisions.js';
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
// Injection tests: their results, a run's and a golden's, the security report, and the injection job.
import * as injection from './injection.js';
import * as overview from './overview.js';
import * as runsList from './runs-list.js';
import * as teamStore from './store.js';
// Error-path presets and production coverage: their results, read models and jobs.
import * as chaos from './chaos.js';
import * as coverage from './coverage.js';
// Forks: what a fork did differently from its parent, and a fork from a result edited in the inspector.
import * as forks from './forks.js';
// A fix's attempts grouped by what each did, for its Blame and Verify steps.
import * as attemptGroups from './attempt-groups.js';

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
  // Settings → Coding agents' install: the skill-install job kind.
  codingAgents,
  // Several projects behind one dashboard: the switcher, Add a project, the setup, removing one.
  projects,
  // Training: pairs, tasks, scores and the models to score (#/training).
  training,
  checks,
  // The decision diff: decisions and migrate sessions, a run's decisions, retirements, and their jobs.
  decisions,
  // Injection tests (shadowlap injection): results, trust, templates, the security report.
  injection,
  // Error-path presets (a run's presets matrix) and production coverage (Tests' Not covered panel).
  chaos,
  coverage,
  forks,
  attemptGroups,
];

export function registerRoutes(router: Router, ctx: RouteContext): void {
  for (const m of ROUTE_MODULES) m.register(router, ctx);
}
