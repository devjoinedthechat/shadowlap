import { ACCOUNT_HEADERS } from './account-headers.js';
import { maskEventStream, maskJsonLines, maskMultipart, maskXml, unwrapJson, walkJson, type MultipartPartText } from './credential-shapes.js';
import { parseJsonExact } from './json-exact.js';

/**
 * Credentials in recorded HTTP traffic: which query and form parameters carry one (credentialParam,
 * the one list every part of Shadowlap reads), which headers do, and the stored shapes with them
 * masked. The sidecar masks them before anything is stored, and every copy that leaves the machine
 * (a pack, an HTML report or share link, a push to the team store) masks them again, so a recording
 * made before a name was known to carry one leaves without it all the same.
 */

/**
 * What a credential in a captured call's query string or form body, or in a response header, is
 * stored as. The call is forwarded with the real value; the store, every copy made from it and
 * matching on replay see this.
 */
export const CREDENTIAL_PLACEHOLDER = '<CREDENTIAL>';

/**
 * Last words of a parameter name that make it a credential whatever comes before: `client_secret`,
 * `X-Amz-Signature`, `X-Amz-Credential`, `client_assertion`, `code_verifier`.
 */
const SECRET_LAST = new Set(['secret', 'signature', 'password', 'passwd', 'pwd', 'credential', 'credentials', 'assertion', 'verifier']);
/** Words that make a name a credential wherever they are in it: `password_confirmation`, `secret_id`. */
const SECRET_WORD = new Set(['password', 'passwd', 'passphrase', 'secret']);
/** Whole names (their words run together) that are credentials: `api_key`, `apiKey`, `sig`, `appid`, `auth`. */
const SECRET_NAME = new Set(['apikey', 'appid', 'appkey', 'sig', 'hmac', 'auth', 'authorization', 'proxyauthorization', 'pass', 'passphrase', 'sessionid', 'jsessionid', 'phpsessid', 'jwt', 'bearer']);
/**
 * Whole names that carry a credential as often as a lookup (`?key=AIzaSy…` beside `?key=checkout_v2`
 * for a feature flag, `?code=` for an OAuth code or a country): one is a credential only when its
 * value reads as one (credentialValue), or when no value is given.
 */
const EITHER_NAME = new Set(['key', 'token', 'code']);
/**
 * Words before `key` that make it a credential (`x-api-key`, `Subscription-Key`, `user_key`), unlike
 * a `sort_key` or an `idempotency_key`.
 */
const KEY_OWNER = new Set(['api', 'access', 'app', 'secret', 'private', 'subscription', 'auth', 'client', 'consumer', 'developer', 'dev', 'master', 'admin', 'service', 'account', 'signing', 'session', 'license', 'encryption', 'user']);
/** Words before `token` that make it a pagination cursor, not a credential: `page_token`, `nextPageToken`. */
const CURSOR = ['page', 'next', 'prev', 'previous', 'continuation', 'sync', 'cursor', 'resume', 'start', 'pagination'];
/** Words before `code` that make it a credential (`auth_code`, `device_code`), unlike an `error_code`. */
const CODE_OWNER = new Set(['auth', 'authorization', 'device', 'user', 'otp', 'verification', 'access']);

/** A name's words, as a person reads them: `X-Amz-Security-Token`, `APIToken`, `client_secret`. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether a word that runs its owner and `suffix` together (`accesstoken`, `subscriptionkey`) is a
 * credential: what comes before the suffix is one of `owners`, or for a token anything but a cursor.
 */
function runTogether(word: string, suffix: 'key' | 'token' | 'code'): boolean {
  if (word.length <= suffix.length || !word.endsWith(suffix)) return false;
  const owner = word.slice(0, -suffix.length);
  if (suffix === 'token') return !CURSOR.some((c) => owner.startsWith(c));
  return [...(suffix === 'key' ? KEY_OWNER : CODE_OWNER)].some((w) => owner === w);
}

