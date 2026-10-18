import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';
import { loadRunIndex } from '../run-index.js';
import { catchUpSearch, searchBehind, searchRecorded, type SearchAnswer } from '../search-hits.js';

/**
 * Search over what runs recorded: prompts, responses, tool arguments and results. Hits from runs of
 * their own come first, then hits from attempts whose run has none, each naming the run it is an
 * attempt of (`attemptOf`), so the palette can show the run rather than its probes; at most two hits
 * of a run (search-hits.ts). It answers from what the index holds, and `indexing` says how many runs
 * the index has yet to cover: it is brought up to date beside the requests, never inside one.
 */
export function register(router: Router, ctx: RouteContext): void {
  // From the start, so the first search finds the index built: a slice at a time while idle. A
  // project whose store can't be opened now has nothing to index.
  try {
    catchUpSearch(ctx.store);
  } catch {
    // its searches start the catching up once it can be
  }

  router.get('/search', (r) => {
    const q = (r.query.get('q') ?? '').slice(0, 500);
    const limit = Math.min(100, Math.max(1, Number(r.query.get('limit') ?? 30) || 30));
    const store = ctx.store;
    const index = loadRunIndex(store);
    const behind = searchBehind(store, index);
    // Whatever arrived since the last slice (a recording's newest calls) is indexed next.
    catchUpSearch(store);
    const answer: SearchAnswer = { hits: searchRecorded(store, q, limit, index), ...(behind ? { indexing: { runs: behind, of: index.runs.length } } : {}) };
    r.json(answer);
  });
}
