import type { ActionItem as ServerAction, CallDetail as ServerCallDetail, CallRow as ServerCallRow, LineageNode as ServerLineageNode, RunDetail as ServerRunDetail, RunListItem as ServerRunListItem } from '../src/api.js';
import type { RunComparison } from '../../engine/src/compare.js';
import type { SearchHit } from '../../engine/src/search.js';
import type { RunNote } from '../../engine/src/types.js';
import { readTokenLink } from './route.js';

/**
 * The dashboard's API client, the one module that talks to the server. The types are the server's
 * (`src/api.ts`), widened with the fields other parts of the API add: each is optional, and every
 * view renders it when it is there and falls back to what it can show without it.
 */

export type { Block, Delta } from '../../engine/src/deltas.js';
export type { Turn, TurnBlock } from '../../engine/src/conversation.js';
export type { RunChanges } from '../../engine/src/changes.js';
export type { RunComparison, SearchHit, RunNote };

// ---------------------------------------------------------------------------------------------- types

/** What `/api/runs` may add to a run: its origins, whether it is a test or an attempt, its blame and checks. */
export interface RunListExtras {
  /** One character per call, in order (r replayed, l live, o overridden, i injected, f failed, b blocked, s stubbed), or origin names. */
  origins?: string | string[] | null;
  /** A replay made by `shadowlap test`: the golden and the test session. */
  test?: { golden: string; session?: string } | null;
  /** Set on runs made by `--repeat`, blame and verify: bundled under the run they came from, not listed. */
  attempt?: string | boolean | null;
  repeat?: unknown;
  probe?: unknown;
  verify?: unknown;
  blame?: { callNo: number | null } | null;
  checks?: { passed: number; total: number } | null;
  author?: string | null;
}
export type RunListItem = ServerRunListItem & RunListExtras;

export interface CallRowExtras {
  /** For a replayed call: how long it took where it was recorded (the parent's call, or further back). */
  recordedMs?: number | null;
  /** What a tool returned, short enough for a table cell. */
  resultShort?: string | null;
  /** Which conversation of the run the call belongs to (a batch run holds many). */
  conversation?: number | null;
  requestRef?: string | null;
  responseRef?: string | null;
  fingerprint?: string | null;
  /** A recorded user input (`user_input`), read like a tool. */
  input?: boolean;
}
export type CallRow = ServerCallRow & CallRowExtras;

export interface Intervention {
  /** The flag as given: `--fail-at 19=529`. */
  flag: string;
  value?: string | null;
  callNo: number;
}

export interface BlameView {
  callNo: number | null;
  /** The blamed call counted among the model calls in the blame's scope: k of m. */
  modelCall?: { k: number; m: number } | null;
  confidence?: string | null;
  rescuedRunId?: string | null;
  scope?: string | null;
}

export interface CheckView {
  label: string;
  ok: boolean;
  count?: number;
  of?: number;
}

/** What `/api/runs/:id` may add for the run page. */
export interface RunDetailExtras {
  /** The recorded duration of every replayed call, summed up the parent chain. */
  notWaitedMs?: number | null;
  forkAt?: number | null;
  intervention?: Intervention | null;
  /** A fork that blame made: the run it rescued, and the call it asked again. */
  rescuedBy?: { runId: string; callNo: number } | null;
  blame?: BlameView | null;
  checks?: CheckView[] | null;
  notRecorded?: { hosts: string[]; tools: string[] } | null;
  cache?: { readShare: number; misses: Array<{ callNo: number; tokens: number }> } | null;
  provenance?: Record<string, unknown> | null;
  /** The fix this failure belongs to. */
  fix?: { id: string; status: string; title: string } | null;
}
export type RunDetail = Omit<ServerRunDetail, 'calls' | 'actions'> & { calls: CallRow[]; actions: ActionItem[] } & RunDetailExtras;

/** An action as the fork menu lists it; `flag`, `group` and `hint` come with the newer action list. */
export type ActionItem = ServerAction & { flag?: string; group?: 'call' | 'run'; hint?: string };

export type CallDetail = Omit<ServerCallDetail, 'call' | 'actions'> & { call: ServerCallDetail['call'] & CallRowExtras; actions: ActionItem[] };

export type LineageNode = ServerLineageNode & { probe?: unknown; verify?: unknown; origins?: string | string[] | null };

export interface LiveRun {
  runId: string;
  calls: number;
}

export interface Meta {
  version: string | null;
  dbPath: string | null;
  /** Actions can run: started by `shadowlap dashboard`, and not read-only. */
  actions: boolean;
  /** An exported HTML copy: recorded data only, no server behind it. */
  static?: boolean;
  exportedAt?: number;
  redacted?: boolean;
  runIds?: string[];
  readOnly?: boolean;
  /** Where the server listens: 127.0.0.1:4777. */
  address?: string | null;
  storeBytes?: number | null;
  /** Runs (attempts left out) and attempts. */
  counts?: { runs: number; attempts: number } | null;
  live?: LiveRun[];
  /** The job kinds `POST /api/jobs` accepts. An action whose kind is missing is not shown. */
  jobKinds?: string[];
  project?: { name: string; path: string } | null;
  /** How many redaction rules a copy made now applies. */
  redactRules?: number | null;
}

export interface JobLink {
  label: string;
  href: string;
}

export interface JobFile {
  fileId: string;
  name: string;
  label?: string | null;
  path?: string;
  bytes?: number;
}

export interface JobView {
  id: string;
  args: string[];
  runId: string | null;
  opensRun: boolean;
  startedAt: number;
  done: boolean;
  code: number | null;
  newRunId: string | null;
  lines: string[];
  total: number;
  kind?: string;
  title?: string;
  endedAt?: number | null;
  runs?: string[];
  links?: JobLink[];
  files?: JobFile[];
  result?: unknown;
}

/** `/api/changes`: whether anything shown changed since the cursor. */
export interface Changes {
  cursor?: string;
  version?: string | number;
  changed?: boolean;
  runs?: boolean;
  calls?: boolean;
  events?: boolean;
  jobs?: boolean;
  live?: LiveRun[];
}

/** What `shadowlap export html` embeds: the answers this page would otherwise have asked a server for. */
export interface StaticPayload {
  shadowlap: string | null;
  exportedAt: number;
  runIds: string[];
  redacted: boolean;
  responses: Record<string, unknown>;
}

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
    return link.token;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
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
}

const etags = new Map<string, { etag: string; body: unknown }>();

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
    meta: () => request<Meta>('meta'),
    runs: () => request<{ runs: RunListItem[] }>('runs').then((r) => r.runs),
    run: (runId) => request<RunDetail>(`runs/${id(runId)}`),
    call: (runId, n) => request<CallDetail>(`runs/${id(runId)}/calls/${n}`),
    lineage: (runId) => request<{ nodes: LineageNode[] }>(`runs/${id(runId)}/lineage`).then((r) => r.nodes),
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
    meta: () => get<Meta>('meta'),
    runs: () => get<{ runs: RunListItem[] }>('runs').then((r) => r.runs),
    run: (runId) => get<RunDetail>(`runs/${encodeURIComponent(runId)}`),
    call: (runId, n) => get<CallDetail>(`runs/${encodeURIComponent(runId)}/calls/${n}`),
    lineage: (runId) => get<{ nodes: LineageNode[] }>(`runs/${encodeURIComponent(runId)}/lineage`).then((r) => r.nodes),
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
  };
}
