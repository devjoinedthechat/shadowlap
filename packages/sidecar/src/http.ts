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
