import { readStoreFacts, repairerProblem, storeFacts, type Normalizer, type Price, type Store, type StoreOf, type StoreFacts, type Task, type ToolTrust } from '@shadowlap/engine';
import { activity } from './activity.js';
import { callDetail, lineage, listRuns, lookupRun, noSuchRun, provenance, runCallsPage, runDetail, showRunJson, type ReadOptions } from './api.js';
import { fixAttemptGroups } from './attempt-groups.js';
import { codeChangeCache, compareHead, compareView } from './compare.js';
import { fixDetail, goldensFolderIn, patchesToCheck } from './fixes.js';
import { forkDifferences } from './fork-differences.js';
import { runInjection, toolTrust } from './injection.js';
import { runUnrecorded } from './run-unrecorded.js';
import { overviewKnown, overviewSummary } from './overview.js';
import { patchesInTree } from './patch-in-tree.js';
import { answer, failed, readRegistry, type JobOf, type ReadAnswer, type ReadTable } from './read-registry.js';
import { localRunIds } from './routes/store.js';
import type { MaskCount } from './run-mask.js';
import { runCalls } from './run-calls.js';
import { loadRunIndex } from './run-index.js';
import { ESTIMATE_READS } from './estimates.js';
import { withExitCodes } from './exit-codes.js';
import { NEXT_STEP_READS, nextStepRows, pageSteps, type NextStepWork } from './next-step.js';
import { judgedRows, judgeFor, OUTCOME_READS, runJudged, type OutcomeWork } from './run-outcome.js';
import { RUNS_FAILURES_READS } from './runs-failures.js';
import { analyseRun } from './run-page.js';
import { asksFor, asksOf, warmProgress, warmRunStats } from './run-stats.js';
import type { RunsPageRow } from './routes/runs-list.js';
import { fixedByOf } from './runs-filter.js';
import { listRunsPage, ROW_CALLS_BUDGET, rowsWarming, runsByDay, type RunsByDayOptions, type RunsPageOptions } from './runs-list.js';
import { searchBehind, searchRecorded, type SearchAnswer } from './search-hits.js';
import { setupUnderWay } from './store-setup.js';
import { localRunSet, teamStoreStatus, type TeamStoreInput } from './team-store.js';
import type { GoldenSource } from './tests.js';
import { toolReads } from './tool-reads.js';
import { readTraining, sourceFixes, trainingView, type PairFilter } from './training.js';

export type { ReadAnswer } from './read-registry.js';

/**
 * The read models that read every call of a run, or of every run: the Overview, a run's page and
 * its calls, a call's details, a run's family, Compare, what a fork did differently, a fix's
 * attempts grouped, the activity feed, a run as JSON, the run list (its filter and its sort by spent
 * among them), the calendar and the sidebar's runs, a search of what runs recorded, what Settings →
 * Tools reads of every tool call, what projects' stores say for the switcher and the setup,
 * Training's pairs, and the warm-up that works run totals out ahead. Each is a job: plain data in,
 * the answer out as JSON text, so it runs as well on a worker thread of its own (read-worker.ts, for
 * a store with a file) as here (a store in memory). What the server needs to answer it (who asks,
 * the project's config) is read before, on its own thread.
 *
 * Each kind of job is answered by its handler in a table (read-registry.ts): the ones above from this
 * module's, and a feature's own from the table its module registers, listed in `READ_TABLES`.
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
  /** What a run's next step reads of the project, as Needs a look's lines say it. */
  next?: NextStepWork | null;
  /** The repairer the config names, which Run repair's card on Needs a look names. */
  repairer?: string | null;
}

/**
 * The most calls the Overview's request reads to work out what isn't known yet (`overviewKnown`,
 * `OverviewOptions.budget`): a short run that just ended is added up in it, a long one by the warm-up.
 */
export const SUMMARY_CALLS_BUDGET = 5000;

