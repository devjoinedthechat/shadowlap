import type { RunComparison } from '../../engine/src/compare.js';
import type { SearchHit } from '../../engine/src/search.js';
import type { RunNote } from '../../engine/src/types.js';
import { bundleSource } from './fixes/model.js';
import { ciQuery } from './goldens.js';
import { normalizeCallDetail, normalizeMeta, normalizeRunDetail, normalizeRuns } from './normalize.js';
import { noteParent } from './parents.js';
import { noProjects, noteRefusal, projectHeader, projectsApi, showProject, type ProjectsApi } from './projects-api.js';
import { readTokenLink } from './route.js';
import { holdWhile, Revalidation } from './revalidate.js';
import { noSettings, settingsApi, type SettingsApi } from './settings-api.js';
import { noStoreSetup, storeSetupApi, type StoreSetupApi } from './store-api.js';
import type { CallDetail, Changes, CiWorkflowOptions, CiWorkflowsView, FixBundle, FixDetail, FixList, JobFile, JobListItem, JobView, LineageNode, Meta, ModelsView, ProvenanceView, RunDetail, RunListItem, RunOffers, StaticPayload, TestRunView, TestsView, TrainingView } from './types.js';
import type { ActivityPage, DaysBisect, DeleteResult, ImportSources, LabelRunsResult, OverviewSummary, RunsByDay, SearchAnswer, RunsPage, RunsPageRow, RunsQuery, TeamStoreStatus, TeamStoreView, UploadView } from './types.js';
import type { DecisionSessionDetail, DecisionsListView, RetirementsView, RunDecisionsView } from './types.js';
import type { ChaosMatrix, ChaosView, CoverageView } from './types.js';
import type { ForkDifferences } from '../src/fork-differences.js';
import { copyAmbiguous, copyRunId } from './runs.js';
import { runsQueryString } from './runspage/query.js';

/**
 * The dashboard's API client, the one module that talks to the server. Its types are in `types.ts`:
 * the server's, widened with the fields other parts of the API add. Every answer is put in the shape
 * the views read (`normalize.ts`) as it arrives.
 */

export type { Block, Delta } from '../../engine/src/deltas.js';
export type { Turn, TurnBlock } from '../../engine/src/conversation.js';
export type { RunChanges } from '../../engine/src/changes.js';
export type { RunComparison, SearchHit, RunNote };
export type * from './types.js';

/**
 * The job kinds the UI starts through `POST /api/jobs`, by what they do. A button or palette entry
 * for one shows only when the server lists the kind in `meta.jobKinds`.
 */
export const JOB_KINDS = {
  exportHtml: 'export-html',
  pack: 'pack',
  dataset: 'export-dataset',
  otel: 'export-otel',
  har: 'export-har',
  blame: 'blame',
  repair: 'repair',
  applyFix: 'apply',
  // A fix's verdict left incomplete: Run more attempts, or Verify again.
  verify: 'verify',
  tests: 'test',
  importCapture: 'import',
  calibrate: 'calibrate',
  gc: 'gc',
  // The team store (overview-runs): push and pull (Runs, and Settings → Store), and a run's share link.
  push: 'push',
  pull: 'pull',
  share: 'share',
  // The team store's setup (Settings → Store): check access to a bucket and connect it (store set --check).
  storeSet: 'store-set',
  // Tests: update goldens, find the commit (on Tests, the Runs calendar and a run's page), add a
  // normalizer and re-run (and `tests` above runs them).
  testUpdate: 'test-update',
  bisect: 'bisect',
  normalizeAndTest: 'normalize-and-test',
  // A project's setup (the projects slice registers these): inspect the folder, record a first run,
  // keep it as a golden (pack, then test).
  inspect: 'init',
  record: 'record',
  keepGolden: 'pack-test',
  // Training: export preference pairs, score a model on the tasks, and update the golden of a task
  // whose test forks before its takeover.
  pairs: 'pairs',
  score: 'score',
  taskUpdate: 'task-update',
  // Checks: a check tried on the recordings, nothing replayed (the check builder's preview); its result is a CheckReportView.
  check: 'check',
  // The decision diff (Changes): ask the recorded model calls again under a change, migrate to a
  // model, and verify the runs a session flagged.
  decisions: 'decisions',
  migrate: 'migrate',
  decisionsVerify: 'decisions-verify',
  // Injection tests: plant payloads in a run's or a golden's untrusted reads, or ask whether a read caused its writes.
  injection: 'injection',
  // Error-path presets on a golden or a run, and production coverage: scan again, pack goldens.
  chaos: 'chaos',
  coverage: 'coverage',
  coveragePack: 'coverage-pack',
  // A fork from a call's result as the inspector edited it: the fork menu's --override, the result uploaded.
  override: 'override',
} as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------- token

