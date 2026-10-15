import { compare } from '../api.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';

/** Compare two runs: what changed between them, then call by call. */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/compare', (r) => {
    const a = r.query.get('a');
    const b = r.query.get('b');
    if (!a || !b) throw new HttpError(400, 'a and b are required');
    const c = compare(ctx.store, a, b);
    if (!c) throw new HttpError(404, 'one of the runs does not exist');
    r.tagged(c);
  });
}
