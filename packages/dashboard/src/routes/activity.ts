import { activity } from '../activity.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';

/** `GET /api/activity?limit=&before=`: the activity feed, newest first, a page at a time. */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/activity', (r) => {
    const limit = r.query.get('limit');
    const before = r.query.get('before');
    const n = limit === null ? undefined : Number(limit);
    const b = before === null ? undefined : Number(before);
    if (n !== undefined && !Number.isFinite(n)) throw new HttpError(400, 'limit is a number');
    if (b !== undefined && !Number.isFinite(b)) throw new HttpError(400, 'before is a time in milliseconds, as the last page\'s next');
    r.tagged(activity(ctx.store, { ...(n !== undefined ? { limit: n } : {}), ...(b !== undefined ? { before: b } : {}) }));
  });
}
