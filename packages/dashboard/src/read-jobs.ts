import { createHash } from 'node:crypto';
import type { Normalizer, Price, Store, ToolTrust } from '@shadowlap/engine';
import { activity } from './activity.js';
import { callDetail, lineage, listRuns, lookupRun, noSuchRun, provenance, runCallsPage, runDetail, showRunJson, type ReadOptions } from './api.js';
import { fixAttemptGroups } from './attempt-groups.js';
import { codeChangeCache, compareHead, compareView } from './compare.js';
import { fixDetail, patchesToCheck } from './fixes.js';
import { forkDifferences } from './fork-differences.js';
import { runInjection, toolTrust } from './injection.js';
import { runUnrecorded } from './run-unrecorded.js';
import { overviewKnown, overviewSummary } from './overview.js';
import { patchesInTree } from './patch-in-tree.js';
import { repairerProblem } from './repairer-check.js';
import { localRunIds } from './routes/store.js';
import type { MaskCount } from './run-mask.js';
import { runCalls } from './run-calls.js';
import { loadRunIndex } from './run-index.js';
import { analyseRun } from './run-page.js';
import { asksFor, asksOf, warmProgress, warmRunStats } from './run-stats.js';
import type { RunsPageRow } from './routes/runs-list.js';
import { listRunsPage, runsByDay, type RunsByDayOptions, type RunsPageOptions } from './runs-list.js';
import { searchBehind, searchRecorded, type SearchAnswer } from './search-hits.js';
import { setupUnderWay } from './store-setup.js';
import { localRunSet, teamStoreStatus, type TeamStoreInput } from './team-store.js';
import type { GoldenSource } from './tests.js';

