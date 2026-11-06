import { choicesInCheckout } from '../commits-here.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { answerData, sendAnswer } from '../read-pool.js';
import { deleteRunsApart } from '../delete-apart.js';
import { filterTerms, RECORDED_MIN_CHARS } from '../links.js';
import { knownRuns, labelRuns, runsByDayOptions, runsPageOptions, type RunRow } from '../runs-list.js';
import { LATER_FAILURES, type DayFailure } from '../runs-failures.js';
import { bisectChoices, type BisectChoices } from '../tests.js';
import { readTeamStoreInput, type TeamStoreInput } from '../team-store.js';
import { goldensOf, projectWork } from '../outcome-work.js';

/**
 * The Runs page: the table a page at a time, the 12-week calendar above it, Find breaking commit for the
 * failures on the days picked, and the bulk bar's label and delete.
 *
 *   GET  /api/runs/page?limit&cursor&from&to&types&q&attempts&sort   a page of the table
 *   GET  /api/runs/days?weeks&tz&types&q&attempts                    runs per day, in the viewer's days
 *
 * With a team store, `types=local` (the Local chip, where Needs a look's Push leads) is the runs only
 * on this machine, as the store's status counts them, and the chip counts say how many.
 *   GET  /api/runs/bisect?from&to&types&q                             Find breaking commit, for the days picked
 *   POST /api/runs/labels { ids, add, remove }                        label several runs
 *   POST /api/runs/delete { ids }                                     delete several runs
 *   POST /api/runs/known { ids }                                      which runs picked are still there
 *
 * A bad cursor, filter or time zone is a 400. Labels and delete are refused on a read-only
 * dashboard; `known` changes nothing (a POST only because a selection can be long).
 */

/**
 * A row of the table; with a team store set, whether something of the run is only on this machine
 * (`local`): the run itself, or attempts bundled under it, which a push of the run sends with it.
 * `localAttempts` says how many of those attempts there are, and whether the run itself is one.
 */
export type RunsPageRow = RunRow & { local?: boolean; localAttempts?: { run: boolean; attempts: number } };

/**
 * What Find breaking commit offers for the failures on the days picked: the run it starts from and the
 * choices bisect has, or why there is none. `earlier` is the first failure on those days when it
 * failed at the first commit, with nothing before it to search, and why: the run offered is the
 * first failure that started later.
 */
export type DaysBisect = { runId: string; label: string; command: string; startedAt: number; choices: BisectChoices; earlier?: { runId: string; why: string } } | { runId: null; reason: string };

/** The team store as the project's config names it, for the Local chip and the `local` tag; null without one. */
function teamOf(ctx: RouteContext): TeamStoreInput | null {
  if (!ctx.project) return null;
  const team = readTeamStoreInput({ cwd: ctx.project.path });
  return team.store ? team : null;
}

/**
 * A read whose filter has words that read what runs recorded: the search index takes in what runs
 * still recording said first, a moment at most, as a search does (routes/search.ts), and whatever
 * else arrived since is indexed after.
 */
async function withRecorded<T>(ctx: RouteContext, q: string | undefined, read: () => Promise<T>): Promise<T> {
  if (!filterTerms(q).words.some((w) => w.length >= RECORDED_MIN_CHARS)) return read();
  await ctx.search.recordings();
  const a = await read();
  ctx.search.look();
  return a;
}

export function register(router: Router, ctx: RouteContext): void {
  const { store } = ctx;

  // Worked out beside the server (read-pool.ts). Its filter field matches the about lines and the
  // verdicts known, and the sort by spent the totals known: while the warm-up works out the rest, the
  // page says so (`warming`), and asks again.
  router.get('/runs/page', async (r) => {
    const o = runsPageOptions(r.query);
    if ('error' in o) throw new HttpError(400, o.error);
    const a = await withRecorded(ctx, o.q, () => ctx.reads.run({ kind: 'runs-page', options: { ...o, ...ctx.read }, team: teamOf(ctx), ...projectWork(ctx) }));
    if (a.warming) ctx.reads.warm();
    sendAnswer(r, a);
  });

  // The same filter, read the same way: the row of days counts the runs the table lists.
  router.get('/runs/days', async (r) => {
    const o = runsByDayOptions(r.query);
    if ('error' in o) throw new HttpError(400, o.error);
    const a = await withRecorded(ctx, o.q, () => ctx.reads.run({ kind: 'runs-days', options: o, team: o.types?.includes('local') ? teamOf(ctx) : null, outcome: projectWork(ctx).outcome }));
    if (a.warming) ctx.reads.warm();
    sendAnswer(r, a);
  });

  // Find breaking commit, from the calendar: with Failed picked and days chosen, the first failure in
  // those days is where it started failing; bisect looks between a commit where it still worked
  // before the first day picked and that failure's own commit. A failure at the first commit has
  // nothing before it to search: the first failure that started later is offered instead, and the
  // dialog says why; with none, the first failure says so.
  router.get('/runs/bisect', async (r) => {
    const o = runsPageOptions(r.query);
    if ('error' in o) throw new HttpError(400, o.error);
    if (o.from == null || o.to == null) throw new HttpError(400, 'from and to: the days picked');
    // The failures the filter matches, oldest first, matched beside the server (runs-failures.ts).
    const job = { kind: 'runs-failures' as const, options: { from: o.from, to: o.to, ...(o.types ? { types: o.types } : {}), ...(o.q ? { q: o.q } : {}) }, outcome: projectWork(ctx).outcome };
    const { failures } = answerData<{ failures: DayFailure[] }>(await withRecorded(ctx, o.q, () => ctx.reads.run(job)));
    if (!failures.length) return r.json({ runId: null, reason: 'nothing failed on the days picked' } satisfies DaysBisect);
    const offer = (run: DayFailure, choices: BisectChoices) => ({ ...run, choices });
    let earlier: { run: DayFailure; choices: BisectChoices } | null = null;
    for (const run of failures.slice(0, LATER_FAILURES)) {
      const all = bisectChoices(store, run.runId, { goldens: goldensOf(ctx), before: o.from });
      if (!all) continue;
      // Only commits this checkout has (a teammate's pulled runs name commits of theirs), and none before its first.
      const choices = await choicesInCheckout(ctx.project?.path, all);
      if (!choices.first) return r.json({ ...offer(run, choices), ...(earlier ? { earlier: { runId: earlier.run.runId, why: earlier.choices.unavailable! } } : {}) } satisfies DaysBisect);
      earlier ??= { run, choices };
    }
    if (!earlier) return r.json({ runId: null, reason: 'that run is gone' } satisfies DaysBisect);
    r.json(offer(earlier.run, { ...earlier.choices, unavailable: `${earlier.choices.unavailable!}, and no failure on the days picked started later` }) satisfies DaysBisect);
  });

  router.post('/runs/labels', async (r) => {
    const body = await r.body();
    const out = labelRuns(store, body.ids, body.add, body.remove);
    if ('error' in out) throw new HttpError(400, out.error);
    r.json(out);
  });

  // Beside the server (delete-apart.ts): fifty runs at 10,000 held its thread 1.3 s.
  router.post('/runs/delete', async (r) => {
    const body = await r.body();
    const out = await deleteRunsApart(store, ctx.options.dbPath, body.ids);
    if ('error' in out) throw new HttpError(400, out.error);
    r.json(out);
  });

  router.post(
    '/runs/known',
    async (r) => {
      const body = await r.body();
      const out = knownRuns(store, body.ids);
      if ('error' in out) throw new HttpError(400, out.error);
      r.json(out);
    },
    { write: false },
  );
}
