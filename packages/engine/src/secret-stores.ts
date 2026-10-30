import { isJsonSpace, NUMBER_OR_LITERAL, type HeldValues, type StringTest } from './credential-shapes.js';

/**
 * Where a secret store's answer holds the secret it hands back under a member whose name says
 * nothing of one (`data`, `value`, `payload`), read from the shape of the object around it:
 *
 * - a Kubernetes Secret (`"kind": "Secret"`, before its `data` or after it, as kubectl sorts it):
 *   its `data` and `stringData`, every entry (`password`, `tls.key`, `.dockerconfigjson`); a
 *   SecretList's items' too, which name no kind of their own;
 * - a version of a Google Cloud Secret Manager secret (a `name` of `projects/…/secrets/…/versions/…`):
 *   its `payload`'s `data`, and `dataCrc32c`, the checksum that would confirm a guess of it;
 * - an Azure Key Vault secret (an `id` under `https://….vault.azure.net/secrets/`): its `value`;
 * - HashiCorp Vault's KV secrets engine, version 2 (a `data` member holding `data` and a `metadata`
 *   with a `version` number): that inner `data`, every field of it.
 *
 * And where a call to a secret store holds one by the call itself (StoreCall), in what it sends and
 * in an answer of no shape of its own: a write's secret, and a Vault KV version 1 answer's.
 *
 * What says which secret it is stays as it was: its name, id, type, metadata, attributes and tags.
 * The masking (http.ts) reads each such value as it reads a credential member's, every string in it.
 */

/** A Secret Manager version's name, in a location or not: `projects/<project>/secrets/<secret>/versions/<version>`. */
const GCP_VERSION = /^projects\/[^/\s]+(?:\/locations\/[^/\s]+)?\/secrets\/[^/\s]+\/versions\/[^/\s]+$/;
/** A Key Vault secret's id, its version after it or not, in any of Azure's clouds: `https://<vault>.vault.azure.net/secrets/<name>/<version>`. */
const AZURE_SECRET = /^https:\/\/[\w-]+\.vault\.(?:azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de)(?::443)?\/secrets\/[^/\s]+(?:\/[^/\s]*)?$/i;

/**
 * Where a captured call to a secret store holds a secret by the call itself, the body's shape saying
 * nothing of one: read from the call's name (`PUT acme.vault.azure.net/secrets/db`, its method, host
 * and path) and whether the body is what the call sends or the answer it gets (storeCall).
 *
 * What a call sends:
 * - `whole`: every string in it: a write to Vault's KV engine, version 1, at `secret/`, where Vault
 *   mounts it by default, or at `cubbyhole/`; and what `sys/wrapping/wrap` wraps;
 * - `kv2`: the `data` a write to the KV engine, version 2, sends at any mount (`/v1/<mount>/data/…`),
 *   beside its `options` alone;
 * - `value`: an Azure Key Vault secret's `value` a write sends, and a certificate's an import does;
 * - `payload`: the `payload` Secret Manager's `:addVersion` sends, its `data` and `dataCrc32c`;
 * - `kubernetes`: the `data` and `stringData` a Kubernetes Secret's create, replace or patch sends,
 *   with a kind or none, and the value a JSON patch puts under them.
 *
 * The answer it gets:
 * - `kv1`: the `data` of the answer to a read under `secret/` or `cubbyhole/`, as KV version 1
 *   answers with the secret, but a list of the secrets' names (`{"keys": […]}`), which `names` reads;
 * - `mount`: as `kv1`, at any other path whose answer names its mount `kv` (`"mount_type": "kv"`), but
 *   a path of version 2's own (KV2_OWN), whose answers hold metadata;
 * - `unwrap`: all of the `data` `sys/wrapping/unwrap` hands back.
 */
export type StoreCall = 'whole' | 'kv2' | 'value' | 'payload' | 'kubernetes' | 'kv1' | 'mount' | 'unwrap';