/**
 * The read models that read every call of a run, or of every run: the Overview, a run's page and
 * its calls, a call's details, a run's family, Compare, what a fork did differently, a fix's
 * attempts grouped, the activity feed, a run as JSON, the run list (its filter and its sort by spent among them),
 * the calendar and the sidebar's runs, a search of what runs recorded, and the warm-up that works run totals out ahead. Each is a job: plain data in, the answer out as JSON text, so it runs as well on a worker
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
  /** A page of a run's calls; `whole` waits for the whole run's analysis rather than answer from a part of the run. */
  | { kind: 'calls'; runId: string; read: ReadOptions; from: number; limit: number; whole?: boolean }
  | { kind: 'call'; runId: string; read: ReadOptions; callNo: number; whole?: boolean }
  | { kind: 'lineage'; runId: string; read: ReadOptions }
  | { kind: 'compare'; a: string; b: string; cwd: string | null }
  /** What Compare shows first while the whole comparison is worked out: the identical prefix and the first request that differs (compare.ts `compareHead`). */
  | { kind: 'compare-head'; a: string; b: string }
  | { kind: 'runs-page'; options: Omit<RunsPageOptions, 'localRuns'>; team: TeamStoreInput | null }
  | { kind: 'runs-days'; options: Omit<RunsByDayOptions, 'localRuns'>; team: TeamStoreInput | null }
  | { kind: 'recent'; read: ReadOptions }
  /** What a fork did differently from its parent (fork-differences.ts), masked by the project's normalizers. */
  | { kind: 'differences'; runId: string; normalizers: Normalizer[] }
  /** The tools the model called that the run never recorded (run-unrecorded.ts), under the effects the project's config declares. */
  | { kind: 'unrecorded'; runId: string; declared: Record<string, 'read' | 'write'> }
  /** A fix's attempts grouped by what each did (attempt-groups.ts). */
  | { kind: 'groups'; fixId: string }
  /** A page of the activity feed (activity.ts). */
  | { kind: 'activity'; limit?: number; before: string | null }
  /** A run as `shadowlap show --json` prints it, every call in it (Copy JSON). */
  | { kind: 'show'; runId: string; read: ReadOptions; tools?: ToolTrust }
  /** The whole analysis of a long run whose first page was answered from its first calls. */
  | { kind: 'analyse'; runId: string }
  /** A slice of the warm-up (run-stats.ts `warmRunStats`), about `budgetMs` long. */
  | { kind: 'warm'; budgetMs: number }
  /** A search of what runs recorded, from what the search index holds, and how many runs it has yet to cover (search-hits.ts). */
  | { kind: 'search'; q: string; limit: number }
  /** A run's record for the Provenance tab, with what a copy would mask, counted before on a thread of its own (run-mask.ts). */
  | { kind: 'provenance'; runId: string; read: ReadOptions; mask: MaskCount }
  /** What `shadowlap injection` would plant in a run's untrusted reads, and its results (injection.ts). */
  | { kind: 'injection-run'; runId: string; tools?: ToolTrust }
  /** Every tool the store's recordings called, with its trust, for Settings → Tools (injection.ts). */
  | { kind: 'tool-trust'; tools?: ToolTrust }
  /**
   * A fix with its three steps (fixes.ts `fixDetail`), its blamed run's calls among them: the repairer
   * the config names, and whether each patch the fix could apply is in the working tree, as git said
   * on the server's thread.
   */
  | { kind: 'fix'; fixId: string; repairer: string | null; inTree?: Array<[string, boolean | null]> };

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
        const page = runCallsPage(store, job.runId, { from: job.from, limit: job.limit }, job.read, job.whole ? { whole: true } : {});
        if (!page) return noRun(store, job.runId);
        return { ...answer(page, { tagged: true }), ...(page.warming ? { then: { kind: 'analyse', runId: page.runId } } : {}) };
      }
      case 'call': {
        const d = callDetail(store, job.runId, job.callNo, job.read, job.whole ? { whole: true } : {});
        if (!d) return failed(404, `no call #${job.callNo} in run ${job.runId}`);
        // Answered from the calls around it: the whole run is analysed beside the server, for the page to ask again.
        return { ...answer(d, { tagged: true }), ...(d.around ? { then: { kind: 'analyse', runId: job.runId } as const } : {}) };
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
      case 'compare-head': {
        for (const id of [job.a, job.b]) {
          if (lookupRun(store, id)) continue;
          const no = noSuchRun(store, id);
          return failed(no.status, no.status === 404 ? 'one of the runs does not exist' : no.message);
        }
        const h = compareHead(store, job.a, job.b);
        return h ? answer(h, { tagged: true }) : failed(404, 'one of the runs does not exist');
      }
      case 'runs-page':
        return runsPage(store, job.options, job.team, whole);
      case 'runs-days': {
        const key = job.options.types?.includes('local') ? teamKey(store, job.team) : null;
        return answer(runsByDay(store, { ...job.options, known: !whole, localRuns: key ? localRunSet(store, key) : null }), { tagged: true });
      }
      case 'recent':
        return answer({ runs: listRuns(store, job.read) }, { tagged: true });
      case 'differences': {
        const run = lookupRun(store, job.runId);
        if (!run) return noRun(store, job.runId);
        return answer({ differences: forkDifferences(store, run.runId, { normalizers: job.normalizers }) }, { tagged: true });
      }
      case 'unrecorded': {
        const run = lookupRun(store, job.runId);
        if (!run) return noRun(store, job.runId);
        return answer({ unrecorded: runUnrecorded(store, run, job.declared) }, { tagged: true });
      }
      case 'groups': {
        const groups = fixAttemptGroups(store, job.fixId);
        return groups ? answer(groups, { tagged: true }) : failed(404, `no fix ${job.fixId.slice(0, 40)}`);
      }
      case 'activity':
        return answer(activity(store, { ...(job.limit !== undefined ? { limit: job.limit } : {}), before: job.before }), { tagged: true });
      case 'show': {
        const out = showRunJson(store, job.runId, { ...job.read, ...(job.tools ? { tools: job.tools } : {}) });
        return out ? answer(out, { tagged: true }) : failed(404, `no run ${job.runId}`);
      }
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
      case 'provenance': {
        const p = provenance(store, job.runId, { ...job.read, maskCount: () => job.mask });
        return p ? answer(p, { tagged: true }) : failed(404, `no run ${job.runId}`);
      }
      case 'injection-run':
        return store.getRun(job.runId) ? answer(runInjection(store, job.runId, job.tools), { tagged: true }) : failed(404, `no run ${job.runId}`);
      case 'tool-trust':
        return answer(toolTrust(store, job.tools), { tagged: true });
      case 'fix': {
        const inTree = job.inTree ? new Map(job.inTree) : null;
        const d = fixDetail(store, job.fixId, { repairer: job.repairer, checkRepairer: repairerProblem, ...(inTree ? { patchInTree: (patch: string) => inTree.get(patch) ?? null } : {}) });
        return d ? answer(d, { tagged: true }) : failed(404, `no fix ${job.fixId.slice(0, 40)}`);
      }
      case 'search': {
        const index = loadRunIndex(store);
        const behind = searchBehind(store, index);
        const found: SearchAnswer = { hits: searchRecorded(store, job.q, job.limit, index), ...(behind ? { indexing: { runs: behind, of: index.runs.length } } : {}) };
        return answer(found);
      }
    }
  } catch (err) {
    // A cursor or a time zone the read model doesn't know: the request's mistake.
    if (err instanceof RangeError) return failed(400, err.message);
    throw err;
  }
}