const TOKEN_KEY = 'shadowlap-dashboard-token';
let inUse: string | null = null;

/**
 * The session token arrives in the URL fragment once, from the link `shadowlap dashboard` prints. It
 * is kept for this tab only and taken out of the address bar; `&open=` names the view to land on.
 */
export function takeToken(): string | null {
  const link = readTokenLink(location.hash);
  if (link) {
    try {
      sessionStorage.setItem(TOKEN_KEY, link.token);
    } catch {
      // storage unavailable: the token lives in memory for this page
    }
    history.replaceState(null, '', `${location.pathname}${location.search}${link.open}`);
    inUse = link.token;
    return inUse;
  }
  try {
    inUse = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    inUse = null;
  }
  return inUse;
}

/** The session token this page started with; null for an exported copy, or a link that had none. */
export function tokenInUse(): string | null {
  return inUse;
}

// ---------------------------------------------------------------------------------------------- client

export interface Client {
  /** An exported copy: answers come from the file, nothing changes. */
  exported: boolean;
  meta(): Promise<Meta>;
  runs(): Promise<RunListItem[]>;
  /** A run's page; `after`, for a recording the page follows: only the calls numbered after it (`RunDetail.after`). */
  run(id: string, after?: number): Promise<RunDetail>;
  call(id: string, n: number): Promise<CallDetail>;
  lineage(id: string): Promise<LineageNode[]>;
  /** The run's record for Provenance, or null when the server does not work it out. */
  provenance(id: string): Promise<ProvenanceView | null>;
  /** What the run page offers for a run (Share's counts, Push, Run blame, Find the commit), or null when the server does not say. */
  offers(id: string): Promise<RunOffers | null>;
  /** `shadowlap show <run> --json` as the CLI prints it, or null when the server does not serve it. */
  showJson(id: string): Promise<unknown>;
  compare(a: string, b: string): Promise<RunComparison>;
  /**
   * What runs recorded: hits from runs of their own first, each naming the run an attempt belongs to,
   * and while the server's index is behind, how many runs it has yet to cover (`indexing`).
   */
  search(q: string): Promise<SearchAnswer>;
  labels(id: string, add: string[], remove?: string[]): Promise<{ labels: string[] }>;
  note(id: string, callNo: number | null, text: string): Promise<{ notes: RunNote[] }>;
  /** Runs one of the run's actions (`/api/runs/:id/actions`): the server builds the command line. */
  action(id: string, key: string, callNo: number | null, value?: string): Promise<JobView>;
  /** Starts a job of a registered kind (`POST /api/jobs`). */
  startJob(kind: string, fields: Record<string, unknown>): Promise<JobView>;
  job(jobId: string, after: number): Promise<JobView>;
  /** Asks a running job to stop (`POST /api/jobs/:id/stop`): false when it had ended already. */
  stopJob(jobId: string): Promise<{ stopped: boolean }>;
  /** The jobs the server remembers, newest first, running ones included, without their output. */
  jobs(): Promise<JobListItem[]>;
  /** Deletes a run, with the attempts bundled under it (`attempts`, their ids), as `shadowlap rm` does. */
  remove(id: string): Promise<{ deleted: string; attempts?: string[] }>;
  /** Saves a run, with the runs it came from, as one HTML file. */
  exportHtml(id: string): Promise<{ filename: string; redacted: boolean }>;
  /** Saves a file a job wrote. */
  downloadFile(file: JobFile): Promise<void>;
  /** What changed since `since`, or null when the server has no `/api/changes` and the UI polls instead. */
  changes(since: string | null): Promise<Changes | null>;

