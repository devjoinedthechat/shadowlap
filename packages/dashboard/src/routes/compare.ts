import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';

/**
 * Compare two runs: what changed between them, then call by call (`GET /api/compare?a=&b=`), worked
 * out beside the server (read-pool.ts): two long runs take seconds, which hold up no other request.
 * `part=head` answers at once with what the page shows first meanwhile: the identical prefix and the
 * first request that differs (compare.ts `compareHead`). The code card's commits and subject come
 * from the project folder's git, asked at most once a minute per pair of revisions.
 */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/compare', async (r) => {
    const a = r.query.get('a');
    const b = r.query.get('b');
    if (!a || !b) throw new HttpError(400, 'a and b are required');
    const part = r.query.get('part');
    if (part !== null && part !== 'head') throw new HttpError(400, 'part is head, or left out for the whole comparison');
    // A side that names no single run (several runs, a prefix too short; or none) is said by the read model.
    sendAnswer(r, await ctx.reads.run(part === 'head' ? { kind: 'compare-head', a, b } : { kind: 'compare', a, b, cwd: ctx.project?.path ?? null }));
  });
}