/**
 * Whether a query or form parameter carries a credential: an API key, a token, a signature, a
 * password. Read by its words, in any case (`api_key`, `apiKey`, `API-KEY`, `X-Amz-Security-Token`,
 * `Ocp-Apim-Subscription-Key`), never by a piece of a word: `monkey`, `keyword`, `tokens` and
 * `author` are not credentials. Narrowly, since a value masked here is left out of matching too, so
 * two calls that differ only in it match the same recorded call: a sort key, a page token or an
 * error code stays a value like any other. A bare `key`, `token` or `code` is a credential when its
 * `value` (decoded) reads as one (credentialValue); with no value given, it is taken for one, as a
 * model call's query takes it.
 */
export function credentialParam(name: string, value?: string): boolean {
  const words = wordsOf(name);
  if (!words.length) return false;
  const joined = words.join('');
  const last = words[words.length - 1]!;
  const before = words.slice(0, -1);
  if (EITHER_NAME.has(joined)) return value === undefined || credentialValue(value);
  if (SECRET_NAME.has(joined) || SECRET_LAST.has(last)) return true;
  if (words.some((w) => SECRET_WORD.has(w) || w.startsWith('password'))) return true;
  if (last === 'key') return before.some((w) => KEY_OWNER.has(w));
  if (last === 'token') return !before.some((w) => CURSOR.includes(w));
  if (last === 'code') return before.some((w) => CODE_OWNER.has(w));
  return runTogether(last, 'key') || runTogether(last, 'token') || runTogether(last, 'code');
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
export function decodedParam(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * URL-encoded parameters (a query string with or without its `?`, or a form body) with the value of
 * each credential (credentialParam, read with its value) replaced by CREDENTIAL_PLACEHOLDER;
 * everything else stays byte for byte, in its order. Applied again, it changes nothing.
 */
export function withoutCredentials(encoded: string): string {
  return encoded.replace(/(^\??|&)([^&=]*)=([^&]*)/g, (whole, lead: string, raw: string, value: string) => {
    if (!value) return whole;
    return credentialParam(decodedParam(raw), decodedParam(value)) ? `${lead}${raw}=${CREDENTIAL_PLACEHOLDER}` : whole;
  });
}

/** A text body written as URL-encoded parameters, as a form body is (`a=1&b=2`): a `=`, and no space, quote or brace. */
export function formShaped(text: string): boolean {
  return text.includes('=') && /^[^\s"{}<>\\^`|]+$/.test(text);
}

/**
 * A parsed JSON value (an object, an array, or a scalar) with the string value of each credential
 * member (credentialParam, read with its value) replaced by CREDENTIAL_PLACEHOLDER, at any depth: an
 * OAuth token response's `access_token`, a request body's `client_secret` or `api_key`. Numbers and
 * the shape stay as they are (copies mask strings only); a value with nothing to mask comes back the
 * same object. For a body stored as text, where the bytes matter, use maskJsonTextCredentials.
 */
export function maskJsonCredentials(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value as unknown[];
    let out: unknown[] | null = null;
    items.forEach((x, i) => {
      const m = maskJsonCredentials(x);
      if (m !== x) (out ??= [...items])[i] = m;
    });
    return out ?? items;
  }
  if (isObject(value)) {
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && v !== CREDENTIAL_PLACEHOLDER && credentialParam(k, v)) (out ??= { ...value })[k] = CREDENTIAL_PLACEHOLDER;
      else {
        const m = maskJsonCredentials(v);
        if (m !== v) (out ??= { ...value })[k] = m;
      }
    }
    return out ?? value;
  }
  return value;
}

/** A string value in a JSON body as a recording keeps it: CREDENTIAL_PLACEHOLDER when its member is a credential (credentialParam, read with it); null to keep it. */
function maskedString(key: string | null, value: string): string | null {
  return key !== null && value !== CREDENTIAL_PLACEHOLDER && credentialParam(key, value) ? CREDENTIAL_PLACEHOLDER : null;
}

/** No member's whole object or array is a credential, read by its name alone. */
const noCredentialMember = () => false;

/**
 * JSON text with the string value of each credential member replaced by `"<CREDENTIAL>"`, every
 * other byte kept (whitespace, numbers of any length such as a 64-bit id or `20.0`, non-credential
 * strings), so a body stored as received can be masked without being re-serialised. Null when it
 * holds no credential to mask, or doesn't read as JSON. Strings only, as a copy masks a JSON
 * document; a credential member whose value is a number is left for the path rules to report.
 */
