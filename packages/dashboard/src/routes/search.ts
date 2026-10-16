import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';
import { searchRecorded } from '../search-hits.js';

/**
 * Search over what runs recorded: prompts, responses, tool arguments and results. Hits from runs of
 * their own come first, then hits from attempts whose run has none, each naming the run it is an
 * attempt of (`attemptOf`), so the palette can show the run rather than its probes; at most two hits
 * of a run (search-hits.ts).
 */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/search', (r) => {
    const q = (r.query.get('q') ?? '').slice(0, 500);
    const limit = Math.min(100, Math.max(1, Number(r.query.get('limit') ?? 30) || 30));
    r.json({ hits: searchRecorded(ctx.store, q, limit) });
  });
}