/** The jobs this module's table answers. */
type CoreJob =
  | { kind: 'summary'; work: SummaryWork }
  /**
   * `outcome`: what the run is judged by besides its own checks (run-outcome.ts); `next`, what its
   * next step reads (next-step.ts): each as the server read the project.
   */
  | { kind: 'run'; runId: string; read: ReadOptions; after?: number; outcome?: OutcomeWork | null; next?: NextStepWork | null }
  /** A page of a run's calls; `whole` waits for the whole run's analysis rather than answer from a part of the run. */
  | { kind: 'calls'; runId: string; read: ReadOptions; from: number; limit: number; whole?: boolean }
  | { kind: 'call'; runId: string; read: ReadOptions; callNo: number; whole?: boolean }
  | { kind: 'lineage'; runId: string; read: ReadOptions }
  | { kind: 'compare'; a: string; b: string; cwd: string | null }
  /** What Compare shows first while the whole comparison is worked out: the identical prefix and the first request that differs (compare.ts `compareHead`). */
  | { kind: 'compare-head'; a: string; b: string }
  | { kind: 'runs-page'; options: Omit<RunsPageOptions, 'localRuns' | 'judge'>; team: TeamStoreInput | null; outcome?: OutcomeWork | null; next?: NextStepWork | null }
  | { kind: 'runs-days'; options: Omit<RunsByDayOptions, 'localRuns' | 'judge'>; team: TeamStoreInput | null; outcome?: OutcomeWork | null }
  | { kind: 'recent'; read: ReadOptions; outcome?: OutcomeWork | null; next?: NextStepWork | null }
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
  /** The whole analysis of a long run whose first page was answered from its first calls, and its outcome by checks with it. */
  | { kind: 'analyse'; runId: string; outcome?: OutcomeWork | null }
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
  /** What Settings → Tools reads of the store, every tool call by its name and effect and the MCP servers calls came through (tool-reads.ts). */
  | { kind: 'tool-reads' }
  /**
   * What projects' stores say, for the project switcher and a project's setup (engine `storeFacts`,
   * which reads every run), by project id: the store this job reads for the one with no `dbPath`, the
   * others read-only from their files. `keep`: the setup's recording, listed however old.
   */
  | { kind: 'store-facts'; stores: Array<{ id: string; dbPath: string | null; keep: string | null }> }
  /** The Training screen (training.ts `trainingView`): the pairs every run makes, with the project's goldens as tasks and its normalizers, read on the server's thread. */
  | { kind: 'training'; tasks: Task[]; tasksError: string | null; normalizers: Normalizer[]; redactRules: number | null; filter: PairFilter }
  /**
   * A fix with its three steps (fixes.ts `fixDetail`), its blamed run's calls among them: the repairer
   * the config names, whether each patch the fix could apply is in the working tree, as git said on
   * the server's thread, and why `fix apply` refuses a pulled repair's patch there, by the repair.
   */
  | { kind: 'fix'; fixId: string; repairer: string | null; inTree?: Array<[string, boolean | null]>; refusedHere?: Array<[string, string | null]>; project?: string };

/** A run id that names no single run: several runs (409), or none (404). */
function noRun(store: StoreOf<'readModels'>, id: string): ReadAnswer {
  const no = noSuchRun(store, id);
  return failed(no.status, no.message);
}

/** Of the two runs a comparison reads, the answer for the first that isn't one run; null when both are. */
function eitherMissing(store: Store, a: string, b: string): ReadAnswer | null {
  for (const id of [a, b]) {
    if (lookupRun(store, id)) continue;
    const no = noSuchRun(store, id);
    return failed(no.status, no.status === 404 ? 'one of the runs does not exist' : no.message);
  }
  return null;
}

/** For a long run answered from a part of its calls: its whole analysis (and its outcome by checks), beside the server once this is answered, for the page to ask again. */
const analyseAfter = (runId: string, outcome?: OutcomeWork | null): Pick<ReadAnswer, 'then'> => ({ then: { kind: 'analyse', runId, ...(outcome ? { outcome } : {}) } });

/** For a run whose verdict a list's `status:` waits for and whose calls are more than a read judges: judged beside the server once this is answered, kept on this thread for the page's next ask. */
const judgeAfter = (runId: string | undefined, outcome: OutcomeWork | null): Pick<ReadAnswer, 'then'> => (runId ? { then: { kind: 'outcome', runId, work: outcome } } : {});

/** What git said about the code between two revisions, kept for a minute per pair: one per thread. */
const code = codeChangeCache();

/** The team store's key, for the runs only on this machine (the Local chip, the `local` tag); null without one. */
function teamKey(store: StoreOf<'recording' | 'readModels' | 'team'>, team: TeamStoreInput | null): string | null {
  return team ? (teamStoreStatus(store, team)?.key ?? null) : null;
}

