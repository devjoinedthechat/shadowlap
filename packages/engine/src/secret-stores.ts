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
 *   with a `version` number): that inner `data`, every field of it; and version 1, whose answer has
 *   no shape of its own, when the masking is told the call read a path under `/v1/secret/`, where
 *   Vault mounts it by default (vaultKv1Read): the answer's `data`, unless it is a list of the
 *   secrets' names (`"data": {"keys": […]}`), which `names` reads.
 *
 * What says which secret it is stays as it was: its name, id, type, metadata, attributes and tags.
 * The masking (http.ts) reads each such value as it reads a credential member's, every string in it.
 */

/** A Secret Manager version's name, in a location or not: `projects/<project>/secrets/<secret>/versions/<version>`. */
const GCP_VERSION = /^projects\/[^/\s]+(?:\/locations\/[^/\s]+)?\/secrets\/[^/\s]+\/versions\/[^/\s]+$/;
/** A Key Vault secret's id, its version after it or not, in any of Azure's clouds: `https://<vault>.vault.azure.net/secrets/<name>/<version>`. */
const AZURE_SECRET = /^https:\/\/[\w-]+\.vault\.(?:azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de)(?::443)?\/secrets\/[^/\s]+(?:\/[^/\s]*)?$/i;
/** A captured call's name (`GET host/path`) for a path under `/v1/secret/`. */
const VAULT_KV1 = /^[A-Z]+ [^/\s]+\/v1\/secret\//;

/**
 * Whether a captured call (by its name, `GET vault.example.com:8200/v1/secret/db`) read a path under
 * `/v1/secret/`, where Vault mounts its KV secrets engine by default: version 1 answers with the
 * secret as its `data`, with no other shape to say so.
 */
export function vaultKv1Read(callName: string): boolean {
  return VAULT_KV1.test(callName);
}

/**
 * Whether a text can hold an answer secretStoreValues reads (a Kubernetes kind, a secret's address,
 * a versioned `metadata`), looked for cheaply, so most texts are read no further.
 */
export function mayHoldSecrets(text: string): boolean {
  return text.includes('"Secret') || text.includes('/secrets/') || text.includes('\\/secrets\\/') || (text.includes('"metadata"') && text.includes('"version"'));
}

/** Members whose values a rule may hold a secret in, noted by where each starts. */
const HOLDERS = new Set(['data', 'stringData', 'value', 'dataCrc32c']);
/** Members whose strings say what an object is: a Kubernetes object's `kind`, a version's `name`, a Key Vault secret's `id`. */
const NAMING = new Set(['kind', 'name', 'id']);
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
  /** Its `kind`, `name` and `id`, each a string. */
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
  readonly vaultKv1: boolean;
  readonly names: StringTest;
  /** The value it began at is read. */
  done: boolean;
}

/**
 * Where the JSON value that starts at `start` in `text` holds a secret by the shapes above
 * (HeldValues): every string in each value a credential, but a Vault KV version 1 list of names
 * (with `vaultKv1`), whose strings are one only when `names` passes one of them. Read once, in time
 * linear in the text, by the grammar walkValue reads JSON by, so it stops where that walk stops; an
 * object the text ends in, or stops being JSON in, is read by what it held before there.
 */
export function secretStoreValues(text: string, start: number, vaultKv1: boolean, names: StringTest): HeldValues {
  const r: Reader = { text, i: start, stack: [], held: new Map(), vaultKv1, names, done: false };
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

/** Marks where `frame`, an object read, holds a secret by its shape (the shapes above). */
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
  if (r.vaultKv1 && !parent && !frame.kv2) {
    if (frame.names === undefined) append(found, starts('data'));
    else if (!r.held.has(frame.names)) r.held.set(frame.names, r.names);
  }
  for (const at of found) r.held.set(at, true);
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
