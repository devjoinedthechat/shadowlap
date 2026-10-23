import { createHash } from 'node:crypto';
import type { Price, Store } from '@shadowlap/engine';
import { callDetail, lineage, listRuns, lookupRun, noSuchRun, runCallsPage, runDetail, type ReadOptions } from './api.js';
import { codeChangeCache, compareView } from './compare.js';
import { patchesToCheck } from './fixes.js';
import { overviewKnown, overviewSummary } from './overview.js';
import { patchesInTree } from './patch-in-tree.js';
import { localRunIds } from './routes/store.js';
import { runCalls } from './run-calls.js';
import { loadRunIndex } from './run-index.js';
import { analyseRun } from './run-page.js';
import { asksFor, asksOf, warmProgress, warmRunStats } from './run-stats.js';
import type { RunsPageRow } from './routes/runs-list.js';
import { listRunsPage, runsByDay, type RunsByDayOptions, type RunsPageOptions } from './runs-list.js';
import { setupUnderWay } from './store-setup.js';
import { localRunSet, teamStoreStatus, type TeamStoreInput } from './team-store.js';
import type { GoldenSource } from './tests.js';

/**
 * The read models that read every call of a run, or of every run: the Overview, a run's page and
 * its calls, a call's details, a run's family, Compare, the run list (its filter and its sort by
 * spent among them), the calendar and the sidebar's runs, and the warm-up that works run totals out
 * ahead. Each is a job: plain data in, the answer out as JSON text, so it runs as well on a worker
 * thread of its own (read-worker.ts, for a store with a file) as here (a store in memory). What the
 * server needs to answer it (who asks, the project's config) is read before, on its own thread.
 */

/** The Overview: as `GET /api/summary` asks for it, with what the server read of the project. */
export interface SummaryWork {
  tz?: string;
  now?: number;
  prices?: Record<string, Price>;
  goldens: GoldenSource[];
  /** The project's team store, as its config names it; null without one. */
  team: TeamStoreInput | null;
  /** The project's folder: git says from there whether a verified fix's patch is in the working tree. */
  project: string | null;
  /** The warm-up has been through every run: what is still unknown is worked out now rather than waited for. */
  warmed: boolean;
}

export type ReadJob =
  | { kind: 'summary'; work: SummaryWork }
  | { kind: 'run'; runId: string; read: ReadOptions; after?: number }
  | { kind: 'calls'; runId: string; read: ReadOptions; from: number; limit: number }
  | { kind: 'call'; runId: string; read: ReadOptions; callNo: number }
  | { kind: 'lineage'; runId: string; read: ReadOptions }
  | { kind: 'compare'; a: string; b: string; cwd: string | null }
  | { kind: 'runs-page'; options: Omit<RunsPageOptions, 'localRuns'>; team: TeamStoreInput | null }
  | { kind: 'runs-days'; options: Omit<RunsByDayOptions, 'localRuns'>; team: TeamStoreInput | null }
  | { kind: 'recent'; read: ReadOptions }
  /** The whole analysis of a long run whose first page was answered from its first calls. */
  | { kind: 'analyse'; runId: string }
  /** A slice of the warm-up (run-stats.ts `warmRunStats`), about `budgetMs` long. */
  | { kind: 'warm'; budgetMs: number };

export interface ReadAnswer {
  status: number;
  /** The answer as JSON text. */
  body: string;
  /** For an answer a browser may keep and ask about again: its ETag; null for one it must not keep (a warming answer, the Overview). */
  etag: string | null;
  /** Set when the answer is not whole yet and says so (`warming`): asked again, it has more. */
  warming?: boolean;
  /** Work for beside the server once this is answered: the whole analysis of a long run answered from its first calls. */
  then?: ReadJob;
  /** A warm-up slice: whether it has been through every run, and how far it has gone. */
  warm?: { done: boolean; walked: number; total: number };
}

const tagOf = (text: string) => `"${createHash('sha1').update(text).digest('base64url')}"`;

function answer(body: unknown, o: { tagged?: boolean; status?: number } = {}): ReadAnswer {
  const text = JSON.stringify(body);
  const warming = typeof body === 'object' && body !== null && 'warming' in body;
  return { status: o.status ?? 200, body: text, etag: o.tagged && !warming ? tagOf(text) : null, ...(warming ? { warming } : {}) };
}

const failed = (status: number, error: string): ReadAnswer => ({ status, body: JSON.stringify({ error }), etag: null });

/** A run id that names no single run: several runs (409), or none (404). */
function noRun(store: Store, id: string): ReadAnswer {
  const no = noSuchRun(store, id);
  return failed(no.status, no.message);
}

/** What git said about the code between two revisions, kept for a minute per pair: one per thread. */
const code = codeChangeCache();

/** The team store's key, for the runs only on this machine (the Local chip, the `local` tag); null without one. */
function teamKey(store: Store, team: TeamStoreInput | null): string | null {
  return team ? (teamStoreStatus(store, team)?.key ?? null) : null;
}