async function summary(store: Store, w: SummaryWork, whole: boolean): Promise<ReadAnswer> {
  const when = { ...(w.tz ? { tz: w.tz } : {}), ...(w.now !== undefined ? { now: w.now } : {}) };
  // Not worked out yet: say how far it is, at once, and the warm-up works out the rest (the route has
  // it go through the runs again). Never a pass over a long run's calls here, the warm-up's done or
  // not: once it was, the Overview after a run of 100,000 calls was opened took 31 to 63 s, working
  // out that run's prompt cache, which another thread had kept with its totals.
  const budget = whole ? {} : { budget: SUMMARY_CALLS_BUDGET };
  if (!whole) {
    const known = overviewKnown(store, { ...when, ...budget });
    if (known.done < known.total) return answer({ warming: known });
  }
  const status = w.team ? teamStoreStatus(store, w.team) : null;
  // A setup of the store left unfinished leads back to its page.
  const setup = status && w.team && w.project ? setupUnderWay(store, w.team) : null;
  const patchInTree = w.project ? await patchesInTree(w.project, patchesToCheck(store)) : null;
  // It names the time it was worked out at, so it is never the same twice: no ETag.
  return answer(overviewSummary(store, { ...when, ...budget, ...(w.prices ? { prices: w.prices } : {}), goldens: w.goldens, teamStore: status ? { name: status.name, onlyLocal: status.onlyLocal, setup } : null, ...(patchInTree ? { patchInTree } : {}), ...(w.next ? { next: w.next } : {}), ...(w.repairer ? { repairer: w.repairer } : {}) }));
}

function runsPage(store: Store, options: Omit<RunsPageOptions, 'localRuns' | 'judge'>, team: TeamStoreInput | null, whole: boolean, outcome: OutcomeWork | null, next: NextStepWork | null): ReadAnswer {
  const key = teamKey(store, team);
  // `status:` judges the runs it reaches by the same work as the rows.
  const { judgeAfter: later, ...page } = listRunsPage(store, { ...options, known: !whole, localRuns: key ? localRunSet(store, key) : null, judge: judgeFor(store, outcome) });
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
  // Each row's outcome by checks, those that read calls within the rows' budget, each check with it for Status's hover, a test replay's exit code (run-outcome.ts), and its next step (next-step.ts).
  return { ...answer({ ...page, runs: nextStepRows(store, withExitCodes(store, judgedRows(store, runs, outcome, whole ? Infinity : ROW_CALLS_BUDGET, { checks: true })), next) }, { tagged: true }), ...judgeAfter(later, outcome) };
}

/**
 * A fix's page, with what the server's thread found in the working tree: patches in it already, and
 * pulled ones `fix apply` refuses there. The names the project's goldens folder holds, which the
 * goldens Apply fix copies can't take, are read here, beside the server.
 */
function fixPage(store: Store, job: Extract<CoreJob, { kind: 'fix' }>): ReadAnswer {
  const inTree = job.inTree ? new Map(job.inTree) : null;
  const here = job.refusedHere ? new Map(job.refusedHere) : null;
  const d = fixDetail(store, job.fixId, { repairer: job.repairer, checkRepairer: repairerProblem, ...(inTree ? { patchInTree: (patch: string) => inTree.get(patch) ?? null } : {}), ...(here ? { rewriteHere: (repairId: string) => here.get(repairId) ?? null } : {}), ...(job.project ? { goldensFolder: goldensFolderIn(job.project) } : {}) });
  return d ? answer(d, { tagged: true }) : failed(404, `no fix ${job.fixId.slice(0, 40)}`);
}

/**
 * A long run's whole analysis, and what its user asked first, from the conversations the analysis
 * placed its calls in: kept for its about line. Its outcome by checks with it, kept on this thread,
 * which answers the run's page when it asks again.
 */
function analyse(store: Store, runId: string, outcome: OutcomeWork | null): ReadAnswer {
  const run = lookupRun(store, runId);
  if (run) {
    const calls = runCalls(store, run.runId);
    const analysis = analyseRun(store, run, calls);
    const index = loadRunIndex(store);
    const r = index.byId.get(run.runId);
    if (r && asksFor(r)) asksOf(store, index, [r], { analysed: { runId: run.runId, calls, conversations: analysis.conversations } });
    runJudged(store, index, run.runId, outcome, { calls: () => [...calls], checks: true });
  }
  return answer(null);
}

