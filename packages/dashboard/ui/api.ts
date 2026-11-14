import type { RunComparison } from '../../engine/src/compare.js';
import type { CompareHead } from '../src/compare.js';
import type { SearchHit } from '../../engine/src/search.js';
import type { RunNote } from '../../engine/src/types.js';
import { bundleSource } from './fixes/model.js';
import { normalizeCallDetail, normalizeJudged, normalizeMeta, normalizeRunDetail, normalizeRuns } from './normalize.js';
import { noteParent } from './parents.js';
import { noProjects, noteRefusal, projectHeader, projectsApi, showProject, type ProjectsApi } from './projects-api.js';
import { readTokenLink } from './route.js';
import { holdWhile, Revalidation } from './revalidate.js';
import { estimatesApi, noEstimates, type EstimatesApi } from './estimates-api.js';
import { editorApi, type EditorApi } from './editor-api.js';
import { dismissalsApi, noDismissals, type DismissalsApi } from './dismissals-api.js';
import { changesApi, type ChangesApi } from './changes-api.js';
import { testsApi, type TestsApi } from './tests-api.js';
import { noSettings, settingsApi, type Request, type SettingsApi } from './settings-api.js';
import { checksApi, noChecks, type ChecksApi } from './checks-api.js';
import { noStoreSetup, storeSetupApi, type StoreSetupApi } from './store-api.js';
import type { CallDetail, CallsPage, Changes, CiWorkflowsView, FixBundle, FixDetail, FixesView, JobFile, JobListItem, JobView, LineageNode, Meta, ModelsView, ProvenanceView, RunDetail, RunListItem, RunOffers, StaticPayload, TestsView, TrainingView } from './types.js';
import type { ActivityPage, DaysBisect, DeleteResult, ImportSources, IssueRunsPage, IssuesPage, LabelRunsResult, OverviewSummary, OverviewWarming, RunsByDay, SearchAnswer, RunsPage, RunsPageRow, RunsQuery, TeamStoreStatus, TeamStoreView, UploadView } from './types.js';
import type { CompareView, NextStep } from './types.js';
import type { ChaosMatrix, ChaosView, CoverageView, PresetsPicks, PresetsPlan } from './types.js';
import type { InjectionPanelView, InjectionReport, InjectionRow, ReportPreview, RunInjection } from './types.js';
import type { TemplateSet } from '../../engine/src/injection.js';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { PayloadsRead } from '../src/injection.js';
import type { SecurityRead } from '../src/injection-security.js';
import type { FixAttemptGroups } from '../src/attempt-groups.js';
import type { ForkDifferences } from '../src/fork-differences.js';
import type { RequestDiff } from '../src/request-diff.js';
import type { UnrecordedView } from '../src/run-unrecorded.js';
import type { RunJudged } from '../src/run-outcome.js';
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
  // An open fix given another check (Edit check…, Save check).
  fixCheck: 'fix-check',
  // The pull request opened for a fix, recorded on it (Record pull request…).
  fixPr: 'fix-pr',
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
  // Settings → Store's Check again: check the store's access again (store check), writing nothing.
  storeCheck: 'store-check',
  // Tests: update goldens, find the commit (on Tests, the Runs calendar and a run's page), add a
  // normalizer and re-run (and `tests` above runs them), and revert the commit found, then test.
  testUpdate: 'test-update',
  bisect: 'bisect',
  normalizeAndTest: 'normalize-and-test',
  revert: 'revert',
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
  // Checks: `shadowlap check`, a check tried on the recordings, nothing replayed; its result is a CheckReportView.
  // The check builder judges its draft with a pooled read instead (POST /api/checks/preview).
  check: 'check',
  // The decision diff (Changes): ask the recorded model calls again under a change, migrate to a
  // model, and verify the runs a session flagged.
  decisions: 'decisions',
  // What the working tree sends the runs, read offline before Preview changed prompt asks (its result is the CLI's decisions-read).
  decisionsRead: 'decisions-read',
  migrate: 'migrate',
  decisionsVerify: 'decisions-verify',
  // Apply a migration's config change to the working tree, its goldens replayed offline (`shadowlap migrate apply`).
  migrateApply: 'migrate-apply',
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
    /** A question asking a yes to a command line (409): what saying yes to those lines sends back as `yes`. */
    readonly confirm?: string,
    /** The goldens a Tests job's question would run live, and why. */
    readonly live?: unknown,
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

