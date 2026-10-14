import type { ActionItem, CallDetail, LineageNode, RunDetail, RunListItem } from '../src/api.js';
import type { RunComparison } from '../../engine/src/compare.js';

export type { ActionItem, CallDetail, CallRow, LineageNode, RunDetail, RunListItem } from '../src/api.js';
export type { RunComparison } from '../../engine/src/compare.js';
export type { Block, Delta } from '../../engine/src/deltas.js';
export type { SearchHit } from '../../engine/src/search.js';
export type { Turn, TurnBlock } from '../../engine/src/conversation.js';

export interface Meta {
  version: string | null;
  dbPath: string | null;
  actions: boolean;
  /** An exported HTML copy: recorded data only, no server behind it. */
  static?: boolean;
  exportedAt?: number;
  redacted?: boolean;
  runIds?: string[];
}

/** What `shadowlap export html` embeds: the answers this page would otherwise have asked a server for. */
export interface StaticPayload {
  shadowlap: string | null;
  exportedAt: number;
  runIds: string[];
  redacted: boolean;
  responses: Record<string, unknown>;
}

export interface JobView {
  id: string;
  args: string[];
  runId: string;
  opensRun: boolean;
  startedAt: number;
  done: boolean;
  code: number | null;
  newRunId: string | null;
  lines: string[];
  total: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'shadowlap-dashboard-token';

/** The session token arrives in the URL fragment once; it is kept for this tab only and removed from the address bar. */
export function takeToken(): string | null {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    try {
      sessionStorage.setItem(TOKEN_KEY, m[1]!);
    } catch {
      // storage unavailable: the token lives in memory for this page
    }
    // `&open=/run/<id>` lands on a view; anything else lands on the home page.
    const open = /&open=(\/[A-Za-z0-9/_-]*)/.exec(location.hash)?.[1];
    history.replaceState(null, '', `${location.pathname}#${open ?? '/'}`);
    return m[1]!;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const etags = new Map<string, { etag: string; body: unknown }>();

export function createClient(token: string) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const cached = (init.method ?? 'GET') === 'GET' ? etags.get(path) : undefined;
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
    if (etag) etags.set(path, { etag, body });
    return body as T;
  }
  return {
    exported: false,
    meta: () => request<Meta>('meta'),
    runs: () => request<{ runs: RunListItem[] }>('runs').then((r) => r.runs),
    run: (id: string) => request<RunDetail>(`runs/${encodeURIComponent(id)}`),
    call: (id: string, n: number) => request<CallDetail>(`runs/${encodeURIComponent(id)}/calls/${n}`),
    labels: (id: string, add: string[], remove: string[] = []) => request<{ labels: string[] }>(`runs/${encodeURIComponent(id)}/labels`, { method: 'POST', body: JSON.stringify({ add, remove }) }),
    note: (id: string, callNo: number | null, text: string) => request<{ notes: Array<{ callNo: number | null; text: string; at: number }> }>(`runs/${encodeURIComponent(id)}/notes`, { method: 'POST', body: JSON.stringify({ callNo, text }) }),
    search: (q: string) => request<{ hits: import('../../engine/src/search.js').SearchHit[] }>(`search?q=${encodeURIComponent(q)}`).then((r) => r.hits),
    lineage: (id: string) => request<{ nodes: LineageNode[] }>(`runs/${encodeURIComponent(id)}/lineage`).then((r) => r.nodes),
    compare: (a: string, b: string) => request<RunComparison>(`compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
    action: (id: string, key: string, callNo: number | null, value?: string) => request<JobView>(`runs/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ key, callNo, ...(value !== undefined ? { value } : {}) }) }),
    job: (jobId: string, after: number) => request<JobView>(`jobs/${jobId}?after=${after}`),
    remove: (id: string) => request<{ deleted: string; blobs: number; bytes: number }>(`runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /**
     * Saves the run as one HTML file. The API authenticates with a header, which a plain link cannot
     * send, and a token in a URL would end up in history and logs: so the file is fetched here and
     * handed to the browser to save.
     */
    download: async (id: string): Promise<{ filename: string; redacted: boolean }> => {
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}/export`, { headers: { 'x-shadowlap-token': token } });
      if (!res.ok) throw new ApiError(res.status, (await res.text()) || `HTTP ${res.status}`);
      const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `shadowlap-${id.slice(0, 10).toLowerCase()}.html`;
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { filename, redacted: res.headers.get('x-shadowlap-redacted') === 'yes' };
    },
  };
}

export type Client = ReturnType<typeof createClient>;

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
    if (body === undefined) return Promise.reject(new ApiError(404, 'this is an exported copy of a run, and that view is not part of it'));
    return Promise.resolve(body as T);
  };
  const readOnly = () => Promise.reject(new ApiError(405, 'this is an exported copy of a run: it cannot be changed from here'));
  return {
    exported: true,
    meta: () => get<Meta>('meta'),
    runs: () => get<{ runs: RunListItem[] }>('runs').then((r) => r.runs),
    run: (id: string) => get<RunDetail>(`runs/${encodeURIComponent(id)}`),
    call: (id: string, n: number) => get<CallDetail>(`runs/${encodeURIComponent(id)}/calls/${n}`),
    labels: readOnly,
    note: readOnly,
    search: () => Promise.resolve([]),
    lineage: (id: string) => get<{ nodes: LineageNode[] }>(`runs/${encodeURIComponent(id)}/lineage`).then((r) => r.nodes),
    compare: (a: string, b: string) => get<RunComparison>(`compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
    action: readOnly,
    job: readOnly,
    remove: readOnly,
    download: readOnly,
  };
}
export type { ActionItem as Action };
