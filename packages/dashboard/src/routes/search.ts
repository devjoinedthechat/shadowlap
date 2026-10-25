import type { RouteContext } from '../context.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';

/**
 * Search over what runs recorded: prompts, responses, tool arguments and results. Hits from runs of
 * their own come first, then hits from attempts whose run has none, each naming the run it is an
 * attempt of (`attemptOf`), so the palette can show the run rather than its probes; at most two hits
 * of a run (search-hits.ts). It answers from what the index holds, worked out beside the server
 * (read-jobs.ts `search`), and `indexing` says how many runs the index has yet to cover: the index is
 * brought up to date beside the requests (search-index.ts), never inside one, but for what runs still
 * recording said since the last search, which it waits a moment for.
 */
export function register(router: Router, ctx: RouteContext): void {
  // From the start, so the first search finds the index built.
  ctx.search.look();

  router.get('/search', async (r) => {
    const q = (r.query.get('q') ?? '').slice(0, 500);
    const limit = Math.min(100, Math.max(1, Number(r.query.get('limit') ?? 30) || 30));
    await ctx.search.recordings();
    sendAnswer(r, await ctx.reads.run({ kind: 'search', q, limit }));
    // Whatever else arrived since the last look is indexed next.
    ctx.search.look();
  });
}
