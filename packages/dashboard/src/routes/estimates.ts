import { lookupRun, noSuchRun } from '../api.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';
import { runAffinity } from '../run-index.js';
import { runVersionTag } from '../run-version.js';

/** A model as `--model` takes it: a name, never a flag (routes/fixes.ts checks a job's so). */
const MODEL = /^[A-Za-z0-9][\w.:/@-]{0,119}$/;

/** A call's number from the query string, 1 or more; null when absent. */
function callNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!(Number.isInteger(n) && n >= 1)) throw new HttpError(400, 'at is a call number: a whole number, 1 or more');
  return n;
}

/**
 * What the billed jobs a page offers would cost (estimates.ts), each a pooled read: a run's, by the
 * thread that holds it. Asked when the page or the menu opens, apart from the page's own answer.
 */
export function register(router: Router, ctx: RouteContext): void {
  // A run's Run blame, and its fork menu's rows at call `at` (the whole run's alone without it), with
  // Switch model's at `model`. Revalidated from where the run stands, the prices and what was asked:
  // a changed price or another call is never answered with the last one's figures.
  router.get('/runs/:id/estimates', async (r) => {
    const store = ctx.store;
    const run = lookupRun(store, r.params.id!);
    if (!run) {
      const no = noSuchRun(store, r.params.id!);
      throw new HttpError(no.status, no.message);
    }
    const at = callNumber(r.query.get('at'));
    const model = r.query.get('model')?.trim() || null;
    if (model !== null && !MODEL.test(model)) throw new HttpError(400, 'model is a model’s name, such as claude-opus-5-5');
    const etag = runVersionTag(store, run, JSON.stringify([ctx.read, at, model]));
    if (r.req.headers['if-none-match'] === etag) {
      r.res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      r.res.end();
      return;
    }
    const job = { kind: 'run-estimates' as const, runId: run.runId, at, model, ...(ctx.read.prices ? { prices: ctx.read.prices } : {}) };
    sendAnswer(r, await ctx.reads.run(job, runAffinity(ctx.store, run.runId)), { etag });
  });
}
