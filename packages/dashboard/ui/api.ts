import type { RunComparison } from '../../engine/src/compare.js';
import type { SearchHit } from '../../engine/src/search.js';
import type { RunNote } from '../../engine/src/types.js';
import { normalizeCallDetail, normalizeMeta, normalizeRunDetail, normalizeRuns } from './normalize.js';
import { readTokenLink } from './route.js';
import type { CallDetail, Changes, JobFile, JobView, LineageNode, Meta, ProvenanceView, RunDetail, RunListItem, StaticPayload } from './types.js';
import type { ActivityPage, DaysBisect, DeleteResult, ImportSources, LabelRunsResult, OverviewSummary, RunsByDay, RunsPage, RunsPageRow, RunsQuery, TeamStoreStatus, TeamStoreView, UploadView } from './types.js';
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
  tests: 'test',
  importCapture: 'import',
  calibrate: 'calibrate',
  gc: 'gc',
  // overview-runs: the team store, and Find the commit from the Runs calendar (the tests slice's kind)
  push: 'push',
  pull: 'pull',
  share: 'share',
  bisect: 'bisect',
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
  run(id: string): Promise<RunDetail>;
  call(id: string, n: number): Promise<CallDetail>;
  lineage(id: string): Promise<LineageNode[]>;
  /** The run's record for Provenance, or null when the server does not work it out. */
  provenance(id: string): Promise<ProvenanceView | null>;
  compare(a: string, b: string): Promise<RunComparison>;
  search(q: string): Promise<SearchHit[]>;
  labels(id: string, add: string[], remove?: string[]): Promise<{ labels: string[] }>;
  note(id: string, callNo: number | null, text: string): Promise<{ notes: RunNote[] }>;
  /** Runs one of the run's actions (`/api/runs/:id/actions`): the server builds the command line. */
  action(id: string, key: string, callNo: number | null, value?: string): Promise<JobView>;
  /** Starts a job of a registered kind (`POST /api/jobs`). */
  startJob(kind: string, fields: Record<string, unknown>): Promise<JobView>;
  job(jobId: string, after: number): Promise<JobView>;
  remove(id: string): Promise<{ deleted: string }>;
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
}

const etags = new Map<string, { etag: string; body: unknown }>();

/**
 * Each answer in the shape the views read (`normalize.ts`), worked out once per answer: an unchanged
 * answer (a 304 hands back the same object) comes back as the same object, so nothing redraws.
 */
const shaped = new WeakMap<object, unknown>();
function shape<T extends object, U>(raw: T, fn: (raw: T) => U): U {
  if (shaped.has(raw)) return shaped.get(raw) as U;
  const out = fn(raw);
  shaped.set(raw, out);
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
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const cached = method === 'GET' ? etags.get(path) : undefined;
    const res = await fetch(`/api/${path}`, {
      ...init,
      headers: { 'x-shadowlap-token': token, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(cached ? { 'if-none-match': cached.etag } : {}) },
    });
    if (res.status === 304 && cached) return cached.body as T;
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: text };
    }
    if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
    const etag = res.headers.get('etag');
    if (etag && method === 'GET') etags.set(path, { etag, body });
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
    meta: () => request<Meta>('meta').then((m) => shape(m, normalizeMeta)),
    runs: () => request<{ runs: RunListItem[] }>('runs').then((r) => shape(r, (x) => normalizeRuns(x.runs))),
    run: (runId) => request<RunDetail>(`runs/${id(runId)}`).then((d) => shape(d, normalizeRunDetail)),
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
    compare: (a, b) => request<RunComparison>(`compare?a=${id(a)}&b=${id(b)}`),
    search: (q) => request<{ hits: SearchHit[] }>(`search?q=${id(q)}&limit=40`).then((r) => r.hits),
    labels: (runId, add, remove = []) => request<{ labels: string[] }>(`runs/${id(runId)}/labels`, { method: 'POST', body: JSON.stringify({ add, remove }) }),
    note: (runId, callNo, text) => request<{ notes: RunNote[] }>(`runs/${id(runId)}/notes`, { method: 'POST', body: JSON.stringify({ callNo, text }) }),
    action: (runId, key, callNo, value) => request<JobView>(`runs/${id(runId)}/actions`, { method: 'POST', body: JSON.stringify({ key, callNo, ...(value !== undefined ? { value } : {}) }) }),
    startJob: (kind, fields) => request<JobView>('jobs', { method: 'POST', body: JSON.stringify({ ...fields, kind }) }),
    job: (jobId, after) => request<JobView>(`jobs/${id(jobId)}?after=${after}`),
    remove: (runId) => request<{ deleted: string }>(`runs/${id(runId)}`, { method: 'DELETE' }),
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
      const res = await fetch('/api/uploads', { method: 'POST', body: file, headers: { 'x-shadowlap-token': token, 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' } });
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

/** The same views, answered from the file itself. Anything that would change a run says it cannot. */
export function createExportedClient(data: StaticPayload): Client {
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
    run: (runId) => get<RunDetail>(`runs/${encodeURIComponent(runId)}`).then((d) => shape(d, normalizeRunDetail)),
    call: (runId, n) => get<CallDetail>(`runs/${encodeURIComponent(runId)}/calls/${n}`).then((d) => shape(d, normalizeCallDetail)),
    lineage: (runId) => get<{ nodes: LineageNode[] }>(`runs/${encodeURIComponent(runId)}/lineage`).then((r) => r.nodes),
    provenance: (runId) => Promise.resolve((data.responses[`runs/${encodeURIComponent(runId)}/provenance`] as ProvenanceView | undefined) ?? null),
    compare: (a, b) => get<RunComparison>(`compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
    search: () => Promise.resolve([]),
    labels: readOnly,
    note: readOnly,
    action: readOnly,
    startJob: readOnly,
    job: readOnly,
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
  };
}