/** A captured call's name: its method, its host (and port), and the path it asked for. */
const CALL_NAME = /^([A-Z]+) ([^/\s]+)(\/[^]*)?$/;
/** The methods that send a body to write. */
const WRITES = new Set(['POST', 'PUT', 'PATCH']);
/** A path's segments under a KV engine, version 2, that are its own (`/v1/<mount>/metadata/…`): what follows them names a secret, never holds one. */
const KV2_OWN = new Set(['data', 'metadata', 'config', 'subkeys', 'delete', 'undelete', 'destroy']);
/** An Azure Key Vault's host, in any of Azure's clouds. */
const KEY_VAULT_HOST = /^[\w-]+\.vault\.(?:azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de)(?::443)?$/i;
/** A Key Vault path a write sends a secret to: a secret (a version after it or not, or a backup restored), a certificate imported. */
const KEY_VAULT_WRITE = /^\/(?:secrets\/[^/]+(?:\/[^/]*)?|certificates\/[^/]+\/import)$/;
/** Secret Manager's `:addVersion`, in a location or not, from any host (a regional or private endpoint). */
const ADD_VERSION = /^\/v1(?:beta\d+)?\/projects\/[^/]+(?:\/locations\/[^/]+)?\/secrets\/[^/:]+:addVersion$/;
/** A Kubernetes Secret, or the Secrets of a namespace, behind a proxy's path or not. */
const KUBERNETES_SECRET = /\/api\/v1\/namespaces\/[^/]+\/secrets(?:\/[^/]+)?$/;

/**
 * How a captured call (by its name, `PUT vault.example.com:8200/v1/secret/data/db`) holds a secret
 * by the call itself (StoreCall), in what it sends (`sent`) or in its answer; null for a call whose
 * body's shape says it all.
 */
export function storeCall(callName: string, sent: boolean): StoreCall | null {
  const m = CALL_NAME.exec(callName);
  if (!m) return null;
  const [, method = '', host = '', path = '/'] = m;
  const vault = path.startsWith('/v1/') ? path.slice(4).split('/') : null;
  if (!sent) return vault && vaultAnswer(vault);
  if (!WRITES.has(method)) return null;
  if (KEY_VAULT_HOST.test(host) && KEY_VAULT_WRITE.test(path)) return 'value';
  if (ADD_VERSION.test(path)) return 'payload';
  if (KUBERNETES_SECRET.test(path)) return 'kubernetes';
  return vault && vaultWrite(vault);
}

/** How the answer to a Vault path (its segments after `/v1/`) holds a secret by the path. */
function vaultAnswer([mount, ...rest]: readonly string[]): StoreCall | null {
  if (mount === 'sys') return rest.join('/') === 'wrapping/unwrap' ? 'unwrap' : null;
  if (!rest.length) return null;
  if (mount === 'secret' || mount === 'cubbyhole') return 'kv1';
  return rest.some((segment) => KV2_OWN.has(segment)) ? null : 'mount';
}

/** How what a write to a Vault path (its segments after `/v1/`) sends holds a secret by the path. */
function vaultWrite(segments: readonly string[]): StoreCall | null {
  const [mount, first] = segments;
  if (mount === 'sys') return segments.join('/') === 'sys/wrapping/wrap' ? 'whole' : null;
  if (first !== undefined && (mount === 'cubbyhole' || (mount === 'secret' && !KV2_OWN.has(first)))) return 'whole';
  return segments.slice(1, -1).includes('data') ? 'kv2' : null;
}

/**
 * Whether a text can hold an answer secretStoreValues reads (a Kubernetes kind, a secret's address,
 * a versioned `metadata`), looked for cheaply, so most texts are read no further.
 */
export function mayHoldSecrets(text: string): boolean {
  return text.includes('"Secret') || text.includes('/secrets/') || text.includes('\\/secrets\\/') || (text.includes('"metadata"') && text.includes('"version"'));
}

