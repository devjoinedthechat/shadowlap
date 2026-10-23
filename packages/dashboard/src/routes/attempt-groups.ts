import { fixAttemptGroups } from '../attempt-groups.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';

/**
 * A fix's attempts grouped by what each did (`GET /api/fixes/:id/groups`): its blame's probes and
 * each verified run, for the Blame and Verify steps. Read apart from the fix itself, since it reads
 * every attempt's calls: the page shows the fix first and the groups when they arrive.
 */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/fixes/:id/groups', (r) => {
    const groups = fixAttemptGroups(ctx.store, r.params.id!);
    if (!groups) throw new HttpError(404, `no fix ${r.params.id!.slice(0, 40)}`);
    r.tagged(groups);
  });
}