export interface Client extends ChangesApi, TestsApi {
  /** An exported copy: answers come from the file, nothing changes. */
  exported: boolean;
  meta(): Promise<Meta>;
  runs(): Promise<RunListItem[]>;
  /** A run's page; `after`, for a recording the page follows: only the calls numbered after it (`RunDetail.after`). */
  run(id: string, after?: number): Promise<RunDetail>;
  /**
   * A page of the run's calls after the one its page came with: from call `from` on, `limit` at most
   * (500). Deep in a long run being analysed, it comes from the calls around it (`around`); `whole`
   * waits for the analysis.
   */
  calls(id: string, from: number, limit?: number, o?: { whole?: boolean }): Promise<CallsPage>;
  /** A call's details; `whole` as a page of calls takes it. */
  call(id: string, n: number, o?: { whole?: boolean }): Promise<CallDetail>;
  lineage(id: string): Promise<LineageNode[]>;
  /** The run's record for Provenance, or null when the server does not work it out. */
  provenance(id: string): Promise<ProvenanceView | null>;
  /** What the run page offers for a run (Share's counts, Push, Run blame, Find breaking commit), or null when the server does not say. */
  offers(id: string): Promise<RunOffers | null>;
  /** `shadowlap show <run> --json` as the CLI prints it, or null when the server does not serve it. */
  showJson(id: string): Promise<unknown>;
  compare(a: string, b: string): Promise<CompareView>;
  /** What Compare shows while the whole comparison is worked out: the identical prefix and the first request that differs; null where there is none to ask for (an exported copy), or none the server can tell before the whole comparison. */
  compareHead(a: string, b: string): Promise<CompareHead | null>;
  /**
   * What runs recorded: hits from runs of their own first, each naming the run an attempt belongs to,
   * and while the server's index is behind, how many runs it has yet to cover (`indexing`).
   */
  search(q: string): Promise<SearchAnswer>;
  labels(id: string, add: string[], remove?: string[]): Promise<{ labels: string[] }>;
  note(id: string, callNo: number | null, text: string): Promise<{ notes: RunNote[] }>;
  /**
   * Runs one of the run's actions (`/api/runs/:id/actions`): the server builds the command line.
   * `yes`: the command of a run from someone else's pack or the team store was confirmed, in the
   * step that showed it: the `confirm` of the 409 that named it, which ties the yes to that line.
   */
  /** A fork menu row's job; `sent`, what its start sends besides, such as the estimate its card showed. */
  action(id: string, key: string, callNo: number | null, value?: string, yes?: string, sent?: Record<string, unknown>): Promise<JobView>;
  /** Starts a job of a registered kind (`POST /api/jobs`). */
  startJob(kind: string, fields: Record<string, unknown>): Promise<JobView>;
  job(jobId: string, after: number): Promise<JobView>;
  /** Asks a running job to stop (`POST /api/jobs/:id/stop`): false when it had ended already. */
  stopJob(jobId: string): Promise<{ stopped: boolean }>;
  /** The jobs the server remembers, newest first, running ones included, without their output. */
  jobs(): Promise<JobListItem[]>;
  /** Deletes a run, with the attempts bundled under it (`attempts`, their ids), as `shadowlap rm` does. `keepalive`: sent as the page goes, so the browser sees it out (`pending-delete.ts`); with no body, it takes none of keepalive's 64 KiB. */
  remove(id: string, o?: { keepalive?: boolean }): Promise<{ deleted: string; attempts?: string[] }>;
  /** Saves a run, with the runs it came from, as one HTML file. */
  exportHtml(id: string): Promise<{ filename: string; redacted: boolean }>;
  /** Saves a kept injection result's report as one HTML file, as Share's Security report does. */
  injectionReport(resultId: string): Promise<{ filename: string; redacted: boolean }>;
  /**
   * A run's injection tests (`GET /api/injection/runs/:id`): its untrusted reads, each with the model
   * call that reads it, the results kept for it, and for an attempt, the test it belongs to and what it
   * planted where. It reads every call of the run, so a page asks once and asks `injectionResults` as runs move.
   */
  injectionRun(runId: string): Promise<RunInjection>;
  /** The results kept for a run, newest first (`GET /api/injection?run=`), from the results alone. */
  injectionResults(runId: string): Promise<{ results: InjectionRow[] }>;
  /** One kept result (`GET /api/injection/:id`): its row, its report, the runs gc took, and its panel (null for a --clean answer). */
  injectionResult(resultId: string): Promise<{ row: InjectionRow; report: InjectionReport; gone: string[]; view: InjectionPanelView | null }>;
  /** What a result's security report masks and keeps, and the file it saves (`GET /api/injection/:id/report?preview=1`). */
  injectionPreview(resultId: string): Promise<ReportPreview>;
  /** The built-in templates, versioned (`GET /api/injection/templates`): Run injection test's chips. */
  injectionTemplates(): Promise<TemplateSet>;
  /** A plan picked on a run, or a golden's pack, priced on the server as a test, or (`gate`) as each session's gate (`GET /api/injection/estimate`). */
  injectionEstimate(q: InjectionPlanQuery): Promise<Estimate>;
  /** Find cause… on one of a run's untrusted reads, priced on the server (`GET /api/injection/estimate?clean=`). */
  injectionCauseEstimate(runId: string, read: number): Promise<Estimate>;
  /** A payload file once it is sent (`GET /api/injection/payloads?upload=`): its name, how many payloads, and those with no `{{canary}}`, by id. */
  injectionPayloads(uploadId: string): Promise<PayloadsRead>;
  /** Tests' Security (`GET /api/injection/security`): each golden's recording's untrusted reads, its last test or gate, and its test's price. */
  injectionSecurity(): Promise<SecurityRead>;
  /** Saves a file a job wrote. */
  downloadFile(file: JobFile): Promise<void>;
  /** What changed since `since`, or null when the server has no `/api/changes` and the UI polls instead. */
  changes(since: string | null): Promise<Changes | null>;