/** What each project's store says (`store-facts`), by project id: one that can't be read is left out. */
function storeFactsOf(store: Store, stores: Extract<CoreJob, { kind: 'store-facts' }>['stores']): ReadAnswer {
  const facts: Record<string, StoreFacts> = {};
  for (const s of stores) {
    try {
      facts[s.id] = s.dbPath === null ? storeFacts(store, Date.now(), { keep: s.keep }) : readStoreFacts(s.dbPath, Date.now(), { keep: s.keep });
    } catch {
      // left out: the server's thread reads it again, and says why it can't
    }
  }
  return answer(facts);
}

/** This module's reads, by kind. */
const CORE_READS: ReadTable<CoreJob> = {
  summary: (store, job, { whole }) => summary(store, job.work, whole),
  run: async (store, job) => {
    const d = runDetail(store, job.runId, job.read, job.after === undefined ? {} : { after: job.after });
    if (!d) return noRun(store, job.runId);
    const runId = d.run.runId;
    // Its outcome by checks, each check with it; for a long run answered from its first calls, only
    // what needs no call read or this thread judged before, and the rest with its analysis.
    const outcome = job.outcome ?? null;
    const judged = runJudged(store, loadRunIndex(store), runId, outcome, { calls: () => [...runCalls(store, runId)], checks: true, quick: !!d.warming });
    // Its next step, what it bills with it where that reads no other long run and no calls this answer
    // left out, and what its Replay replays (next-step.ts).
    const steps = await pageSteps(store, runId, job.next ?? null, { judged, kept: (id) => id === runId && !d.warming });
    // The route tags it by where the run stands (run-version.ts); a long run answered from its
    // first calls is analysed whole beside the server, for the page to ask again.
    // A failed test replay its golden's next replay passed: the run that passed, as the lists name it.
    const fixedBy = fixedByOf(store, loadRunIndex(store)).get(runId);
    return { ...answer({ ...d, ...(judged === undefined ? {} : { judged }), ...(fixedBy ? { fixedBy } : {}), ...steps }), ...(d.warming ? analyseAfter(runId, outcome) : {}) };
  },
  calls: (store, job) => {
    const page = runCallsPage(store, job.runId, { from: job.from, limit: job.limit }, job.read, job.whole ? { whole: true } : {});
    if (!page) return noRun(store, job.runId);
    return { ...answer(page, { tagged: true }), ...(page.warming ? analyseAfter(page.runId) : {}) };
  },
  call: (store, job) => {
    const d = callDetail(store, job.runId, job.callNo, job.read, job.whole ? { whole: true } : {});
    if (!d) return failed(404, `no call #${job.callNo} in run ${job.runId}`);
    // Answered from the calls around it: the whole run is analysed beside the server, for the page to ask again.
    return { ...answer(d, { tagged: true }), ...(d.around ? analyseAfter(job.runId) : {}) };
  },
  lineage: (store, job) => {
    const nodes = lineage(store, job.runId, job.read);
    return nodes ? answer({ nodes }, { tagged: true }) : failed(404, `no run ${job.runId}`);
  },
  compare: async (store, job) => {
    const missing = eitherMissing(store, job.a, job.b);
    if (missing) return missing;
    const c = await compareView(store, job.a, job.b, { cwd: job.cwd, code });
    return c ? answer(c, { tagged: true }) : failed(404, 'one of the runs does not exist');
  },
  // Null when the head can't be told without reading too many requests: the whole comparison says.
  'compare-head': (store, job) => eitherMissing(store, job.a, job.b) ?? answer(compareHead(store, job.a, job.b), { tagged: true }),
  'runs-page': (store, job, { whole }) => runsPage(store, job.options, job.team, whole, job.outcome ?? null, job.next ?? null),
  'runs-days': (store, job, { whole }) => {
    const key = job.options.types?.includes('local') ? teamKey(store, job.team) : null;
    const { judgeAfter: later, ...days } = runsByDay(store, { ...job.options, known: !whole, localRuns: key ? localRunSet(store, key) : null, judge: judgeFor(store, job.outcome ?? null) });
    return { ...answer(days, { tagged: true }), ...judgeAfter(later, job.outcome ?? null) };
  },
  recent: (store, job, { whole }) => {
    // The rows' totals as far as they are known: the sidebar asks again while some are warming.
    const runs = nextStepRows(store, withExitCodes(store, judgedRows(store, listRuns(store, { ...job.read, known: !whole }), job.outcome ?? null, whole ? Infinity : ROW_CALLS_BUDGET)), job.next ?? null);
    const warming = rowsWarming(runs);
    return answer({ runs, ...(warming ? { warming } : {}) }, { tagged: true });
  },
  differences: (store, job) => {
    const run = lookupRun(store, job.runId);
    return run ? answer({ differences: forkDifferences(store, run.runId, { normalizers: job.normalizers }) }, { tagged: true }) : noRun(store, job.runId);
  },
  unrecorded: (store, job) => {
    const run = lookupRun(store, job.runId);
    return run ? answer({ unrecorded: runUnrecorded(store, run, job.declared) }, { tagged: true }) : noRun(store, job.runId);
  },
  groups: (store, job) => {
    const groups = fixAttemptGroups(store, job.fixId);
    return groups ? answer(groups, { tagged: true }) : failed(404, `no fix ${job.fixId.slice(0, 40)}`);
  },
  activity: (store, job) => answer(activity(store, { ...(job.limit !== undefined ? { limit: job.limit } : {}), before: job.before }), { tagged: true }),
  show: (store, job) => {
    const out = showRunJson(store, job.runId, { ...job.read, ...(job.tools ? { tools: job.tools } : {}) });
    return out ? answer(out, { tagged: true }) : failed(404, `no run ${job.runId}`);
  },
  analyse: (store, job) => analyse(store, job.runId, job.outcome ?? null),
  warm: (store, job) => {
    const done = warmRunStats(store, { budgetMs: job.budgetMs });
    const at = warmProgress(store);
    return { ...answer(null), warm: { done, walked: at?.walked ?? 0, total: at?.total ?? 0 } };
  },
  provenance: (store, job) => {
    const p = provenance(store, job.runId, { ...job.read, maskCount: () => job.mask });
    return p ? answer(p, { tagged: true }) : failed(404, `no run ${job.runId}`);
  },
  'injection-run': (store, job) => (store.getRun(job.runId) ? answer(runInjection(store, job.runId, job.tools), { tagged: true }) : failed(404, `no run ${job.runId}`)),
  'tool-trust': (store, job) => answer(toolTrust(store, job.tools), { tagged: true }),
  'tool-reads': (store) => answer(toolReads(store)),
  'store-facts': (store, job) => storeFactsOf(store, job.stores),
  training: (store, job) => answer(trainingView(readTraining(store, { tasks: job.tasks, tasksError: job.tasksError, redactRules: job.redactRules, fixOf: sourceFixes(store), normalizers: job.normalizers }), { filter: job.filter }), { tagged: true }),
  fix: (store, job) => fixPage(store, job),
  search: (store, job) => {
    const index = loadRunIndex(store);
    const behind = searchBehind(store, index);
    const found: SearchAnswer = { hits: searchRecorded(store, job.q, job.limit, index), ...(behind ? { indexing: { runs: behind, of: index.runs.length } } : {}) };
    return answer(found);
  },
};