async function summary(store: Store, w: SummaryWork, whole: boolean): Promise<ReadAnswer> {
  const when = { ...(w.tz ? { tz: w.tz } : {}), ...(w.now !== undefined ? { now: w.now } : {}) };
  // Not worked out yet, and the warm-up is at it: say how far it is, at once.
  if (!whole && !w.warmed) {
    const known = overviewKnown(store, when);
    if (known.done < known.total) return answer({ warming: known });
  }
  const status = w.team ? teamStoreStatus(store, w.team) : null;
  // A setup of the store left unfinished leads back to its page.
  const setup = status && w.team && w.project ? setupUnderWay(store, w.team) : null;
  const patchInTree = w.project ? await patchesInTree(w.project, patchesToCheck(store)) : null;
  // It names the time it was worked out at, so it is never the same twice: no ETag.
  return answer(overviewSummary(store, { ...when, ...(w.prices ? { prices: w.prices } : {}), goldens: w.goldens, teamStore: status ? { name: status.name, onlyLocal: status.onlyLocal, setup } : null, ...(patchInTree ? { patchInTree } : {}) }));
}

function runsPage(store: Store, options: Omit<RunsPageOptions, 'localRuns'>, team: TeamStoreInput | null, whole: boolean): ReadAnswer {
  const key = teamKey(store, team);
  const page = listRunsPage(store, { ...options, known: !whole, localRuns: key ? localRunSet(store, key) : null });
  // With a team store, each row says whether it, or an attempt bundled under it, is only here: the
  // `local` tag, and what Push in the bulk bar sends.
  let runs: RunsPageRow[] = page.runs;
  if (key) {
    const index = loadRunIndex(store);
    const attemptsOf = (runId: string) => (index.attempts.get(runId) ?? []).map((a) => a.runId);
    const local = localRunIds(store, key, page.runs.flatMap((x) => [x.runId, ...attemptsOf(x.runId)]));
    runs = page.runs.map((x) => {
      const n = attemptsOf(x.runId).filter((id) => local.has(id)).length;
      return { ...x, local: local.has(x.runId) || n > 0, ...(n ? { localAttempts: { run: local.has(x.runId), attempts: n } } : {}) };
    });
  }
  return answer({ ...page, runs }, { tagged: true });
}

/**
 * Works out one job against `store`. Never throws for what the job asks: a bad request or a missing
 * run is its answer. `whole` works out what isn't known yet rather than answer with how far the
 * warm-up has got: for a store in memory, whose read models run on the server's own thread anyway.
 */
export async function runJob(store: Store, job: ReadJob, o: { whole?: boolean } = {}): Promise<ReadAnswer> {
  const whole = o.whole === true;
  try {
    switch (job.kind) {
      case 'summary':
        return await summary(store, job.work, whole);
      case 'run': {
        const d = runDetail(store, job.runId, job.read, job.after === undefined ? {} : { after: job.after });
        if (!d) return noRun(store, job.runId);
        // The route tags it by where the run stands (run-version.ts); a long run answered from its
        // first calls is analysed whole beside the server, for the page to ask again.
        return { ...answer(d), ...(d.warming ? { then: { kind: 'analyse', runId: d.run.runId } } : {}) };
      }
      case 'calls': {
        const page = runCallsPage(store, job.runId, { from: job.from, limit: job.limit }, job.read);
        if (!page) return noRun(store, job.runId);
        return { ...answer(page, { tagged: true }), ...(page.warming ? { then: { kind: 'analyse', runId: page.runId } } : {}) };
      }
      case 'call': {
        const d = callDetail(store, job.runId, job.callNo, job.read);
        return d ? answer(d, { tagged: true }) : failed(404, `no call #${job.callNo} in run ${job.runId}`);
      }
      case 'lineage': {
        const nodes = lineage(store, job.runId, job.read);
        return nodes ? answer({ nodes }, { tagged: true }) : failed(404, `no run ${job.runId}`);
      }
      case 'compare': {
        for (const id of [job.a, job.b]) {
          if (lookupRun(store, id)) continue;
          const no = noSuchRun(store, id);
          return failed(no.status, no.status === 404 ? 'one of the runs does not exist' : no.message);
        }
        const c = await compareView(store, job.a, job.b, { cwd: job.cwd, code });
        return c ? answer(c, { tagged: true }) : failed(404, 'one of the runs does not exist');
      }
      case 'runs-page':
        return runsPage(store, job.options, job.team, whole);
      case 'runs-days': {
        const key = job.options.types?.includes('local') ? teamKey(store, job.team) : null;
        return answer(runsByDay(store, { ...job.options, known: !whole, localRuns: key ? localRunSet(store, key) : null }), { tagged: true });
      }
      case 'recent':
        return answer({ runs: listRuns(store, job.read) }, { tagged: true });
      case 'analyse': {
        const run = lookupRun(store, job.runId);
        if (run) {
          analyseRun(store, run, runCalls(store, run.runId));
          // And what its user asked first, read from every request it sent: kept for its about line.
          const index = loadRunIndex(store);
          const r = index.byId.get(run.runId);
          if (r && asksFor(r)) asksOf(store, index, [r]);
        }
        return answer(null);
      }
      case 'warm': {
        const done = warmRunStats(store, { budgetMs: job.budgetMs });
        const at = warmProgress(store);
        return { ...answer(null), warm: { done, walked: at?.walked ?? 0, total: at?.total ?? 0 } };
      }
    }
  } catch (err) {
    // A cursor or a time zone the read model doesn't know: the request's mistake.
    if (err instanceof RangeError) return failed(400, err.message);
    throw err;
  }
}
