import { searchCalls } from '@shadowlap/engine';
import type { RouteContext } from '../context.js';
import { loadRunIndex } from '../run-index.js';
import type { Router } from '../router.js';
import { rankRecorded, searchDepth } from '../search-hits.js';

/**
 * Search over what runs recorded: prompts, responses, tool arguments and results. Hits from runs of
 * their own come before hits from attempts, and each names the run an attempt belongs to
 * (`attemptOf`), so the palette can show the run rather than its probes (search-hits.ts).
 */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/search', (r) => {
    const q = (r.query.get('q') ?? '').slice(0, 500);
    const limit = Math.min(100, Math.max(1, Number(r.query.get('limit') ?? 30) || 30));
    const hits = searchCalls(ctx.store, q, { limit: searchDepth(limit) });
    r.json({ hits: rankRecorded(hits, loadRunIndex(ctx.store).byId, limit) });
  });
}
