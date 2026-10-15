import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { deleteRuns, labelRuns, listRunsPage, matchingRuns, runsByDay, runsByDayOptions, runsPageOptions, type RunRow } from '../runs-list.js';
import { bisectChoices, type BisectChoices } from '../tests.js';
import { goldensOf } from './overview.js';
import { localRunIds, teamStoreFor } from './store.js';

/**
 * The Runs page: the table a page at a time, the 12-week calendar above it, Find the commit for the
 * failures on the days picked, and the bulk bar's label and delete.
 *
 *   GET  /api/runs/page?limit&cursor&from&to&types&q&attempts&sort   a page of the table
 *   GET  /api/runs/days?weeks&tz&types&q&attempts                    runs per day, in the viewer's days
 *   GET  /api/runs/bisect?from&to&types&q                             Find the commit, for the days picked
 *   POST /api/runs/labels { ids, add, remove }                        label several runs
 *   POST /api/runs/delete { ids }                                     delete several runs
 *
 * A bad cursor, filter or time zone is a 400. The two writes are refused on a read-only dashboard.
 */

/** A row of the table; with a team store set, whether the run is only on this machine. */
export type RunsPageRow = RunRow & { local?: boolean };

/** What Find the commit offers for the failures on the days picked: the run it starts from and the choices bisect has, or why there is none. */
export type DaysBisect = { runId: string; label: string; command: string; startedAt: number; choices: BisectChoices } | { runId: null; reason: string };

const asRangeError = (err: unknown): never => {
  if (err instanceof RangeError) throw new HttpError(400, err.message);
  throw err;
};

export function register(router: Router, ctx: RouteContext): void {
  const { store } = ctx;

  router.get('/runs/page', (r) => {
    const o = runsPageOptions(r.query);
    if ('error' in o) throw new HttpError(400, o.error);
    let page: ReturnType<typeof listRunsPage>;
    try {
      page = listRunsPage(store, { ...o, ...ctx.read });
    } catch (err) {
      return asRangeError(err);
    }
    // With a team store, each row says whether it is only here: the `local` tag.
    const team = teamStoreFor(ctx);
    const local = team ? localRunIds(store, team.url, page.runs.map((x) => x.runId)) : null;
    const runs: RunsPageRow[] = local ? page.runs.map((x) => ({ ...x, local: local.has(x.runId) })) : page.runs;
    r.tagged({ ...page, runs });
  });

  router.get('/runs/days', (r) => {
    const o = runsByDayOptions(r.query);
    if ('error' in o) throw new HttpError(400, o.error);
    try {
      r.tagged(runsByDay(store, o));
    } catch (err) {
      asRangeError(err);
    }
  });

  // Find the commit, from the calendar: with Failed picked and days chosen, the first failure in
  // those days is where it started failing; bisect looks between a commit where it still worked
  // before the first day picked and that failure's own commit.
  router.get('/runs/bisect', (r) => {
    const o = runsPageOptions(r.query);
    if ('error' in o) throw new HttpError(400, o.error);
    if (o.from == null || o.to == null) throw new HttpError(400, 'from and to: the days picked');
    // Newest first: the first failure is the last.
    const first = matchingRuns(store, { from: o.from, to: o.to, types: [...new Set([...(o.types ?? []), 'failed' as const])], ...(o.q ? { q: o.q } : {}) }).at(-1);
    if (!first) return r.json({ runId: null, reason: 'nothing failed on the days picked' } satisfies DaysBisect);
    const choices = bisectChoices(store, first.runId, { goldens: goldensOf(ctx), before: o.from });
    if (!choices) return r.json({ runId: null, reason: 'that run is gone' } satisfies DaysBisect);
    r.json({ runId: first.runId, label: first.label, command: first.source ?? first.argv.join(' '), startedAt: first.startedAt, choices } satisfies DaysBisect);
  });

  router.post('/runs/labels', async (r) => {
    const body = await r.body();
    const out = labelRuns(store, body.ids, body.add, body.remove);
    if ('error' in out) throw new HttpError(400, out.error);
    r.json(out);
  });

  router.post('/runs/delete', async (r) => {
    const body = await r.body();
    const out = deleteRuns(store, body.ids);
    if ('error' in out) throw new HttpError(400, out.error);
    r.json(out);
  });
}
