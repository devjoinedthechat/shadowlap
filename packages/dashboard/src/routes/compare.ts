import { codeChangeCache, compareView } from '../compare.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';

/**
 * Compare two runs: what changed between them, then call by call (`GET /api/compare?a=&b=`). The
 * code card's commits and subject come from the project folder's git, asked at most once a minute
 * per pair of revisions.
 */
export function register(router: Router, ctx: RouteContext): void {
  const code = codeChangeCache();
  router.get('/compare', async (r) => {
    const a = r.query.get('a');
    const b = r.query.get('b');
    if (!a || !b) throw new HttpError(400, 'a and b are required');
    const c = await compareView(ctx.store, a, b, { cwd: ctx.project?.path ?? null, code });
    if (!c) throw new HttpError(404, 'one of the runs does not exist');
    r.tagged(c);
  });
}