/** Members whose values a rule may hold a secret in, noted by where each starts; and a KV version 2 write's `options`, which may stand beside its `data`. */
const HOLDERS = new Set(['data', 'stringData', 'value', 'dataCrc32c', 'options']);
/**
 * Members whose strings say what an object is: a Kubernetes object's `kind`, a version's `name`, a
 * Key Vault secret's `id`, the mount a Vault answer names (`mount_type`), and where a JSON patch's
 * operation puts its value (`path`).
 */
const NAMING = new Set(['kind', 'name', 'id', 'mount_type', 'path']);
/** Where a JSON patch's operation puts a Kubernetes Secret's secret: under its `data` or `stringData`. */
const SECRET_PATCH = /^\/(?:data|stringData)(?:\/|$)/;
/** The longest such string read: any of them is far shorter. */
const NAMING_MAX = 2048;
/** The characters JSON escapes with a backslash, `\u` aside. */
const ESCAPED = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
/** The four hex digits of a `\u` escape. */
const HEX4 = /^[0-9A-Fa-f]{4}$/;

/** An object or an array the reader is inside, with what it noted of it for the rules. */
interface Open {
  object: boolean;
  /** An object's member read now; an array's, the member it is the value of. */
  key: string | null;
  expect: 'key' | 'colon' | 'value' | 'comma';
  first: boolean;
  /** How many members an object has. */
  members: number;
  /** Its strings in NAMING: `kind`, `name`, `id`, `mount_type`, `path`. */
  named?: Map<string, string>;
  /** Where the values of its members in HOLDERS start (a member written twice, each). */
  starts?: Map<string, number[]>;
  /** It holds a number named `version`. */
  version?: true;
  /** Its `metadata` holds a number named `version`. */
  versioned?: true;
  /** Where its `keys` array starts. */
  keys?: number;
  /** Where its `payload` holds a secret: that payload's `data` and `dataCrc32c`. */
  payload?: number[];
  /** Where its items hold one, should it be a list of Secrets: each item's `data` and `stringData`. */
  items?: number[];
  /** Its `data` is Vault KV version 2's (it holds `data` and a versioned `metadata`). */
  kv2?: true;
  /** Where its `data`'s list of names starts, when `data` is that list alone (`{"keys": […]}`). */
  names?: number;
}

/** The reader's place in the text, what it is inside, and the values it found holding a secret. */
interface Reader {
  readonly text: string;
  i: number;
  readonly stack: Open[];
  readonly held: Map<number, true | StringTest>;
  /** How the call the text is the body of holds a secret (StoreCall), when the masking is told. */
  readonly call: StoreCall | null;
  readonly names: StringTest;
  /** The value it began at is read. */
  done: boolean;
}

/**
 * Where the JSON value that starts at `start` in `text` holds a secret by the shapes above
 * (HeldValues), and by `call`, how the call the text is the body of holds one (StoreCall): every
 * string in each value a credential, but a Vault KV version 1 list of names, whose strings are one
 * only when `names` passes one of them. Read once, in time linear in the text, by the grammar
 * walkValue reads JSON by, so it stops where that walk stops; an object the text ends in, or stops
 * being JSON in, is read by what it held before there. All of what a call sends `whole` is held, and
 * read no further.
 */
export function secretStoreValues(text: string, start: number, call: StoreCall | null, names: StringTest): HeldValues {
  const r: Reader = { text, i: start, stack: [], held: new Map(), call, names, done: false };
  if (call === 'whole') {
    while (r.i < text.length && isJsonSpace(text.charCodeAt(r.i))) r.i++;
    r.held.set(r.i, true);
    return r.held;
  }
  for (let more = true; more && !r.done; ) more = step(r);
  while (r.stack.length) closeTop(r);
  return r.held;
}