export function maskJsonTextCredentials(text: string): string | null {
  return walkJson(text, maskedString, noCredentialMember) ?? null;
}

/**
 * A text body, or text read from bytes, with its credentials masked by its shape, whatever its
 * content type said: JSON (also behind a byte-order mark, an anti-XSSI prefix or inside a JSONP
 * call), a form's parameters, a multipart body's fields and parts, an event stream's data, lines of
 * JSON (NDJSON), and XML elements and attributes, each by its name (credentialParam). Every
 * character it doesn't replace stays as it was; null when it replaced nothing.
 */
export function maskTextCredentials(text: string): string | null {
  const wrapped = unwrapJson(text);
  const json = walkJson(wrapped.json, maskedString, noCredentialMember);
  if (json !== undefined) return json === null ? null : wrapped.prefix + json + wrapped.suffix;
  if (formShaped(text)) {
    const masked = withoutCredentials(text);
    return masked === text ? null : masked;
  }
  return (
    maskMultipart(text, maskedPart) ??
    maskEventStream(text, (payload) => maskTextCredentials(payload)) ??
    maskJsonLines(text, (line) => walkJson(line, maskedString, noCredentialMember)) ??
    maskXml(text, (name, value) => credentialParam(name, value), CREDENTIAL_PLACEHOLDER)
  );
}

/**
 * Bytes (a body that isn't UTF-8, stored as base64: one in Latin-1, a JSON document holding raw
 * bytes, a form with a file) with their credentials masked by their shape, as maskTextCredentials
 * masks text: read one byte to a character, so every byte it doesn't replace stays as it was. Null
 * when it replaced nothing.
 */
export function maskBytesCredentials(bytes: Buffer): Buffer | null {
  const masked = maskTextCredentials(bytes.toString('latin1'));
  return masked === null ? null : Buffer.from(masked, 'latin1');
}