  // ---- overview-runs: the Overview, the Runs page, imports and the team store
  /** The Overview, worked out on the server in the viewer's time zone (IANA); or, while the runs' totals are still being added up, how far that has got. */
  summary(tz: string): Promise<OverviewSummary | OverviewWarming>;
  /** A page of the Runs table: chips, filter, days and sort applied on the server, attempts bundled. */
  runsPage(q: RunsQuery): Promise<RunsPage & { runs: RunsPageRow[] }>;
  /** Runs per day for the calendar, in the viewer's days. */
  runsByDay(q: { tz: string; weeks?: number; types?: readonly string[]; q?: string }): Promise<RunsByDay>;
  /** Find breaking commit for the failures on the days picked: the first failure there, and what bisect can start from. */
  daysBisect(q: RunsQuery & { from: number; to: number }): Promise<DaysBisect>;
  /** Runs › Failed as issues: the failed runs the filter and the days keep, grouped by what they share, each with its count, and those shown open (`open`, by key) with their newest runs. */
  runsIssues(q: Pick<RunsQuery, 'from' | 'to' | 'q'>, open?: readonly string[]): Promise<IssuesPage>;
  /** One issue's runs under the same filter: its newest, or those after `cursor`, the run its last page ended on. */
  issueRuns(key: string, q: Pick<RunsQuery, 'from' | 'to' | 'q'>, cursor: string | null): Promise<IssueRunsPage>;
  /** Labels several runs at once, by their full ids. */
  labelRuns(ids: readonly string[], add: readonly string[], remove?: readonly string[]): Promise<LabelRunsResult>;
  /** Deletes several runs at once, by their full ids; runs that can't go now are skipped with why. `keepalive`: sent as the page goes, so the browser sees it out (`pending-delete.ts`). */
  deleteRuns(ids: readonly string[], o?: { keepalive?: boolean }): Promise<DeleteResult>;
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
  /** Every fix in to-do order, with the counts the chips show, what they took and the failing runs nobody has blamed. */
  fixes(): Promise<FixesView>;
  /** One fix, by its id or a unique prefix, with its three steps. */
  fix(id: string): Promise<FixDetail>;
  renameFix(id: string, title: string): Promise<FixDetail>;
  /** The attempts blame and verify made in a run's family, for the Forks view; null when the server does not bundle them. */
  fixBundles(runId: string): Promise<FixBundle[] | null>;

