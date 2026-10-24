import { parseActivityCursor } from '../activity.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';

/**
 * `GET /api/activity?limit=&before=`: the activity feed, newest first, a page at a time. `before`
 * is the last page's `next` (or a time in milliseconds); empty means the first page. What a run's
 * calls add up to is read the first time it shows: worked out beside the server (read-pool.ts).
 */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/activity', async (r) => {
    const limit = r.query.get('limit');
    const before = r.query.get('before') || null;
    const n = limit === null || limit === '' ? undefined : Number(limit);
    if (n !== undefined && !Number.isFinite(n)) throw new HttpError(400, 'limit is a number');
    if (before !== null && !parseActivityCursor(before)) throw new HttpError(400, 'before is the last page\'s next, or a time in milliseconds');
    sendAnswer(r, await ctx.reads.run({ kind: 'activity', ...(n !== undefined ? { limit: n } : {}), before }));
  });
}