/** Reads the next token: false where the text ends or stops being JSON. */
function step(r: Reader): boolean {
  while (r.i < r.text.length && isJsonSpace(r.text.charCodeAt(r.i))) r.i++;
  if (r.i >= r.text.length) return false;
  const top = r.stack[r.stack.length - 1];
  if (top?.expect === 'colon') {
    if (r.text[r.i] !== ':') return false;
    r.i++;
    top.expect = 'value';
    return true;
  }
  if (top?.expect === 'comma') return comma(r, top);
  if (top?.expect === 'key') return member(r, top);
  return value(r, top);
}

/** After a value in `top`: a comma, or its close. */
function comma(r: Reader, top: Open): boolean {
  const c = r.text[r.i];
  if (c === ',') {
    r.i++;
    top.expect = top.object ? 'key' : 'value';
    top.first = false;
    return true;
  }
  if (c !== (top.object ? '}' : ']')) return false;
  r.i++;
  closeTop(r);
  return true;
}

/** A member's name in `top`, or the close of an object with none. */
function member(r: Reader, top: Open): boolean {
  if (r.text[r.i] === '}' && top.first) {
    r.i++;
    closeTop(r);
    return true;
  }
  if (r.text[r.i] !== '"') return false;
  const end = stringEnd(r.text, r.i);
  if (end < 0) return false;
  top.key = decoded(r.text.slice(r.i, end));
  top.members++;
  top.expect = 'colon';
  r.i = end;
  return true;
}

/** A value: at the top, an array's item, or an object member's. */
function value(r: Reader, top: Open | undefined): boolean {
  const { text } = r;
  const at = r.i;
  const c = text[at];
  if (top && !top.object && c === ']' && top.first) {
    r.i++;
    closeTop(r);
    return true;
  }
  if (c === '{' || c === '[') {
    if (top) noted(r, top, at, at + 1);
    r.stack.push({ object: c === '{', key: c === '{' ? null : (top?.key ?? null), expect: c === '{' ? 'key' : 'value', first: true, members: 0 });
    r.i++;
    return true;
  }
  NUMBER_OR_LITERAL.lastIndex = at;
  const end = c === '"' ? stringEnd(text, at) : (NUMBER_OR_LITERAL.exec(text)?.[0].length ?? -1) + at;
  if (end <= at) return false;
  r.i = end;
  if (top) noted(r, top, at, end);
  ended(r, top);
  return true;
}

/** After a value in `top`: a comma or a close is next; with none, the value read is the one it began at. */
function ended(r: Reader, top: Open | undefined): void {
  if (top) top.expect = 'comma';
  else r.done = true;
}

/**
 * The value of `top`'s member from `at` to `end` (an object or an array, its first character): where
 * it starts, for a member a rule may mask; a `kind`, `name` or `id` string; a number named `version`;
 * a `keys` array.
 */
function noted(r: Reader, top: Open, at: number, end: number): void {
  const key = top.key;
  if (!top.object || key === null) return;
  const c = r.text[at]!;
  if (HOLDERS.has(key)) {
    top.starts ??= new Map();
    const starts = top.starts.get(key);
    if (starts) starts.push(at);
    else top.starts.set(key, [at]);
  }
  if (key === 'keys' && c === '[') top.keys = at;
  else if (key === 'version' && (c === '-' || (c >= '0' && c <= '9'))) top.version = true;
  else if (c === '"' && NAMING.has(key) && end - at <= NAMING_MAX) (top.named ??= new Map()).set(key, decoded(r.text.slice(at, end)));
}

/** The object or array just closed: the rules read an object, and what they read of it is passed to the value it is in. */
function closeTop(r: Reader): void {
  const frame = r.stack.pop()!;
  const parent = r.stack[r.stack.length - 1];
  if (frame.object) {
    markHeld(r, frame, parent);
    passUp(frame, parent);
  } else if (parent?.object && parent.key === 'items' && frame.items) append((parent.items ??= []), frame.items);
  ended(r, parent);
}

/**
 * Marks where `frame`, an object read, holds a secret by its shape (the shapes above), and by the
 * call (StoreCall): the body's own object, or an operation of the JSON patch the body is.
 */