/** A parameter of a Content-Disposition value (`name="api_key"`, `filename=a.txt`), quoted or not; undefined when absent. */
function dispositionParam(header: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`, 'i').exec(header);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!.trim();
}

/**
 * A part of a multipart body as a recording keeps it: a credential field's content (a field, not a
 * file, whose name credentialParam reads as one with its content, such as `api_key`) replaced by
 * CREDENTIAL_PLACEHOLDER, and any other part's content masked by its shape (a JSON metadata part).
 */
function maskedPart(part: MultipartPartText): MultipartPartText | null {
  const disposition = /^content-disposition:(.*)$/im.exec(part.headers)?.[1] ?? '';
  const name = dispositionParam(disposition, 'name');
  if (name !== undefined && dispositionParam(disposition, 'filename') === undefined && part.content !== CREDENTIAL_PLACEHOLDER && credentialParam(name, part.content)) return { headers: part.headers, content: CREDENTIAL_PLACEHOLDER };
  const content = maskTextCredentials(part.content);
  return content === null ? null : { headers: part.headers, content };
}

/**
 * A multipart body (`multipart/form-data`, `multipart/related`) with each credential field's content
 * replaced by CREDENTIAL_PLACEHOLDER and every other part masked by its shape (maskedPart). Its
 * boundary is read from the body itself, as a copy that has no content type must, past a preamble,
 * with CRLF or LF line breaks; every other byte (the delimiters, each part's headers, the other
 * fields and files) stays as it was. Null when it holds no credential, or doesn't read as multipart.
 */
export function maskMultipartBytes(bytes: Buffer): Buffer | null {
  const masked = maskMultipart(bytes.toString('latin1'), maskedPart);
  return masked === null ? null : Buffer.from(masked, 'latin1');
}

/**
 * A captured call's stored body (`{ body, encoding }`, as decodeBody stores one) with its credentials
 * masked, the one rule both sides of matching read a body by: a JSON body's credential members (by
 * key, at any depth); a text body by its shape whatever its content type (maskTextCredentials: JSON
 * typed as text or behind a prefix, a form, multipart, lines of JSON, an event stream, XML); bytes
 * stored as base64 the same way, read one byte to a character. The same object when nothing changes.
 */
export function credentialFreeBody<T extends { body?: unknown; encoding?: unknown }>(stored: T): T {
  const { body, encoding } = stored;
  if (encoding === 'json' && body !== undefined) {
    const masked = maskJsonCredentials(body);
    return masked === body ? stored : { ...stored, body: masked };
  }
  if (typeof body !== 'string') return stored;
  if (encoding === 'text') {
    const masked = maskTextCredentials(body);
    return masked === null ? stored : { ...stored, body: masked };
  }
  if (encoding === 'base64') {
    const masked = maskBytesCredentials(Buffer.from(body, 'base64'));
    return masked === null ? stored : { ...stored, body: masked.toString('base64') };
  }
  return stored;
}

/**
 * A captured call's stored arguments (`{ method, url, body?, encoding? }`) as they are matched on
 * replay and as every copy carries them: with the credentials in the URL's query masked
 * (withoutCredentials), and those in its body (credentialFreeBody: a JSON body's credential members,
 * a form's parameters, a multipart body's credential fields), as a call is stored now. The sidecar
 * stores a live call's body by the same rule, so both sides of matching read it alike. A recording
 * made by an earlier version holds them as sent, and so still matches a live call with the same key
 * or a rotated one; a stored call that already reads so comes back as it is (the same object).
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
  return credentialFreeBody(out);
}

/**
 * A model call's query string (`meta.query`, without its `?`) with every credential left out, as
 * the sidecar records one: each parameter credentialParam names, whatever its value (a model API
 * takes no `key` or `token` that is a lookup). The others stay byte for byte, in their order.
 * Undefined when nothing is left.
 */
export function credentialFreeQuery(query: string): string | undefined {
  const kept = query.split('&').filter((part) => {
    if (!part) return false;
    const eq = part.indexOf('=');
    return !credentialParam(decodedParam(eq < 0 ? part : part.slice(0, eq)));
  });
  const out = kept.join('&');
  return out || undefined;
}

/**
 * Response headers whose whole value is a credential: a token a service hands back (OpenStack's
 * `x-subject-token`, Swift's `x-auth-token` and `x-storage-token`, GitLab's `private-token`,
 * OAuth's `x-access-token`/`x-refresh-token`, a CSRF or Vault token), and the request's own
 * credential headers, should a server echo one. Beyond this list, any header `credentialParam` reads
 * as a credential is masked too (credentialHeader), so a service's own `*-token`, `*-key` or
 * `*-secret` header is covered without being named here. A captured call's response keeps each with
 * CREDENTIAL_PLACEHOLDER for its value, so a client that reads its token from one still finds the
 * header on replay. `www-authenticate` and `location` carry a credential inside a larger value
 * (TOKEN_IN_VALUE), masked in place rather than whole.
 */
export const CREDENTIAL_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-subject-token',
  'x-auth-token',
  'x-storage-token',
  'x-access-token',
  'x-refresh-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-vault-token',
  'private-token',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'ocp-apim-subscription-key',
  'x-amz-security-token',
];

/**
 * Response headers whose value holds a credential among other text, masked in place: a `location`
 * that carries an OAuth code or token in its query or fragment, and a `www-authenticate` challenge
 * whose token the server hands back (a Negotiate/NTLM blob, a `token=` parameter).
 */
export const TOKEN_IN_VALUE: Readonly<Record<string, (value: string) => string>> = {
  location: maskLocation,
  'www-authenticate': maskChallenge,
  'proxy-authenticate': maskChallenge,
};

/** Response headers that set state in the client: never stored, nor handed to the agent on replay. */
export const STATE_HEADERS: readonly string[] = ['set-cookie', 'set-cookie2'];

/**
 * Whether a response header's whole value is a credential: one of CREDENTIAL_HEADERS, or a name
 * `credentialParam` reads as one (`x-access-token`, `x-vault-token`, a service's own `*-token` or
 * `*-key`). The explicit list covers `cookie` and the echoed request headers, which read by their
 * words alone aren't credentials.
 */
export function credentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return CREDENTIAL_HEADERS.includes(lower) || credentialParam(lower);
}

/** Credential query and fragment parameters in a (possibly relative) URL masked, by name alone, as a redirect's are. */
export function maskLocation(location: string): string {
  const hash = location.indexOf('#');
  const head = hash < 0 ? location : location.slice(0, hash);
  const q = head.indexOf('?');
  const base = q < 0 ? head : head.slice(0, q + 1) + maskParamsByName(head.slice(q + 1));
  return hash < 0 ? base : `${base}#${maskParamsByName(location.slice(hash + 1))}`;
}

