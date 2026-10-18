import type { Effect } from '@shadowlap/engine';

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
 * What a credential in a captured call's query string or form body is stored as. The call is
 * forwarded with the real value; the store, every copy made from it and matching on replay see this.
 */
export const CREDENTIAL_PLACEHOLDER = '<CREDENTIAL>';

/** Last words of a parameter name that make it a credential whatever comes before: `client_secret`, `X-Amz-Signature`. */
const SECRET_LAST = new Set(['secret', 'signature', 'password', 'passwd', 'pwd', 'credential', 'credentials']);
/** Whole names (their words run together) that are credentials: `api_key`, `apiKey`, `sig`, `appid`. */
const SECRET_NAME = new Set(['apikey', 'appid', 'appkey', 'sig', 'hmac', 'auth', 'authorization', 'pass', 'passphrase', 'sessionid', 'jsessionid', 'phpsessid']);
/**
 * Whole names that carry a credential as often as a lookup (`?key=AIzaSy…` beside `?key=checkout_v2`
 * for a feature flag or a cache entry): one is a credential only when its value reads as one
 * (credentialValue).
 */
const EITHER_NAME = new Set(['key', 'token']);
/** Words before `key` that make it a credential (`x-api-key`, `Subscription-Key`), unlike a `sort_key` or an `idempotency_key`. */
const KEY_OWNER = new Set(['api', 'access', 'app', 'secret', 'private', 'subscription', 'auth', 'client', 'consumer', 'developer', 'dev', 'master', 'admin', 'service', 'account', 'signing']);
/** Words before `token` that make it a pagination cursor, not a credential: `page_token`, `nextPageToken`. */
const CURSOR = new Set(['page', 'next', 'prev', 'previous', 'continuation', 'sync', 'cursor', 'resume', 'start', 'pagination']);

/**
 * Whether a query or form parameter carries a credential: an API key, a token, a signature, a
 * password. Read by its words (`api_key`, `apiKey`, `X-Amz-Security-Token`), and narrowly: a value
 * masked here is left out of matching too, so two calls that differ only in it would match the same
 * recorded call. A sort key, a page token or an author stays a value like any other. A bare `key` or
 * `token` is a credential when its `value` (decoded) reads as one (credentialValue); with no value
 * given, it is taken for one.
 */
export function credentialParam(name: string, value?: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return false;
  const last = words[words.length - 1]!;
  const before = words.slice(0, -1);
  if (EITHER_NAME.has(words.join(''))) return value === undefined || credentialValue(value);
  if (SECRET_NAME.has(words.join('')) || SECRET_LAST.has(last)) return true;
  if (last === 'key') return before.some((w) => KEY_OWNER.has(w));
  if (last === 'token') return !before.some((w) => CURSOR.has(w));
  return false;
}

/** A part of a value that reads as written by a person: a word (`checkout`, `Refund`, `EU`), a number, or a short tag (`v2`). */
const WORDLIKE = /^(?:[a-z]{1,20}|[A-Z][a-z]{0,19}|[A-Z]{1,20}|\d{1,20}|[A-Za-z]{1,2}\d{1,3})$/;

/**
 * Whether a value reads as a credential rather than a name looked up: 16 characters or more, with a
 * part between its punctuation that is no word or number (WORDLIKE), as in an API key (`AIzaSy…`,
 * `sk_live_51H…`), a hex or base64 token or a JWT. `checkout_v2`, `checkout_redesign_2026` and
 * `user:12345:settings` read as names.
 */
export function credentialValue(value: string): boolean {
  if (value.length < 16) return false;
  return value.split(/[^A-Za-z0-9]+/).some((part) => part !== '' && !WORDLIKE.test(part));
}

/** A URL-encoded name or value as text: `+` a space, `%xx` its character; as it is when it doesn't decode. */
function decoded(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * URL-encoded parameters (a query string with or without its `?`, or a form body) with the value of
 * each credential (credentialParam) replaced by CREDENTIAL_PLACEHOLDER; everything else stays byte
 * for byte, in its order. Applied again, it changes nothing.
 */
export function withoutCredentials(encoded: string): string {
  return encoded.replace(/(^\??|&)([^&=]*)=([^&]*)/g, (whole, lead: string, raw: string, value: string) => {
    if (!value) return whole;
    return credentialParam(decoded(raw), decoded(value)) ? `${lead}${raw}=${CREDENTIAL_PLACEHOLDER}` : whole;
  });
}

/** A text body written as URL-encoded parameters, as a form body is (`a=1&b=2`): a `=`, and no space, quote or brace. */
function formShaped(text: string): boolean {
  return text.includes('=') && /^[^\s"{}<>\\^`|]+$/.test(text);
}

/**
 * A request body as stored: decodeBody's, with the credentials of a form body
 * (`application/x-www-form-urlencoded`, an OAuth token request's `client_secret`, or a text body
 * written as one) masked as a query string's are (withoutCredentials). The call is forwarded with
 * the body as it was sent.
 */
export function storedRequestBody(bytes: Buffer, contentType: string | undefined): StoredBody {
  const body = decodeBody(bytes, contentType);
  if (body.encoding !== 'text') return body;
  const text = body.body as string;
  if (!/^\s*application\/x-www-form-urlencoded\b/i.test(contentType ?? '') && !formShaped(text)) return body;
  return { ...body, body: withoutCredentials(text) };
}

/**
 * A captured call's stored arguments (`{ method, url, body?, encoding? }`) as they are matched on
 * replay: with the credentials in the URL's query and in a text body written as URL-encoded
 * parameters masked (withoutCredentials), as a call is stored now. A recording made by an earlier
 * version holds them as sent, and so still matches a live call with the same key or a rotated one;
 * a stored call that already reads so comes back as it is.
 */
export function withoutStoredCredentials(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  const stored = args as Record<string, unknown>;
  let out = stored;
  if (typeof stored.url === 'string' && stored.url.includes('?')) {
    const at = stored.url.indexOf('?');
    const url = stored.url.slice(0, at) + withoutCredentials(stored.url.slice(at));
    if (url !== stored.url) out = { ...out, url };
  }
  if (stored.encoding === 'text' && typeof stored.body === 'string' && formShaped(stored.body)) {
    const body = withoutCredentials(stored.body);
    if (body !== stored.body) out = { ...out, body };
  }
  return out;
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

/** Response headers worth keeping: nothing that sets state in the client or describes the transfer. */
export function keptResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (['set-cookie', 'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(key)) return;
    out[key] = value;
  });
  return out;
}
