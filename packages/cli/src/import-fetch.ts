import { isLoopbackHost } from './loopback.js';

/**
 * Reading a trace store's API (Langfuse, LangSmith) with the keys on this machine. The keys go to
 * the host named and nowhere else; they are never stored, logged or put in an error message.
 */

export interface TraceStoreOptions {
  /** The API's base URL, e.g. `https://cloud.langfuse.com` or a self-hosted instance. */
  host: string;
  /** For tests: what to send requests with. */
  fetch?: typeof fetch;
  /** Per request; 30 seconds by default. */
  timeoutMs?: number;
}

/** The most one response may hold: a trace of thousands of observations fits many times over. */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * A trace store's base URL, checked: http or https, no user name or password in it, and https
 * unless it is this machine, because the keys travel with every request. `allowHttp` accepts plain
 * http anywhere, for a self-hosted instance on a network the person trusts.
 */
export function traceStoreHost(raw: string, what: string, allowHttp = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--host: ${what} needs a URL such as https://${what === 'Langfuse' ? 'cloud.langfuse.com' : 'api.smith.langchain.com'}, not "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`--host: ${what} is reached over https, not ${url.protocol}`);
  if (url.username || url.password) throw new Error('--host: leave credentials out of the URL; the keys come from the environment');
  if (url.protocol === 'http:' && !allowHttp && !isLoopbackHost(url.hostname)) {
    throw new Error(`--host: use https for ${url.host}: the keys would cross the network in the clear. http is accepted for this machine, or with --allow-http on a network you trust`);
  }
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/+$/, '');
}

/** GETs or POSTs JSON. A refusal is reported with the message given for its status, never with the request. */
export async function fetchJson(o: TraceStoreOptions, path: string, init: RequestInit, refusals: Record<number, string> = {}): Promise<unknown> {
  const url = `${o.host}${path}`;
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'it did not answer in time' : err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new Error(`could not reach ${new URL(o.host).host}: ${reason}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(refusals[res.status] ?? `${new URL(o.host).host} answered ${res.status} ${res.statusText}`.trim());
  }
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new Error(`${new URL(o.host).host} sent ${length} bytes, more than a trace should take`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`${new URL(o.host).host} sent more than a trace should take`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${new URL(o.host).host} did not answer with JSON: is ${o.host} the API's address?`);
  }
}