/** `a=b&c=d` with the value of each credential parameter (by name, as a redirect carries one) replaced; the rest byte for byte. */
function maskParamsByName(encoded: string): string {
  return encoded.replace(/(^|&)([^&=]*)=([^&]*)/g, (whole, lead: string, raw: string, value: string) => (value && credentialParam(decodedParam(raw)) ? `${lead}${raw}=${CREDENTIAL_PLACEHOLDER}` : whole));
}

/**
 * An HTTP authentication challenge (`WWW-Authenticate`, `Proxy-Authenticate`) with its credential
 * masked in place: the value of any `name=value` auth-parameter whose name is a credential
 * (`token=…`), quoted or not, and a single token68 blob after the scheme (a Negotiate or NTLM
 * GSSAPI token). The scheme, the realm and an error stay as the server sent them.
 */
export function maskChallenge(value: string): string {
  const params = value.replace(/([A-Za-z][\w-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,]+)/g, (whole, name: string, v: string) => (credentialParam(name) ? `${name}=${v.startsWith('"') ? `"${CREDENTIAL_PLACEHOLDER}"` : CREDENTIAL_PLACEHOLDER}` : whole));
  // A scheme and one token68 blob, the whole value: Negotiate/NTLM hand back a GSSAPI token this way.
  return params.replace(/^(\s*[A-Za-z][\w-]*\s+)([A-Za-z0-9._~+/-]+={0,2})(\s*)$/, (_whole, scheme: string, _token: string, tail: string) => `${scheme}${CREDENTIAL_PLACEHOLDER}${tail}`);
}

/**
 * Headers as a recording keeps them: each credential header (credentialHeader) with
 * CREDENTIAL_PLACEHOLDER for its value, the credential inside a `location` or a challenge masked in
 * place (TOKEN_IN_VALUE), and the headers that set a cookie or name the account a call was made with
 * (ACCOUNT_HEADERS) left out. Names are read in any case. The same object when nothing changes.
 */
export function credentialFreeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  let out: Record<string, string> | null = null;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const state = STATE_HEADERS.includes(lower) || ACCOUNT_HEADERS.includes(lower);
    const inValue = !state ? TOKEN_IN_VALUE[lower] : undefined;
    const credential = !state && !inValue && credentialHeader(lower) && value !== CREDENTIAL_PLACEHOLDER;
    const masked = inValue ? inValue(value) : value;
    if (!state && !credential && masked === value) continue;
    out ??= { ...headers };
    if (state) delete out[name];
    else out[name] = credential ? CREDENTIAL_PLACEHOLDER : masked;
  }
  return out ?? headers;
}

const WS = new Set([' ', '\t', '\n', '\r']);
/** A JSON number or literal, matched where it stands. */
const SCALAR = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

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
    // A number of any length (a 450-digit one reads like any other), read where it stands.
    SCALAR.lastIndex = i;
    const m = SCALAR.exec(text);
    if (!m) return false;
    i += m[0].length;
    return true;
  };
  for (let depth = 0; depth < path.length; depth++) {
    ws();
    if (text[i] !== '{') return null;
    i++;
    // Left only by the break at the key (or a return): past the loop, the key was found.
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
      if (name === path[depth]) break;
      if (!value()) return null;
      ws();
      if (text[i] === ',') i++;
      else return null;
    }
    if (depth === path.length - 1) {
      const start = i;
      if (!value()) return null;
      ws();
      return text[i] === ',' || text[i] === '}' ? text.slice(start, i) : null;
    }
  }
  return null;
}

/**
 * A captured call's result as a stored blob, `{ "result": … }`, from the result without its body
 * and, for a JSON response, the body's text as it arrived (`rawBody`): written inside the document
 * as it was, so its layout, escapes and numbers (a 64-bit id, `20.0`) stay as the service sent them.
 */
