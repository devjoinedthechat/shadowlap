import { CliError, EXIT } from './exit-codes.js';
import { isLoopbackHost } from './loopback.js';

/**
 * Reading a trace store's API (Langfuse, LangSmith, Phoenix, Logfire) with the keys on this
 * machine. The keys go to the host named and nowhere else; they are never stored, logged or put in
 * an error message.
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

/** An address each trace store's --host takes, for the message about one that isn't a URL. */
const EXAMPLES: Record<string, string> = {
  Langfuse: 'https://cloud.langfuse.com',
  LangSmith: 'https://api.smith.langchain.com',
  Phoenix: 'http://localhost:6006 or https://app.phoenix.arize.com/s/your-space',
  Logfire: 'https://logfire-eu.pydantic.dev',
};

export interface HostCheck {
  /** What named the address, for a refusal to name: `--host` (the default), or the variable that held it. */
  from?: string;
  /** Accept plain http to any host: `--allow-http`, or a store sent nothing secret. */
  allowHttp?: boolean;
  /** What the requests carry that plain http would show, for its refusal: `the keys` (the default), `the read token`. */
  secret?: string;
}

/**
 * A trace store's base URL, checked: http or https, no user name or password in it, and https
 * unless it is this machine, because the keys travel with every request. `allowHttp` accepts plain
 * http anywhere, for a self-hosted instance on a network the person trusts. A refusal starts with
 * what named the address; one the environment named is never repeated, since it may hold a password.
 */
export function traceStoreHost(raw: string, what: string, o: HostCheck = {}): string {
  const from = o.from ?? '--host';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${from}: ${what} needs a URL such as ${EXAMPLES[what] ?? 'https://api.example.com'}${from === '--host' ? `, not "${raw}"` : ''}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${from}: ${what} is reached over https, not ${url.protocol}`);
  if (url.username || url.password) throw new Error(`${from}: leave credentials out of the URL; the keys come from the environment`);
  if (url.protocol === 'http:' && !o.allowHttp && !isLoopbackHost(url.hostname)) {
    throw new Error(`${from}: use https for ${url.host}: ${o.secret ?? 'the keys'} would cross the network in the clear. http is accepted for this machine, or with --allow-http on a network you trust`);
  }
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/+$/, '');
}

/**
 * A trace store that refused, failed or did not answer, with its HTTP status (null for none) and
 * the exit status it ends the import with: what this machine is set up with (keys refused, no such
 * project or trace, an address that isn't the API) is 2; a store that didn't answer, or failed, is 1.
 * `ofTrace` marks a failure that is the one trace's (there is no trace of that id, or it is more than
 * an import reads): an import of the traces in a window skips that trace and goes on, where any other
 * failure stops it.
 */
export class TraceStoreError extends CliError {
  readonly status: number | null;
  readonly ofTrace: boolean;

  constructor(message: string, status: number | null, o: { exitCode?: number; ofTrace?: boolean } = {}) {
    super(o.exitCode ?? (status === null || status === 429 || status >= 500 ? EXIT.failed : EXIT.usage), message);
    this.name = 'TraceStoreError';
    this.status = status;
    this.ofTrace = o.ofTrace === true;
  }
}

/** GETs or POSTs JSON. A refusal is reported with the message given for its status, never with the request. */
export async function fetchJson(o: TraceStoreOptions, path: string, init: RequestInit, refusals: Record<number, string> = {}): Promise<unknown> {
  const url = `${o.host}${path}`;
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'it did not answer in time' : err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new TraceStoreError(`could not reach ${new URL(o.host).host}: ${reason}`, null);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new TraceStoreError(refusals[res.status] ?? `${new URL(o.host).host} answered ${res.status} ${res.statusText}`.trim(), res.status);
  }
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new TraceStoreError(`${new URL(o.host).host} sent ${length} bytes, more than a trace should take`, null, { ofTrace: true });
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new TraceStoreError(`${new URL(o.host).host} sent more than a trace should take`, null, { ofTrace: true });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TraceStoreError(`${new URL(o.host).host} did not answer with JSON: is ${o.host} the API's address?`, null, { exitCode: EXIT.usage });
  }
}
