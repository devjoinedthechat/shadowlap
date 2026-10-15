import { changesView } from '../changes.js';
import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';

/**
 * `GET /api/changes?since=<cursor>`: what changed since the browser last asked, from counters the
 * store keeps, so the UI polls one tiny endpoint and refetches only what moved (see ChangesView).
 */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/changes', (r) => r.json(changesView(ctx.store, { boot: ctx.instance, jobsVersion: ctx.jobs.version, since: r.query.get('since') })));
}