export function resultBlob(rest: Readonly<Record<string, unknown>>, rawBody: Buffer | string): Buffer {
  const head = JSON.stringify({ result: rest });
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return Buffer.concat([Buffer.from(`${head.slice(0, -2)}${Object.keys(rest).length ? ',' : ''}"body":`, 'utf8'), body, Buffer.from('}}', 'utf8')]);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a call is a captured HTTP call (a host under "http" in the config), recorded as a tool call. */
export function capturedHttp(call: { kind: string; meta: Readonly<Record<string, unknown>> }): boolean {
  return call.kind === 'tool' && typeof call.meta.http === 'string';
}

/**
 * A captured call's stored request (`{ "args": { method, url, body?, encoding? } }`) with the
 * credentials in its URL's query and its body masked (withoutStoredCredentials), its numbers as
 * written; null when it holds none to mask (or is no such request).
 */
export function credentialFreeRequest(bytes: Buffer): Buffer | null {
  let doc: unknown;
  try {
    doc = parseJsonExact(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!isObject(doc) || !('args' in doc)) return null;
  const args = withoutStoredCredentials(doc.args);
  return args === doc.args ? null : Buffer.from(JSON.stringify({ ...doc, args }), 'utf8');
}

/**
 * A captured call's stored result (`{ "result": { status, headers, body?, encoding? } }`) as a
 * recording keeps it: its headers as credentialFreeHeaders keeps them, and its body with its
 * credentials masked in place by its shape, whatever its content type said (an OAuth token
 * response's `access_token` in JSON, typed as text or behind a prefix; a form-encoded answer's
 * token; an event stream's; an STS answer's XML), every other byte as the service sent it; null when
 * it holds nothing to mask (or is no such result).
 */
export function credentialFreeResult(bytes: Buffer): Buffer | null {
  const text = bytes.toString('utf8');
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(doc) || !isObject(doc.result) || !isObject(doc.result.headers)) return null;
  const result = doc.result;
  const headers = result.headers as Record<string, string>;
  if (!Object.values(headers).every((v) => typeof v === 'string')) return null;
  const kept = credentialFreeHeaders(headers);
  const { body, ...rest } = result;
  const next = { ...rest, headers: kept };
  if (result.encoding === 'json' && body !== undefined) {
    const raw = rawJsonMember(text, ['result', 'body']);
    if (raw !== null) {
      const masked = maskJsonTextCredentials(raw);
      return kept === headers && masked === null ? null : resultBlob(next, masked ?? raw);
    }
  }
  const maskedBody = typeof body === 'string' && (result.encoding === 'text' || result.encoding === 'base64') ? maskedResponseBody(body, result.encoding) : body;
  if (kept === headers && maskedBody === body) return null;
  return Buffer.from(JSON.stringify({ result: maskedBody === undefined ? next : { ...next, body: maskedBody } }), 'utf8');
}

/** A stored text or base64 response body with its credentials masked by its shape; the same string when there are none. */
function maskedResponseBody(body: string, encoding: 'text' | 'base64'): string {
  if (encoding === 'text') return maskTextCredentials(body) ?? body;
  return maskBytesCredentials(Buffer.from(body, 'base64'))?.toString('base64') ?? body;
}

/**
 * A captured call's response body, as received, with its credentials masked in place, by its shape
 * whatever its content type said: for a JSON body, the string value of each credential member
 * (maskJsonTextCredentials); for text, as maskTextCredentials reads it (JSON typed as text or behind
 * a prefix, a form-encoded answer, an event stream, lines of JSON, XML); for bytes that aren't
 * UTF-8, the same, read one byte to a character. Every other byte as sent; the bytes as they are
 * when nothing is masked.
 */
export function responseBodyWithoutCredentials(received: Buffer, encoding: unknown): Buffer {
  if (encoding === 'json') {
    const masked = maskJsonTextCredentials(received.toString('utf8'));
    return masked === null ? received : Buffer.from(masked, 'utf8');
  }
  if (encoding === 'text') {
    const masked = maskTextCredentials(received.toString('utf8'));
    return masked === null ? received : Buffer.from(masked, 'utf8');
  }
  if (encoding === 'base64') return maskBytesCredentials(received) ?? received;
  return received;
}
