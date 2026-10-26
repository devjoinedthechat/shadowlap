import { credentialFreeBody, credentialFreeHeaders, formShaped, rawJsonMember, responseBodyWithoutCredentials, resultBlob, withoutCredentials, type Effect } from '@shadowlap/engine';

/**
 * HTTP hosts recorded as tools. Retrieval, vector databases and internal APIs are usually called
 * straight from a client library, not through a wrapped tool, so a replay would call them again.
 * Declared in shadowlap.config.json, `"http": { "*.pinecone.io": "read", "hooks.slack.com": "write" }`,
 * their requests are captured in the agent's process like model calls, and recorded as tool calls
 * named `POST host/path` with the declared effect: replayed before a fork, live (read) or blocked
 * (write) after it.
 */

export interface HttpRule {
  /** `api.example.com`, `*.example.com` (any subdomain), either with an optional `:port`. */
  host: string;
  effect: Effect;
}

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

export function validHttpHost(host: string): boolean {
  return HOST_PATTERN.test(host);
}

/** A rule as [hostname regex source, port or null], for the capture modules. */
export function httpRuleMatcher(rule: HttpRule): [string, string | null] {
  const [hostname, port] = rule.host.split(':') as [string, string | undefined];
  const escaped = hostname.replace(/^\*\./, '').replace(/[.]/g, '\\.');
  return [hostname.startsWith('*.') ? `^([a-z0-9-]+\\.)+${escaped}$` : `^${escaped}$`, port ?? null];
}

export function matchHttpRule(rules: readonly HttpRule[], url: URL): HttpRule | undefined {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return rules.find((rule) => {
    const [source, rulePort] = httpRuleMatcher(rule);
    return new RegExp(source).test(url.hostname.toLowerCase()) && (rulePort === null || rulePort === port);
  });
}

/**
 * The one list of credentials (credentialParam) and the masking built on it live in the engine
 * (engine/src/http.ts), which every copy of a recording reads too; they are named here as well, for
 * the sidecar's own callers.
 */
export { CREDENTIAL_PLACEHOLDER, credentialParam, credentialValue, rawJsonMember, withoutCredentials, withoutStoredCredentials } from '@shadowlap/engine';

/**
 * A request body as stored, and as a live call is matched: decodeBody's, with its credentials masked
 * by the rule a recorded call's arguments are read by (credentialFreeBody), by the body's shape
 * whatever its content type said: a JSON body's credential members (`api_key`, `client_secret`),
 * also in JSON sent as text (a `fetch` string body) or as lines of JSON; a form body's parameters (an
 * OAuth token request's, or a text body written as one); a multipart body's credential fields; XML.
 * A body whose content type says it is a form is masked as one even when its text doesn't read like
 * one. The call is forwarded with the body as it was sent.
 */
export function storedRequestBody(bytes: Buffer, contentType: string | undefined): StoredBody {
  const body = decodeBody(bytes, contentType);
  if (body.encoding === 'text' && /^\s*application\/x-www-form-urlencoded\b/i.test(contentType ?? '') && !formShaped(body.body as string)) return { ...body, body: withoutCredentials(body.body as string) };
  return credentialFreeBody(body);
}

/** A body as stored: parsed JSON, text, or base64 for anything else. */
export interface StoredBody {
  body?: unknown;
  encoding?: 'json' | 'text' | 'base64';
}

export function decodeBody(bytes: Buffer, contentType: string | undefined): StoredBody {
  if (bytes.length === 0) return {};
  const text = bytes.toString('utf8');
  const isText = Buffer.from(text, 'utf8').equals(bytes);
  if (isText && /json/i.test(contentType ?? '')) {
    try {
      return { body: JSON.parse(text), encoding: 'json' };
    } catch {
      // not JSON after all
    }
  }
  if (isText) return { body: text, encoding: 'text' };
  return { body: bytes.toString('base64'), encoding: 'base64' };
}

export function encodeBody(stored: StoredBody): Buffer {
  if (stored.body === undefined) return Buffer.alloc(0);
  if (stored.encoding === 'base64') return Buffer.from(String(stored.body), 'base64');
  if (stored.encoding === 'text') return Buffer.from(String(stored.body), 'utf8');
  return Buffer.from(JSON.stringify(stored.body), 'utf8');
}

/** What a captured HTTP call's result is stored as. */
export interface HttpResult extends StoredBody {
  status: number;
  headers: Record<string, string>;
}

/**
 * A result as a stored blob, `{ "result": … }`. A JSON response's body is written as the text it
 * arrived as, inside the document: its layout, escapes and numbers (a 64-bit id, `20.0`) stay as the
 * service sent them, so a replay can serve those exact bytes (`storedResponseBytes`), while whatever
 * reads the blob as JSON gets the parsed body as before. A copy's rules mask it as they mask any
 * JSON document there, its strings only. The headers are stored as a recording keeps them
 * (credentialFreeHeaders): a token the service hands back in one (`authorization`,
 * `x-subject-token`) is stored as `<CREDENTIAL>`, and a cookie it sets not at all. A token it hands
 * back in its body is stored as `<CREDENTIAL>` too, in place, by the body's shape whatever its
 * content type said (responseBodyWithoutCredentials): an OAuth token response's `access_token` and
 * `refresh_token` in JSON (typed as text, or behind a prefix), a form-encoded answer's token, an
 * event stream's or an STS answer's. The agent gets the response as it came, live.
 */
export function storedResult(result: HttpResult, received: Buffer): Buffer {
  const kept: HttpResult = { ...result, headers: credentialFreeHeaders(result.headers) };
  const { body, ...rest } = kept;
  if (kept.encoding === 'text' && typeof body === 'string') return Buffer.from(JSON.stringify({ result: { ...kept, body: responseBodyWithoutCredentials(Buffer.from(body, 'utf8'), 'text').toString('utf8') } }), 'utf8');
  if (kept.encoding === 'base64' && typeof body === 'string') return Buffer.from(JSON.stringify({ result: { ...kept, body: responseBodyWithoutCredentials(received, 'base64').toString('base64') } }), 'utf8');
  if (kept.encoding !== 'json' || body === undefined) return Buffer.from(JSON.stringify({ result: kept }), 'utf8');
  return resultBlob(rest, responseBodyWithoutCredentials(received, 'json'));
}

/**
 * The bytes a replay answers a stored result with: for a JSON body, its text as the blob holds it
 * (as received, less what a copy's rules masked); otherwise the body encoded again.
 */
export function storedResponseBytes(result: HttpResult, blob: Buffer | null): Buffer {
  if (result.encoding === 'json' && result.body !== undefined && blob) {
    const raw = rawJsonMember(blob.toString('utf8'), ['result', 'body']);
    if (raw !== null) return Buffer.from(raw, 'utf8');
  }
  return encodeBody(result);
}

/** Response headers worth keeping: nothing that sets state in the client or describes the transfer. */
export function keptResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (['set-cookie', 'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(key)) return;
    out[key] = value;
  });
  return out;
}
