import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';

/**
 * Compare two runs: what changed between them, then call by call (`GET /api/compare?a=&b=`), worked
 * out beside the server (read-pool.ts): two long runs take seconds, which hold up no other request.
 * The code card's commits and subject come from the project folder's git, asked at most once a minute
 * per pair of revisions.
 */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/compare', async (r) => {
    const a = r.query.get('a');
    const b = r.query.get('b');
    if (!a || !b) throw new HttpError(400, 'a and b are required');
    // A side that names no single run (several runs, a prefix too short; or none) is said by the read model.
    sendAnswer(r, await ctx.reads.run({ kind: 'compare', a, b, cwd: ctx.project?.path ?? null }));
  });
}
