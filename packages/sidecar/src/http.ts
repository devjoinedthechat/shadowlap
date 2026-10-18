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

/**
 * A result as a stored blob, `{ "result": … }`. A JSON response's body is written as the text it
 * arrived as, inside the document: its layout, escapes and numbers (a 64-bit id, `20.0`) stay as the
 * service sent them, so a replay can serve those exact bytes (`storedResponseBytes`), while whatever
 * reads the blob as JSON gets the parsed body as before. A copy's rules mask it as they mask any
 * JSON document there, its strings only.
 */
export function storedResult(result: HttpResult, received: Buffer): Buffer {
  const { body: _body, ...rest } = result;
  if (result.encoding !== 'json' || result.body === undefined) return Buffer.from(JSON.stringify({ result }), 'utf8');
  const head = JSON.stringify({ result: rest });
  return Buffer.concat([Buffer.from(`${head.slice(0, -2)}${Object.keys(rest).length ? ',' : ''}"body":`, 'utf8'), received, Buffer.from('}}', 'utf8')]);
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

const WS = new Set([' ', '\t', '\n', '\r']);

/**
 * The text of the value at `path` in a JSON document, with the whitespace around it, as written; null
 * when the document doesn't read as JSON there or has no such member.
 */
export function rawJsonMember(text: string, path: readonly string[]): string | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && WS.has(text[i]!)) i++;
  };
  /** Moves past one string, from its opening quote; returns its text with the quotes. */
  const string = (): string | null => {
    const start = i;
    if (text[i] !== '"') return null;
    for (i++; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return text.slice(start, ++i);
    }
    return null;
  };
  /** Moves past one value; false when it isn't JSON. */
  const value = (): boolean => {
    ws();
    const c = text[i];
    if (c === '"') return string() !== null;
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) return ++i > 0;
      for (;;) {
        if (c === '{') {
          ws();
          if (string() === null) return false;
          ws();
          if (text[i++] !== ':') return false;
        }
        if (!value()) return false;
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === close) return ++i > 0;
        else return false;
      }
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (!m) return false;
    i += m[0].length;
    return true;
  };
  for (let depth = 0; depth < path.length; depth++) {
    ws();
    if (text[i] !== '{') return null;
    i++;
    let found = false;
    for (;;) {
      ws();
      if (text[i] === '}') return null;
      const key = string();
      if (key === null) return null;
      ws();
      if (text[i++] !== ':') return null;
      let name: unknown;
      try {
        name = JSON.parse(key);
      } catch {
        return null;
      }
      if (name === path[depth]) {
        found = true;
        break;
      }
      if (!value()) return null;
      ws();
      if (text[i] === ',') i++;
      else return null;
    }
    if (!found) return null;
    if (depth === path.length - 1) {
      const start = i;
      if (!value()) return null;
      ws();
      return text[i] === ',' || text[i] === '}' ? text.slice(start, i) : null;
    }
  }
  return null;
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