  // ---- overview-runs: the Overview, the Runs page, imports and the team store
  /** The Overview, worked out on the server in the viewer's time zone (IANA). */
  summary(tz: string): Promise<OverviewSummary>;
  /** A page of the Runs table: chips, filter, days and sort applied on the server, attempts bundled. */
  runsPage(q: RunsQuery): Promise<RunsPage & { runs: RunsPageRow[] }>;
  /** Runs per day for the calendar, in the viewer's days. */
  runsByDay(q: { tz: string; weeks?: number; types?: readonly string[]; q?: string }): Promise<RunsByDay>;
  /** Find the commit for the failures on the days picked: the first failure there, and what bisect can start from. */
  daysBisect(q: RunsQuery & { from: number; to: number }): Promise<DaysBisect>;
  /** Labels several runs at once, by their full ids. */
  labelRuns(ids: readonly string[], add: readonly string[], remove?: readonly string[]): Promise<LabelRunsResult>;
  /** Deletes several runs at once, by their full ids; runs that can't go now are skipped with why. */
  deleteRuns(ids: readonly string[]): Promise<DeleteResult>;
  /** Which of these runs are still in the store, for a selection to let go of runs deleted elsewhere. */
  knownRuns(ids: readonly string[]): Promise<string[]>;
  /** The team store the project's config names and who this machine records as, or null without one (or on a server without the route). */
  teamStore(): Promise<TeamStoreView | null>;
  /** Whether the trace stores' keys are set on this machine, and where each is reached; null on a server without the route. */
  importSources(): Promise<ImportSources | null>;
  /** Sends a file for a job to use (`POST /api/uploads`). */
  upload(file: Blob, name: string): Promise<UploadView>;
  /** The newest entries of the activity feed. */
  activity(limit: number): Promise<ActivityPage>;

  // ---- Fixes (`/api/fixes`)
  /** Every fix, newest first, with the counts the filter chips show. */
  fixes(): Promise<FixList>;
  /** One fix, by its id or a unique prefix, with its three steps. */
  fix(id: string): Promise<FixDetail>;
  renameFix(id: string, title: string): Promise<FixDetail>;
  /** The attempts blame and verify made in a run's family, for the Forks view; null when the server does not bundle them. */
  fixBundles(runId: string): Promise<FixBundle[] | null>;

  // ---- Tests
  /** The goldens on disk and how each did (`/api/tests`). */
  tests(): Promise<TestsView>;
  /**
   * A run's test banner (a replay `shadowlap test` made that diverged) and Find the commit's choices
   * (`/api/tests/runs/:id`); `before` limits the good commits to runs before it, as the calendar's days do.
   */
  testRun(id: string, before?: number): Promise<TestRunView>;
  /** Settings → CI's two panels for the options given; those left out take the server's defaults (`/api/ci/workflows`). */
  ciWorkflows(options?: Partial<CiWorkflowOptions>): Promise<CiWorkflowsView>;

  // ---- Settings
  /** Settings: each tab's read and the edits to shadowlap.config.json (`settings-api.ts`). */
  settings: SettingsApi;
  /** The team store's setup page (`#/setup/store`, `store-api.ts`). */
  storeSetup: StoreSetupApi;

  // ---- Projects
  /** Projects: the switcher, Add a project, removing one, and the setup (`projects-api.ts`). */
  projects: ProjectsApi;

  // ---- Training
  /** Training (`/api/training`): the strip, the pairs, the tasks and the scores. */
  training(): Promise<TrainingView>;
  /** The models Score a model offers, each priced (`/api/models`). It asks providers, so it can take a second. */
  models(): Promise<ModelsView>;

  // ---- The decision diff (`/api/decisions`)
  /** The decisions and migrate sessions kept, newest first, and the goldens' models that retire. */
  decisionSessions(kind?: 'decisions' | 'migrate'): Promise<DecisionsListView>;
  /** One session whole, by its id (`dc-…`, `mg-…`): its report and its matrix. */
  decisionSession(id: string): Promise<DecisionSessionDetail>;
  /** A run's decisions under each session that asked its model calls again, for its Decisions view. */
  runDecisions(runId: string): Promise<RunDecisionsView>;
  /** The models the goldens use that retire, by the table that ships with Shadowlap. */
  retirements(): Promise<RetirementsView>;
  // ---- Error-path presets and production coverage
  /** The last coverage scan: what imported runs did, and which behaviours no golden covers (`/api/coverage`); null on a server without it. */
  coverage(): Promise<CoverageView | null>;
  /** Every recording's error-path presets, and the newest sessions (`/api/chaos`); null on a server without it. */
  chaos(): Promise<ChaosView | null>;
  /** One run's presets matrix, its recording's for a preset's attempt (`/api/chaos/runs/:id`); null when none ran. */
  runChaos(id: string): Promise<ChaosMatrix | null>;

