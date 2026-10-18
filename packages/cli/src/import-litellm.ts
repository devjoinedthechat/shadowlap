import type { Store } from '@shadowlap/engine';
import { append, headerMap, importCaptured, type Captured, type ImportResult, type Skip } from './import-capture.js';

/**
 * Captures written by `shadowlap.litellm_callback` on a LiteLLM proxy: one JSON object per line.
 * A format adapter only — {@link ../import-capture.js} turns these into a recording.
 *
 * The one thing this has to do that the file-based adapters don't is decide which provider a call
 * belongs to. A capture from a gateway carries the gateway's own URL — `http://litellm.internal/v1/
 * chat/completions` — which matches no provider's host, so every entry would be skipped. But the
 * agent was speaking a provider's dialect to it, and the path says which: that is what it will send
 * on replay, and what the sidecar will present. So the host is replaced with the provider's
 * canonical one and the path with its canonical spelling.
 */

/** A LiteLLM route, and the provider dialect the agent was speaking on it. */
const ROUTES: Array<{ match: RegExp; host: string; path: string }> = [
  { match: /\/(?:v1\/)?chat\/completions$/, host: 'api.openai.com', path: '/v1/chat/completions' },
  { match: /\/(?:v1\/)?responses$/, host: 'api.openai.com', path: '/v1/responses' },
  { match: /\/(?:v1\/)?embeddings$/, host: 'api.openai.com', path: '/v1/embeddings' },
  { match: /\/(?:v1\/)?completions$/, host: 'api.openai.com', path: '/v1/completions' },
  { match: /\/(?:v1\/)?messages$/, host: 'api.anthropic.com', path: '/v1/messages' },
];

export interface LitellmRecord {
  format?: string;
  v?: number;
  url?: string;
  method?: string;
  requestHeaders?: Record<string, unknown>;
  requestBody?: unknown;
  status?: number;
  responseHeaders?: Record<string, unknown>;
  responseBody?: string;
  startedAt?: number;
  timeMs?: number;
  runKey?: string | null;
}

const pairs = (raw: Record<string, unknown> | undefined): Array<[string, string]> =>
  Object.entries(raw ?? {}).map(([k, v]) => [k, String(v ?? '')] as [string, string]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What is wrong with a capture record's shape, or null: a line of the wrong shape is skipped with the reason. */
function recordProblem(r: Record<string, unknown>): string | null {
  const text = (k: string) => r[k] === undefined || typeof r[k] === 'string';
  if (!text('url')) return "url isn't text";
  if (!text('method')) return "method isn't text";
  if (r.status !== undefined && !Number.isInteger(r.status)) return "status isn't a number";
  if (!text('responseBody')) return "responseBody isn't text";
  if (r.requestHeaders !== undefined && !isObject(r.requestHeaders)) return "requestHeaders isn't an object";
  if (r.responseHeaders !== undefined && !isObject(r.responseHeaders)) return "responseHeaders isn't an object";
  if (r.runKey !== undefined && r.runKey !== null && typeof r.runKey !== 'string') return "runKey isn't text";
  return null;
}

/** The provider endpoint the agent believed it was calling. */
export function providerEndpoint(url: string): { host: string; path: string } | null {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // A relative path is fine: the route is all that is needed.
  }
  const route = ROUTES.find((r) => r.match.test(pathname));
  return route ? { host: route.host, path: route.path } : null;
}

/** One agent run's calls, as identified by the correlation id the agent sent. */
export interface LitellmGroup extends Captured {
  /** The correlation id these calls shared, or null for the calls that carried none. */
  key: string | null;
}

/**
 * Parses a capture file's contents into one group per correlation id.
 *
 * A gateway serves every request the fleet makes, so a capture interleaves calls from unrelated
 * runs. Grouping is what makes a run mean something; without an id there is nothing to group by,
 * and those calls come back as a single group with a null key for the caller to warn about.
 *
 * Throws only when nothing in the file is a Shadowlap capture. A single unreadable line is skipped:
 * a gateway appends to this file while serving traffic, so its last line may be half written.
 */
export function readLitellmGroups(contents: string): LitellmGroup[] {
  const lines = contents.split('\n').filter((l) => l.trim());
  const groups = new Map<string | null, LitellmGroup>();
  const skipped: Skip[] = [];
  let recognised = 0;
  const groupFor = (key: string | null): LitellmGroup => {
    let group = groups.get(key);
    if (!group) {
      group = { key, calls: [], skipped: [] };
      groups.set(key, group);
    }
    return group;
  };

  for (const [i, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped.push({ url: `line ${i + 1}`, reason: 'not JSON (a partly written line?)' });
      continue;
    }
    const urlOf = (r: unknown) => (isObject(r) && typeof r.url === 'string' && r.url ? r.url : `line ${i + 1}`);
    if (!isObject(parsed) || parsed.format !== 'shadowlap-capture') {
      skipped.push({ url: urlOf(parsed), reason: 'not a Shadowlap capture record' });
      continue;
    }
    recognised++;
    const problem = recordProblem(parsed);
    if (problem) {
      skipped.push({ url: urlOf(parsed), reason: `not a Shadowlap capture record: ${problem}` });
      continue;
    }
    const record = parsed as LitellmRecord;
    const endpoint = record.url ? providerEndpoint(record.url) : null;
    if (!endpoint) {
      skipped.push({ url: record.url ?? `line ${i + 1}`, reason: 'not a route Shadowlap recognises as a model API' });
      continue;
    }
    groupFor(record.runKey ?? null).calls.push({
      url: `https://${endpoint.host}${endpoint.path}`,
      method: record.method ?? 'POST',
      requestHeaders: headerMap(pairs(record.requestHeaders)),
      requestBody: record.requestBody ?? null,
      status: record.status ?? 200,
      responseHeaders: headerMap(pairs(record.responseHeaders)),
      responseBytes: Buffer.from(record.responseBody ?? '', 'utf8'),
      ...(typeof record.startedAt === 'number' ? { startedAt: record.startedAt } : {}),
      ...(typeof record.timeMs === 'number' ? { timeMs: record.timeMs } : {}),
    });
  }

  if (!recognised) {
    throw new Error('not a Shadowlap capture: expected lines written by shadowlap.litellm_callback, each with "format": "shadowlap-capture"');
  }
  // Whatever could not be read at all belongs to the file, not to any one run.
  const ordered = [...groups.values()];
  if (ordered.length) append(ordered[0]!.skipped, skipped);
  else if (skipped.length) ordered.push({ key: null, calls: [], skipped });
  return ordered;
}

/** Reads a capture file and imports one run per correlation id. */
export function importLitellm(store: Store, contents: string, opts: { source: string; cwd?: string }): Array<ImportResult & { key: string | null }> {
  return readLitellmGroups(contents).map((group) => ({ key: group.key, ...importCaptured(store, group, opts) }));
}