function markHeld(r: Reader, frame: Open, parent: Open | undefined): void {
  const kind = frame.named?.get('kind');
  const name = frame.named?.get('name');
  const id = frame.named?.get('id');
  const starts = (key: string) => frame.starts?.get(key) ?? [];
  const found: number[] = [];
  if (kind === 'Secret') append(found, starts('data'), starts('stringData'));
  if (kind === 'SecretList' && frame.items) append(found, frame.items);
  if (name !== undefined && frame.payload && GCP_VERSION.test(name)) append(found, frame.payload);
  if (id !== undefined && AZURE_SECRET.test(id)) append(found, starts('value'));
  if (frame.versioned && parent?.object && parent.key === 'data') append(found, starts('data'));
  if (!parent) heldByCall(r, frame, found);
  else if (r.call === 'kubernetes' && !parent.object && r.stack.length === 1 && SECRET_PATCH.test(frame.named?.get('path') ?? '')) append(found, starts('value'));
  for (const at of found) r.held.set(at, true);
}

/** Notes in `found` where `frame`, the object a call's body is, holds a secret by the call (StoreCall); a list of names, where `names` reads it. */
function heldByCall(r: Reader, frame: Open, found: number[]): void {
  const starts = (key: string) => frame.starts?.get(key) ?? [];
  const call = r.call;
  if (call === 'kv1' || (call === 'mount' && frame.named?.get('mount_type') === 'kv')) {
    if (frame.kv2) return;
    if (frame.names === undefined) append(found, starts('data'));
    else if (!r.held.has(frame.names)) r.held.set(frame.names, r.names);
  } else if (call === 'unwrap') append(found, starts('data'));
  else if (call === 'kv2') {
    // Its data, an object, beside its options alone.
    const data = starts('data');
    if (data.length === 1 && r.text[data[0]!] === '{' && frame.members === 1 + starts('options').length) append(found, data);
  } else if (call === 'value') append(found, starts('value'));
  else if (call === 'payload') append(found, frame.payload ?? []);
  else if (call === 'kubernetes') append(found, starts('data'), starts('stringData'));
}

/** What a rule reading `parent` needs of `frame`, its current member's value or one of its items. */
function passUp(frame: Open, parent: Open | undefined): void {
  if (!parent) return;
  const starts = (key: string) => frame.starts?.get(key) ?? [];
  if (!parent.object) {
    if (parent.key === 'items') append((parent.items ??= []), starts('data'), starts('stringData'));
  } else if (parent.key === 'payload') append((parent.payload ??= []), starts('data'), starts('dataCrc32c'));
  else if (parent.key === 'metadata' && frame.version) parent.versioned = true;
  else if (parent.key === 'data') {
    if (frame.versioned && frame.starts?.has('data')) parent.kv2 = true;
    if (frame.members === 1 && frame.keys !== undefined) parent.names = frame.keys;
  }
}

/** Adds each number of `lists` to `to`, one at a time: a list of thousands spread would take as many arguments. */
function append(to: number[], ...lists: ReadonlyArray<readonly number[]>): void {
  for (const list of lists) for (const n of list) to.push(n);
}

/**
 * The index just past the JSON string token that opens at `from`, or -1 when it doesn't end or isn't
 * one JSON reads (a control character in it, an escape JSON has none of), as walkValue's reading of
 * it stops there.
 */
function stringEnd(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) return i + 1;
    if (c < 0x20) return -1;
    if (c !== 0x5c) continue;
    const e = text[++i];
    if (e === 'u' ? !HEX4.test(text.slice(i + 1, i + 5)) : e === undefined || !ESCAPED.has(e)) return -1;
    if (e === 'u') i += 4;
  }
  return -1;
}

/** A JSON string token's text: read by JSON only when it escapes a character. */
function decoded(token: string): string {
  return token.includes('\\') ? (JSON.parse(token) as string) : token.slice(1, -1);
}