  // ---- What a fork did differently
  /** What a fork did differently from its parent (`/api/runs/:id/differences`); null for a run that isn't a fork of a run in the store. */
  forkDifferences(id: string): Promise<ForkDifferences | null>;
}


/** The answers kept for revalidation, bounded (revalidate.ts). */
const etags = new Revalidation();

/**
 * Each answer in the shape the views read (`normalize.ts`), worked out once per answer: an unchanged
 * answer (a 304 hands back the same object) comes back as the same object, so nothing redraws. What
 * the views read keeps the answer it came from, so a large one stays revalidated while it is shown.
 */
const shaped = new WeakMap<object, unknown>();
function shape<T extends object, U>(raw: T, fn: (raw: T) => U): U {
  if (shaped.has(raw)) return shaped.get(raw) as U;
  const out = fn(raw);
  shaped.set(raw, out);
  holdWhile(out, raw);
  return out;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createClient(token: string): Client {
  let hasChanges: boolean | null = null;
  let hasProvenance: boolean | null = null;
  let hasStore: boolean | null = null;
  // The store's answer as the screens take it, kept while the server's answer is the same one (a 304).
  let storeView: { from: unknown; view: TeamStoreView | null } | null = null;
  let storeLoading: Promise<TeamStoreView | null> | null = null;
  async function loadStore(): Promise<TeamStoreView | null> {
    if (hasStore === false) return null;
    try {
      const out = await request<{ store: TeamStoreStatus | null; you?: string | null }>('store');
      hasStore = true;
      if (storeView?.from !== out) storeView = { from: out, view: out.store ? { ...out.store, you: out.you ?? null } : null };
      return storeView.view;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 405) && hasStore === null) {
        hasStore = false;
        return null;
      }
      throw err;
    }
  }
  let hasOffers: boolean | null = null;
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const cached = method === 'GET' ? etags.get(path) : undefined;
    const res = await fetch(`/api/${path}`, {
      ...init,
      // The project the page shows: a change asked for while another is current is refused (projects-api.ts).
      // A read of something the store doesn't hold is answered as one (`notFound`, below), not as a
      // failed load the browser would log: the page says what is missing itself.
      headers: { 'x-shadowlap-token': token, ...projectHeader(), ...(method === 'GET' ? { 'x-shadowlap-not-found': 'answer' } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(cached ? { 'if-none-match': cached.etag } : {}) },
    });
    // A 304 has no body, but it is read all the same: one left unread is cancelled once the page
    // drops it, and shows as (canceled) among the page's requests.
    const text = await res.text();
    if (res.status === 304 && cached) return cached.body as T;
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: text };
    }
    if (!res.ok) {
      noteRefusal(res.status, body);
      throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
    }
    // Something the read named that the store doesn't hold, answered as the page asked: the 404 it is.
    const missing = method === 'GET' ? (body as { notFound?: unknown; error?: unknown } | null) : null;
    if (missing?.notFound === true) throw new ApiError(404, typeof missing.error === 'string' ? missing.error : 'not found');
    const etag = res.headers.get('etag');
    if (etag && method === 'GET') etags.set(path, etag, body, text.length);
    return body as T;
  }
  const id = encodeURIComponent;
  async function fetchFile(path: string, fallbackName: string): Promise<{ filename: string; res: Response }> {
    const res = await fetch(`/api/${path}`, { headers: { 'x-shadowlap-token': token } });
    if (!res.ok) {
      const text = await res.text();
      let message = text || `HTTP ${res.status}`;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {
        // plain text
      }
      throw new ApiError(res.status, message);
    }
    const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
    return { filename, res };
  }
  return {
    exported: false,
    meta: () =>
      request<Meta>('meta').then((m) => {
        showProject(m.project?.id);
        return shape(m, normalizeMeta);
      }),
    runs: () => request<{ runs: RunListItem[] }>('runs').then((r) => shape(r, (x) => normalizeRuns(x.runs))),
    run: (runId, after) =>
      request<RunDetail>(`runs/${id(runId)}${after === undefined ? '' : `?after=${after}`}`).then((d) => {
        const out = shape(d, normalizeRunDetail);
        // The top bar's crumb names the parent of a run the run list leaves out from here (parents.ts).
        noteParent([runId, out.run.runId], out.run.parentRunId ?? null);
        return out;
      }),
    call: (runId, n) => request<CallDetail>(`runs/${id(runId)}/calls/${n}`).then((d) => shape(d, normalizeCallDetail)),
    lineage: (runId) => request<{ nodes: LineageNode[] }>(`runs/${id(runId)}/lineage`).then((r) => r.nodes),
    provenance: async (runId) => {
      if (hasProvenance === false) return null;
      try {
        const out = await request<ProvenanceView>(`runs/${id(runId)}/provenance`);
        hasProvenance = true;
        return out;
      } catch (err) {
        // A server without the endpoint: Provenance shows what the run itself says.
        if (err instanceof ApiError && (err.status === 404 || err.status === 405) && hasProvenance === null) {
          hasProvenance = false;
          return null;
        }
        throw err;
      }
    },
    offers: async (runId) => {
      if (hasOffers === false) return null;
      try {
        const out = await request<RunOffers>(`runs/${id(runId)}/offers`);
        hasOffers = true;
        return out;
      } catch (err) {
        // A server without the endpoint (not a run it doesn't have): the page offers what the run itself says.
        if (err instanceof ApiError && (err.status === 405 || (err.status === 404 && /^no endpoint/.test(err.message))) && hasOffers === null) {
          hasOffers = false;
          return null;
        }
        throw err;
      }
    },
    showJson: (runId) => request<unknown>(`runs/${id(runId)}/show`),
    compare: (a, b) => request<RunComparison>(`compare?a=${id(a)}&b=${id(b)}`),
    search: (q) => request<SearchAnswer>(`search?q=${id(q)}&limit=40`).then((r) => ({ hits: r.hits ?? [], ...(r.indexing ? { indexing: r.indexing } : {}) })),
    labels: (runId, add, remove = []) => request<{ labels: string[] }>(`runs/${id(runId)}/labels`, { method: 'POST', body: JSON.stringify({ add, remove }) }),
    note: (runId, callNo, text) => request<{ notes: RunNote[] }>(`runs/${id(runId)}/notes`, { method: 'POST', body: JSON.stringify({ callNo, text }) }),
    action: (runId, key, callNo, value) => request<JobView>(`runs/${id(runId)}/actions`, { method: 'POST', body: JSON.stringify({ key, callNo, ...(value !== undefined ? { value } : {}) }) }),
    startJob: (kind, fields) => request<JobView>('jobs', { method: 'POST', body: JSON.stringify({ ...fields, kind }) }),
    job: (jobId, after) => request<JobView>(`jobs/${id(jobId)}?after=${after}`),
    stopJob: (jobId) => request<{ stopped: boolean }>(`jobs/${id(jobId)}/stop`, { method: 'POST', body: '{}' }),
    jobs: async () => (await request<{ jobs: JobListItem[] }>('jobs')).jobs,
    remove: (runId) => request<{ deleted: string; attempts?: string[] }>(`runs/${id(runId)}`, { method: 'DELETE' }),
    // The API authenticates with a header, which a plain link cannot send, and a token in a URL would
    // end up in history and logs: so a file is fetched here and handed to the browser to save.
    exportHtml: async (runId) => {
      const { filename, res } = await fetchFile(`runs/${id(runId)}/export`, `shadowlap-${runId.slice(0, 10).toLowerCase()}.html`);
      saveBlob(await res.blob(), filename);
      return { filename, redacted: res.headers.get('x-shadowlap-redacted') === 'yes' };
    },
    downloadFile: async (file) => {
      const { filename, res } = await fetchFile(`files/${id(file.fileId)}`, file.name);
      saveBlob(await res.blob(), filename);
    },
    summary: (tz) => request<OverviewSummary>(`summary?tz=${id(tz)}`),
    runsPage: (q) => request<RunsPage & { runs: RunsPageRow[] }>(`runs/page${runsQueryString(q)}`),
    runsByDay: (q) => request<RunsByDay>(`runs/days${runsQueryString(q)}`),
    daysBisect: (q) => request<DaysBisect>(`runs/bisect${runsQueryString(q)}`),
    labelRuns: (ids, add, remove = []) => request<LabelRunsResult>('runs/labels', { method: 'POST', body: JSON.stringify({ ids, add, remove }) }),
    deleteRuns: (ids) => request<DeleteResult>('runs/delete', { method: 'POST', body: JSON.stringify({ ids }) }),
    knownRuns: (ids) => request<{ known: string[] }>('runs/known', { method: 'POST', body: JSON.stringify({ ids }) }).then((r) => r.known),
    // The status bar, Runs and the Overview ask at once when runs change: one request answers them all.
    teamStore: () => (storeLoading ??= loadStore().finally(() => (storeLoading = null))),
    importSources: () => request<ImportSources>('imports').catch((err: unknown) => (err instanceof ApiError && err.status === 404 ? null : Promise.reject(err))),
    upload: async (file, name) => {
      const res = await fetch('/api/uploads', { method: 'POST', body: file, headers: { 'x-shadowlap-token': token, ...projectHeader(), 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' } });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { error: text };
      }
      if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      return body as UploadView;
    },
    activity: (limit) => request<ActivityPage>(`activity?limit=${limit}`),
    changes: async (since) => {
      if (hasChanges === false) return null;
      try {
        const out = await request<Changes>(`changes${since ? `?since=${id(since)}` : ''}`);
        hasChanges = true;
        return out;
      } catch (err) {
        // A server without the endpoint: the UI polls the run list instead.
        if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
          hasChanges = false;
          return null;
        }
        throw err;
      }
    },
    fixes: () => request<FixList>('fixes'),
    fix: (fixId) => request<FixDetail>(`fixes/${id(fixId)}`),
    renameFix: (fixId, title) => request<FixDetail>(`fixes/${id(fixId)}/title`, { method: 'PUT', body: JSON.stringify({ title }) }),
    // A server that does not bundle them, or one that never heard of the run: the Forks view lists the attempts as runs.
    fixBundles: bundleSource((runId) => request<{ bundles: FixBundle[] }>(`fixes/family/${id(runId)}`).then((out) => out.bundles)),
    tests: () => request<TestsView>('tests'),
    testRun: (runId, before) => request<TestRunView>(`tests/runs/${id(runId)}${before !== undefined ? `?before=${before}` : ''}`),
    ciWorkflows: (o) => request<CiWorkflowsView>(`ci/workflows${ciQuery(o)}`),
    settings: settingsApi(request),
    storeSetup: storeSetupApi(request),
    projects: projectsApi(request),
    training: () => request<TrainingView>('training'),
    models: () => request<ModelsView>('models'),
    decisionSessions: (kind) => request<DecisionsListView>(`decisions${kind ? `?kind=${kind}` : ''}`),
    decisionSession: (sessionId) => request<DecisionSessionDetail>(`decisions/${id(sessionId)}`),
    runDecisions: (runId) => request<RunDecisionsView>(`runs/${id(runId)}/decisions`),
    retirements: () => request<RetirementsView>('retirements'),
    // A server without the routes answers 404: nothing to show, rather than an error.
    coverage: () => request<CoverageView>('coverage').catch((err) => (err instanceof ApiError && err.status === 404 ? null : Promise.reject(err))),
    chaos: () => request<ChaosView>('chaos').catch((err) => (err instanceof ApiError && err.status === 404 ? null : Promise.reject(err))),
    runChaos: (runId) => request<{ matrix: ChaosMatrix | null }>(`chaos/runs/${id(runId)}`).then((r) => r.matrix, (err) => (err instanceof ApiError && err.status === 404 ? null : Promise.reject(err))),
    forkDifferences: (runId) => request<{ differences: ForkDifferences | null }>(`runs/${id(runId)}/differences`).then((r) => r.differences),
  };
}