  // ---- Settings
  /** Settings: each tab's read and the edits to shadowlap.config.json (`settings-api.ts`). */
  settings: SettingsApi;
  /** The check builder: a golden's checks read, a draft judged on the recordings, and its tests entry written (`checks-api.ts`). */
  checks: ChecksApi;
  /** What billed jobs would cost, and Spending, the threshold above which one asks first. */
  estimates: EstimatesApi;
  /** Open in editor: a project file at a line, in the editor $VISUAL or $EDITOR names (`editor-api.ts`). */
  editor: EditorApi;
  /** Needs a look's advice put away (Dismiss) and brought back (Restore), in the project's store alone (`dismissals-api.ts`). */
  dismissals: DismissalsApi;
  /** The team store's setup page (`#/setup/store`, `store-api.ts`). */
  storeSetup: StoreSetupApi;

  // ---- Projects
  /** Projects: the switcher, Add project, removing one, and the setup (`projects-api.ts`). */
  projects: ProjectsApi;

  // ---- Training
  /** Training (`/api/training`): the strip, the pairs, the tasks and the scores. */
  training(): Promise<TrainingView>;
  /** The models Score a model offers, each priced (`/api/models`). It asks providers, so it can take a second. */
  models(): Promise<ModelsView>;

  // ---- Error-path presets and production coverage
  /** The last coverage scan: what imported runs did, and which behaviours no golden covers (`/api/coverage`); null on a server without it. */
  coverage(): Promise<CoverageView | null>;
  /** Every recording's error-path presets, and the newest sessions (`/api/chaos`); null on a server without it. */
  chaos(): Promise<ChaosView | null>;
  /** One run's presets matrix, its recording's for a preset's attempt (`/api/chaos/runs/:id`); null when none ran. */
  runChaos(id: string): Promise<ChaosMatrix | null>;
  /** Run error-path presets…'s plan for the picks (`/api/chaos/runs/:id/plan`): what they run on, hit, are judged and decided by, the command someone else recorded, and what they bill. */
  presetsPlan(id: string, picks: PresetsPicks): Promise<PresetsPlan>;

