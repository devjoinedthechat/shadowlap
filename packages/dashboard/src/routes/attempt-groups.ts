import type { RouteContext } from '../context.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';

/**
 * A fix's attempts grouped by what each did (`GET /api/fixes/:id/groups`): its blame's probes and
 * each verified run, for the Blame and Verify steps. Read apart from the fix itself, since it reads
 * every attempt's calls: the page shows the fix first and the groups when they arrive. Worked out
 * beside the server (read-pool.ts, attempt-groups.ts).
 */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/fixes/:id/groups', async (r) => sendAnswer(r, await ctx.reads.run({ kind: 'groups', fixId: r.params.id! })));
}