// ---------------------------------------------------------------------------------------------- an exported copy

/** The data an exported HTML file carries, when this page is one. */
export function exportedData(): StaticPayload | null {
  const el = document.getElementById('shadowlap-data');
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as StaticPayload;
  } catch {
    return null;
  }
}

/**
 * The same views, answered from the file itself. Anything that would change a run says it cannot. A
 * run is found by a unique prefix of its id too, as the dashboard finds it (`copyRunId`).
 */
export function createExportedClient(data: StaticPayload): Client {
  const full = (runId: string) => encodeURIComponent(copyRunId(data.runIds ?? [], runId));
  const get = <T,>(path: string): Promise<T> => {
    const body = data.responses[path];
    if (body === undefined) return Promise.reject(new ApiError(404, 'this is an exported copy, and that view is not part of it'));
    return Promise.resolve(body as T);
  };
  const readOnly = () => Promise.reject(new ApiError(405, 'this is an exported copy: it cannot be changed from here'));
  return {
    exported: true,
    meta: () => get<Meta>('meta').then((m) => shape(m, normalizeMeta)),
    runs: () => get<{ runs: RunListItem[] }>('runs').then((r) => shape(r, (x) => normalizeRuns(x.runs))),
    // A prefix of several of its runs' ids names none of them, as the server says (409).
    run: (runId) => (copyAmbiguous(data.runIds ?? [], runId) ? Promise.reject(new ApiError(409, `run id prefix ${runId} matches several runs: use more of the id`)) : get<RunDetail>(`runs/${full(runId)}`).then((d) => shape(d, normalizeRunDetail))),
    call: (runId, n) => get<CallDetail>(`runs/${full(runId)}/calls/${n}`).then((d) => shape(d, normalizeCallDetail)),
    lineage: (runId) => get<{ nodes: LineageNode[] }>(`runs/${full(runId)}/lineage`).then((r) => r.nodes),
    provenance: (runId) => Promise.resolve((data.responses[`runs/${full(runId)}/provenance`] as ProvenanceView | undefined) ?? null),
    offers: () => Promise.resolve(null),
    showJson: (runId) => get<unknown>(`runs/${full(runId)}/show`),
    compare: (a, b) => get<RunComparison>(`compare?a=${full(a)}&b=${full(b)}`),
    search: () => Promise.resolve({ hits: [] }),
    labels: readOnly,
    note: readOnly,
    action: readOnly,
    startJob: readOnly,
    job: readOnly,
    stopJob: readOnly,
    jobs: () => Promise.resolve([]),
    remove: readOnly,
    exportHtml: readOnly,
    downloadFile: readOnly,
    changes: () => Promise.resolve(null),
    // An exported copy lists its runs from the file: the Runs page works them out itself.
    summary: () => Promise.reject(new ApiError(404, 'this is an exported copy: it holds runs, not the Overview')),
    runsPage: () => Promise.reject(new ApiError(404, 'this is an exported copy: its runs are listed from the file')),
    runsByDay: () => Promise.reject(new ApiError(404, 'this is an exported copy: its runs are listed from the file')),
    daysBisect: readOnly,
    labelRuns: readOnly,
    deleteRuns: readOnly,
    knownRuns: (ids) => Promise.resolve([...ids]),
    teamStore: () => Promise.resolve(null),
    importSources: () => Promise.resolve(null),
    upload: readOnly,
    activity: () => Promise.resolve({ items: [], next: null }),
    // Fixes are not part of an exported copy.
    fixes: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Fixes are not part of it')),
    fix: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Fixes are not part of it')),
    renameFix: readOnly,
    fixBundles: () => Promise.resolve(null),
    tests: () => get<TestsView>('tests'),
    testRun: () => Promise.resolve({ banner: null, bisect: null }),
    ciWorkflows: () => get<CiWorkflowsView>('ci/workflows'),
    settings: noSettings(readOnly),
    storeSetup: noStoreSetup(readOnly),
    projects: noProjects(readOnly),
    training: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Training is not part of it')),
    models: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Training is not part of it')),
    // The decision diff is not part of an exported copy.
    decisionSessions: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Changes are not part of it')),
    decisionSession: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Changes are not part of it')),
    runDecisions: () => Promise.resolve({ runId: '', sessions: [] }),
    retirements: () => Promise.resolve({ version: '', notices: [] }),
    coverage: () => Promise.resolve(null),
    chaos: () => Promise.resolve(null),
    runChaos: () => Promise.resolve(null),
    // Worked out from the store, which a copy doesn't carry: its run page leaves the panel out.
    forkDifferences: () => Promise.resolve(null),
  };
}