  // ---- What a fork did differently, and a fix's attempts grouped by what each did
  /** What a fork did differently from its parent (`/api/runs/:id/differences`); null for a run that isn't a fork of a run in the store. */
  forkDifferences(id: string): Promise<ForkDifferences | null>;
  /** The tools the model called that the run never recorded, which a replay runs for real (`GET /api/runs/:id/unrecorded`). */
  unrecorded(id: string): Promise<UnrecordedView | null>;
  /** A fix's blame probes and verified runs, their attempts grouped by what each did (`/api/fixes/:id/groups`). */
  attemptGroups(fixId: string): Promise<FixAttemptGroups>;
  /** A run's outcome by checks alone, each check with it (`GET /api/runs/:id/outcome`): what a long run's first answer leaves to its analysis. */
  outcome(id: string): Promise<{ judged: RunJudged | null }>;
  /** A run's next step alone, whole, with what it bills (`GET /api/runs/:id/next`): what a page's answer leaves out where it would read a long run's calls (`later`). */
  nextStep(id: string): Promise<{ next: NextStep | null }>;
  /**
   * The request a fork or a diverged replay changed, as recorded and as sent, with what fixes each
   * changed path (`GET /api/runs/:id/diff[?call=<n>]`): Show diff's. Null for a run that never diverged.
   */
  requestDiff(id: string, callNo?: number): Promise<RequestDiff | null>;
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

/** A report the server sent as a file, saved: its name, and whether the project's redaction rules masked it. */
async function savedReport(file: Promise<{ filename: string; res: Response }>): Promise<{ filename: string; redacted: boolean }> {
  const { filename, res } = await file;
  saveBlob(await res.blob(), filename);
  return { filename, redacted: res.headers.get('x-shadowlap-redacted') === 'yes' };
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file the server sends to download, and the name it gives it (else `fallbackName`); a refusal as the error the server says. */
async function fileOf(token: string, path: string, fallbackName: string): Promise<{ filename: string; res: Response }> {
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
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: text };
    }
    if (!res.ok) {
      noteRefusal(res.status, body);
      const said = body as { error?: string; confirm?: unknown; live?: unknown } | null;
      throw new ApiError(res.status, said?.error ?? `HTTP ${res.status}`, typeof said?.confirm === 'string' ? said.confirm : undefined, said?.live);
    }
    // Something the read named that the store doesn't hold, answered as the page asked: the 404 it is.
    const missing = method === 'GET' ? (body as { notFound?: unknown; error?: unknown } | null) : null;
    if (missing?.notFound === true) throw new ApiError(404, typeof missing.error === 'string' ? missing.error : 'not found');
    const etag = res.headers.get('etag');
    if (etag && method === 'GET') etags.set(path, etag, body, text.length);
    return body as T;
  }
  const id = encodeURIComponent;
  const fetchFile = (path: string, fallbackName: string) => fileOf(token, path, fallbackName);
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
    calls: (runId, from, limit, o) => request<CallsPage>(`runs/${id(runId)}/calls?from=${from}${limit === undefined ? '' : `&limit=${limit}`}${o?.whole ? '&whole=1' : ''}`),
    call: (runId, n, o) => request<CallDetail>(`runs/${id(runId)}/calls/${n}${o?.whole ? '?whole=1' : ''}`).then((d) => shape(d, normalizeCallDetail)),
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
    compare: (a, b) => request<CompareView>(`compare?a=${id(a)}&b=${id(b)}`),
    compareHead: (a, b) => request<CompareHead | null>(`compare?a=${id(a)}&b=${id(b)}&part=head`),
    search: (q) => request<SearchAnswer>(`search?q=${id(q)}&limit=40`).then((r) => ({ hits: r.hits ?? [], ...(r.indexing ? { indexing: r.indexing } : {}) })),
    labels: (runId, add, remove = []) => request<{ labels: string[] }>(`runs/${id(runId)}/labels`, { method: 'POST', body: JSON.stringify({ add, remove }) }),
    note: (runId, callNo, text) => request<{ notes: RunNote[] }>(`runs/${id(runId)}/notes`, { method: 'POST', body: JSON.stringify({ callNo, text }) }),
    action: (runId, key, callNo, value, yes, sent) => request<JobView>(`runs/${id(runId)}/actions`, { method: 'POST', body: JSON.stringify({ ...sent, key, callNo, ...(value !== undefined ? { value } : {}), ...(yes !== undefined ? { yes } : {}) }) }),
    startJob: (kind, fields) => request<JobView>('jobs', { method: 'POST', body: JSON.stringify({ ...fields, kind }) }),
    job: (jobId, after) => request<JobView>(`jobs/${id(jobId)}?after=${after}`),
    stopJob: (jobId) => request<{ stopped: boolean }>(`jobs/${id(jobId)}/stop`, { method: 'POST', body: '{}' }),
    jobs: async () => (await request<{ jobs: JobListItem[] }>('jobs')).jobs,
    remove: (runId, o) => request<{ deleted: string; attempts?: string[] }>(`runs/${id(runId)}`, { method: 'DELETE', ...(o?.keepalive ? { keepalive: true } : {}) }),
    // The API authenticates with a header, which a plain link cannot send, and a token in a URL would
    // end up in history and logs: so a file is fetched here and handed to the browser to save.
    exportHtml: (runId) => savedReport(fetchFile(`runs/${id(runId)}/export`, `shadowlap-${runId.slice(0, 10).toLowerCase()}.html`)),
    injectionReport: (resultId) => savedReport(fetchFile(`injection/${id(resultId)}/report`, 'shadowlap-injection.html')),
    downloadFile: async (file) => {
      const { filename, res } = await fetchFile(`files/${id(file.fileId)}`, file.name);
      saveBlob(await res.blob(), filename);
    },
    summary: (tz) => request<OverviewSummary | OverviewWarming>(`summary?tz=${id(tz)}`),
    ...runsReads(request),
    labelRuns: (ids, add, remove = []) => request<LabelRunsResult>('runs/labels', { method: 'POST', body: JSON.stringify({ ids, add, remove }) }),
    deleteRuns: (ids, o) => request<DeleteResult>('runs/delete', { method: 'POST', body: JSON.stringify({ ids }), ...(o?.keepalive ? { keepalive: true } : {}) }),
    knownRuns: (ids) => request<{ known: string[] }>('runs/known', { method: 'POST', body: JSON.stringify({ ids }) }).then((r) => r.known),
    // The status bar, Runs and the Overview ask at once when runs change: one request answers them all.
    teamStore: () => (storeLoading ??= loadStore().finally(() => (storeLoading = null))),
    importSources: () => request<ImportSources>('imports').catch((err: unknown) => (err instanceof ApiError && err.status === 404 ? null : Promise.reject(err))),
    upload: async (file, name) => {
      const res = await fetch('/api/uploads', { method: 'POST', body: file, headers: { 'x-shadowlap-token': token, ...projectHeader(), 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' } });
      const text = await res.text();
      let body: unknown;
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
    fixes: () => request<FixesView>('fixes'),
    fix: (fixId) => request<FixDetail>(`fixes/${id(fixId)}`),
    renameFix: (fixId, title) => request<FixDetail>(`fixes/${id(fixId)}/title`, { method: 'PUT', body: JSON.stringify({ title }) }),
    // A server that does not bundle them, or one that never heard of the run: the Forks view lists the attempts as runs.
    fixBundles: bundleSource((runId) => request<{ bundles: FixBundle[] }>(`fixes/family/${id(runId)}`).then((out) => out.bundles)),
    ...testsApi(request),
    ...ownApis(request),
    training: () => request<TrainingView>('training'),
    models: () => request<ModelsView>('models'),
    ...changesApi(request),
    // A server without the routes answers 404: nothing to show, rather than an error.
    forkDifferences: (runId) => request<{ differences: ForkDifferences | null }>(`runs/${id(runId)}/differences`).then((r) => r.differences),
    unrecorded: (runId) => request<{ unrecorded: UnrecordedView | null }>(`runs/${id(runId)}/unrecorded`).then((r) => r.unrecorded),
    attemptGroups: (fixId) => request<FixAttemptGroups>(`fixes/${id(fixId)}/groups`),
    ...longRunReads(request), ...injectionReads(request), ...chaosReads(request),
  };
}

/** The parts of the client that are APIs of their own, each written beside its routes. */
function ownApis(request: Request): Pick<Client, 'settings' | 'checks' | 'storeSetup' | 'projects' | 'estimates' | 'editor' | 'dismissals'> {
  return {
    settings: settingsApi(request),
    checks: checksApi(request),
    storeSetup: storeSetupApi(request),
    projects: projectsApi(request),
    estimates: estimatesApi(request),
    editor: editorApi(request),
    dismissals: dismissalsApi(request),
  };
}

/** An address with `name` set to each of `keys`, after what it asks already. */
const withKeys = (path: string, name: string, keys: readonly string[]): string => keys.reduce((p, k) => `${p}${p.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(k)}`, path);

/** What Failed's issues are read by: the days and the filter's words, never a chip or a sort. */
const issuesFilter = ({ from, to, q }: Pick<RunsQuery, 'from' | 'to' | 'q'>): RunsQuery => ({ ...(from != null ? { from } : {}), ...(to != null ? { to } : {}), ...(q ? { q } : {}) });

/** The Runs page's reads, each with the same filter: its table, its days, Find breaking commit's failures, and Failed's issues. */
function runsReads(request: Request): Pick<Client, 'runsPage' | 'runsByDay' | 'daysBisect' | 'runsIssues' | 'issueRuns'> {
  return {
    runsPage: (q) => request<RunsPage & { runs: RunsPageRow[] }>(`runs/page${runsQueryString(q)}`),
    runsByDay: (q) => request<RunsByDay>(`runs/days${runsQueryString(q)}`),
    daysBisect: (q) => request<DaysBisect>(`runs/bisect${runsQueryString(q)}`),
    runsIssues: (q, open = []) => request<IssuesPage>(withKeys(`runs/issues${runsQueryString(issuesFilter(q))}`, 'open', open)),
    issueRuns: (key, q, cursor) => request<IssueRunsPage>(withKeys(`runs/issues${runsQueryString({ ...issuesFilter(q), ...(cursor ? { cursor } : {}) })}`, 'issue', [key])),
  };
}

/** What a long run's first answer leaves to reads of their own, as its analysis has them. */
function longRunReads(request: Request): Pick<Client, 'outcome' | 'nextStep' | 'requestDiff'> {
  const id = encodeURIComponent;
  return {
    outcome: (runId) => request<{ judged: unknown }>(`runs/${id(runId)}/outcome`).then((r) => ({ judged: normalizeJudged(r.judged) })),
    nextStep: (runId) => request<{ next: NextStep | null }>(`runs/${id(runId)}/next`),
    requestDiff: (runId, callNo) => request<{ diff: RequestDiff | null }>(`runs/${id(runId)}/diff${callNo === undefined ? '' : `?call=${callNo}`}`).then((r) => r.diff),
  };
}

/** A plan Run injection test… or Pack with injection gate… picked: how many payloads, attempts each, Stop at $. */
export interface InjectionPlanQuery {
  /** The run it plants in; null for a golden whose recording only its pack holds (`golden`), priced from the pack. */
  runId: string | null;
  golden?: string | null | undefined;
  payloads: number;
  repeat?: number | undefined;
  budget?: number | null | undefined;
  /** Priced as each test session's gate, not as a test. */
  gate?: boolean | undefined;
}

type ChaosReads = 'coverage' | 'chaos' | 'runChaos' | 'presetsPlan';

/** What the pages read of error-path presets and production coverage (`/api/chaos`, `/api/coverage`): none on a server without them. */
function chaosReads(request: Request): Pick<Client, ChaosReads> {
  const id = encodeURIComponent;
  const none = (err: unknown) => (err instanceof ApiError && err.status === 404 ? null : Promise.reject(err));
  return {
    coverage: () => request<CoverageView>('coverage').catch(none),
    chaos: () => request<ChaosView>('chaos').catch(none),
    runChaos: (runId) => request<{ matrix: ChaosMatrix | null }>(`chaos/runs/${id(runId)}`).then((r) => r.matrix, none),
    presetsPlan: (runId, p) => request<PresetsPlan>(`chaos/runs/${id(runId)}/plan?${p.presets ? `presets=${p.presets.join(',')}&` : ''}${p.tool ? `tool=${id(p.tool)}&` : ''}${p.expect ? 'expect=1' : ''}`),
  };
}

type InjectionReads = 'injectionRun' | 'injectionResults' | 'injectionResult' | 'injectionPreview' | 'injectionTemplates' | 'injectionEstimate' | 'injectionCauseEstimate' | 'injectionPayloads' | 'injectionSecurity';

/** What the pages read of injection tests (`/api/injection`): a run's, and what its dialogs ask. */
function injectionReads(request: Request): Pick<Client, InjectionReads> {
  const id = encodeURIComponent;
  return {
    injectionRun: (runId) => request<RunInjection>(`injection/runs/${id(runId)}`),
    injectionResults: (runId) => request<{ results: InjectionRow[] }>(`injection?run=${id(runId)}`),
    injectionResult: (resultId) => request(`injection/${id(resultId)}`),
    injectionPreview: (resultId) => request<ReportPreview>(`injection/${id(resultId)}/report?preview=1`),
    injectionTemplates: () => request<TemplateSet>('injection/templates'),
    injectionEstimate: (p) => request<{ estimate: Estimate }>(`injection/estimate?${p.runId ? `run=${id(p.runId)}` : `golden=${id(p.golden ?? '')}`}&payloads=${p.payloads}${p.repeat ? `&repeat=${p.repeat}` : ''}${p.budget ? `&budget=${p.budget}` : ''}${p.gate ? '&gate=1' : ''}`).then((r) => r.estimate),
    injectionCauseEstimate: (runId, read) => request<{ estimate: Estimate }>(`injection/estimate?run=${id(runId)}&clean=${read}`).then((r) => r.estimate),
    injectionPayloads: (uploadId) => request<PayloadsRead>(`injection/payloads?upload=${id(uploadId)}`),
    injectionSecurity: () => request<SecurityRead>('injection/security'),
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
    // A copy holds every call on its run's page: a page after it comes from there.
    calls: (runId, from, limit = 500) =>
      get<RunDetail>(`runs/${full(runId)}`).then((d) => {
        const rest = d.calls.filter((c) => c.callNo >= from);
        return { runId: d.run.runId, calls: rest.slice(0, limit), callsTotal: d.calls.length, callsNext: rest[limit]?.callNo ?? null };
      }),
    call: (runId, n) => get<CallDetail>(`runs/${full(runId)}/calls/${n}`).then((d) => shape(d, normalizeCallDetail)),
    lineage: (runId) => get<{ nodes: LineageNode[] }>(`runs/${full(runId)}/lineage`).then((r) => r.nodes),
    provenance: (runId) => Promise.resolve((data.responses[`runs/${full(runId)}/provenance`] as ProvenanceView | undefined) ?? null),
    offers: () => Promise.resolve(null),
    showJson: (runId) => get<unknown>(`runs/${full(runId)}/show`),
    compare: (a, b) => get<CompareView>(`compare?a=${full(a)}&b=${full(b)}`),
    // A copy holds each comparison whole.
    compareHead: () => Promise.resolve(null),
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
    injectionReport: readOnly,
    downloadFile: readOnly,
    changes: () => Promise.resolve(null),
    // An exported copy lists its runs from the file: the Runs page works them out itself.
    summary: () => Promise.reject(new ApiError(404, 'this is an exported copy: it holds runs, not the Overview')),
    runsPage: () => Promise.reject(new ApiError(404, 'this is an exported copy: its runs are listed from the file')),
    runsByDay: () => Promise.reject(new ApiError(404, 'this is an exported copy: its runs are listed from the file')),
    runsIssues: () => Promise.reject(new ApiError(404, 'this is an exported copy: its runs are listed from the file')),
    issueRuns: () => Promise.reject(new ApiError(404, 'this is an exported copy: its runs are listed from the file')),
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
    testEvidence: () => Promise.reject(new ApiError(404, 'this is an exported copy, and a golden’s attempts are not part of it')),
    settings: noSettings(readOnly),
    checks: noChecks(readOnly),
    estimates: noEstimates(readOnly),
    editor: { open: readOnly },
    dismissals: noDismissals(readOnly),
    storeSetup: noStoreSetup(readOnly),
    projects: noProjects(readOnly),
    training: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Training is not part of it')),
    models: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Training is not part of it')),
    // The decision diff and Verdicts are not part of an exported copy.
    decisionSessions: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Changes are not part of it')),
    decisionSession: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Changes are not part of it')),
    verdicts: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Changes are not part of it')),
    verdictRevision: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Changes are not part of it')),
    runDecisions: () => Promise.resolve({ runId: '', sessions: [], later: null }),
    retirements: () => Promise.resolve({ version: '', notices: [] }),
    migrateStart: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Changes are not part of it')),
    coverage: () => Promise.resolve(null),
    chaos: () => Promise.resolve(null),
    runChaos: () => Promise.resolve(null),
    // A copy runs no preset, so nothing in it asks what they would hit or bill.
    presetsPlan: readOnly,
    // Held for a fork whose parent the file holds too; otherwise its run page leaves the panel out.
    forkDifferences: (runId) => Promise.resolve((data.responses[`runs/${full(runId)}/differences`] as { differences: ForkDifferences | null } | undefined)?.differences ?? null),
    // A copy replays nothing: what its replay would run for real is the store's to say, and reading it would read the run twice.
    unrecorded: () => Promise.resolve(null),
    attemptGroups: () => Promise.reject(new ApiError(404, 'this is an exported copy, and Fixes are not part of it')),
    // A copy's page holds its run's outcome as it was judged when the copy was made.
    outcome: (runId) => get<RunDetail>(`runs/${full(runId)}`).then((d) => ({ judged: normalizeJudged(d.judged ?? null) })),
    // As its page holds it: a copy runs nothing, so it bills nothing.
    nextStep: (runId) => get<RunDetail>(`runs/${full(runId)}`).then((d) => ({ next: d.next ?? null })),
    // A copy keeps no injection results: its run's page tags no read and draws no test, and an attempt's
    // page draws what its run's own record says of it (run/model.ts), never what was planted where.
    injectionRun: () => Promise.resolve({ untrusted: [], results: [], rule: null, answers: [], cause: [], attempt: null }),
    injectionResults: () => Promise.resolve({ results: [] }),
    injectionResult: () => Promise.reject(new ApiError(404, 'this is an exported copy, and injection tests are not part of it')),
    injectionPreview: () => Promise.reject(new ApiError(404, 'this is an exported copy, and injection tests are not part of it')),
    // A copy runs no test, so nothing in it asks what one would plant or bill.
    injectionTemplates: readOnly,
    injectionEstimate: readOnly,
    injectionCauseEstimate: readOnly,
    injectionPayloads: readOnly,
    injectionSecurity: () => Promise.reject(new ApiError(404, 'this is an exported copy, and injection tests are not part of it')),
    // Held for each run that diverged, at the call it diverged at; another call's is the store's to read.
    requestDiff: (runId, callNo) => Promise.resolve(callNo === undefined ? ((data.responses[`runs/${full(runId)}/diff`] as { diff: RequestDiff | null } | undefined)?.diff ?? null) : null),
  };
}