/**
 * Every pooled read's table: this module's, then each feature's, from its own module (read-registry.ts
 * says how one is written). A feature's table is one line here, and a kind two of them register stops
 * the dashboard as it loads.
 */
const READ_TABLES = [CORE_READS, OUTCOME_READS, NEXT_STEP_READS, RUNS_FAILURES_READS, ESTIMATE_READS] as const;

/** A job a read-model thread answers: of a kind a table registers, as that table's handler takes it. */
export type ReadJob = JobOf<(typeof READ_TABLES)[number]>;

const READS = readRegistry(READ_TABLES);

/** The kinds of job the tables answer, sorted. */
export function readKinds(): string[] {
  return [...READS.keys()].sort();
}

/**
 * Works out one job against `store`, by the handler its kind is registered with. Never throws for
 * what the job asks: a bad request or a missing run is its answer. `whole` works out what isn't
 * known yet rather than answer with how far the warm-up has got: for a store in memory, whose read
 * models run on the server's own thread anyway.
 */
export async function runJob(store: Store, job: ReadJob, o: { whole?: boolean } = {}): Promise<ReadAnswer> {
  const handler = READS.get(job.kind);
  // A kind no table here registers: a thread built before it was, given a job by a newer server.
  if (!handler) throw new Error(`no read model answers a job of kind "${job.kind}": is the dashboard built?`);
  try {
    return await handler(store, job, { whole: o.whole === true });
  } catch (err) {
    // A cursor or a time zone the read model doesn't know: the request's mistake.
    if (err instanceof RangeError) return failed(400, err.message);
    throw err;
  }
}
