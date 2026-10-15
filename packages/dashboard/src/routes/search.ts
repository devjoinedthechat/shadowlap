import { searchCalls } from '@shadowlap/engine';
import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';

/** Search over what runs recorded: prompts, responses, tool arguments and results. */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/search', (r) => {
    const q = (r.query.get('q') ?? '').slice(0, 500);
    const limit = Math.min(100, Math.max(1, Number(r.query.get('limit') ?? 30) || 30));
    r.json({ hits: searchCalls(ctx.store, q, { limit }) });
  });
}
