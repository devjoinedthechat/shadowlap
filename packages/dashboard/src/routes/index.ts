import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';
import * as activity from './activity.js';
import * as changes from './changes.js';
import * as compare from './compare.js';
import * as files from './files.js';
import * as jobs from './jobs.js';
import * as meta from './meta.js';
import * as runs from './runs.js';
import * as search from './search.js';
import * as training from './training.js';
import * as uploads from './uploads.js';

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
  search,
  compare,
  jobs,
  files,
  uploads,
  activity,
  // Training: pairs, tasks, scores and the models to score (#/training).
  training,
];

export function registerRoutes(router: Router, ctx: RouteContext): void {
  for (const m of ROUTE_MODULES) m.register(router, ctx);
}
