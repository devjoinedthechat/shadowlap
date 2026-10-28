import { setOwn } from './canonical.js';
import { parseJsonExact } from './json-exact.js';
import type { StoreOf } from './store.js';
import { isObject } from './is-object.js';

/**
 * Request manifests. Every model request resends the whole conversation, so whole-request blobs
 * never deduplicate. A request is stored as its growing list (the messages, Gemini's contents, the
 * Responses API's input items) one item per blob, the members every call repeats (the system prompt,
 * the tools) one blob each, and a manifest naming them: a run of n calls stores each turn once, not n
 * times. Reconstruction is semantic, not byte-for-byte, which is sufficient because only responses
 * are ever served.
 */

/** Version 1: a body with a `messages` array. Still written for those, and always read. */
interface ChunkedManifest {
  v: 1;
  kind: 'chunked';
  fields: Record<string, unknown>;
  system: string | null;
  tools: string | null;
  messages: string[];
}

/**
 * Version 2: a body whose growing list is Gemini's `contents` or the Responses API's `input` (or
 * `messages`, which version 1 writes). `parts` names the members stored apart, each by its blob.
 * The list's item hashes are held in runs, each a blob of its own (a JSON array of item hashes), in
 * order: written with lengths that are the binary digits of the list's length, largest first, so
 * every call of a conversation shares each run that lies within the turns it has in common with an
 * earlier one, and a run's manifests together grow as n·log n in its turns rather than n², as a list
 * of every item's hash in each manifest would.
 */
interface ListManifest {
  v: 2;
  kind: 'list';
  fields: Record<string, unknown>;
  parts: Record<string, string>;
  list: ListMember;
  runs: string[];
}

interface WholeManifest {
  v: 1;
  kind: 'whole';
  blob: string;
  /** How to decode the blob. */
  encoding: 'json' | 'utf8' | 'base64';
}

export type RequestManifest = ChunkedManifest | ListManifest | WholeManifest;

type ListMember = 'messages' | 'contents' | 'input';

/** For each growing list, the members a body repeats from call to call, which are stored apart: these and no others. */
const PARTS: Readonly<Record<ListMember, readonly string[]>> = {
  messages: ['system', 'tools'],
  contents: ['systemInstruction', 'system_instruction', 'tools'],
  input: ['instructions', 'tools'],
};

function isConversationShaped(body: unknown): body is { messages: unknown[]; system?: unknown; tools?: unknown } & Record<string, unknown> {
  return isObject(body) && Array.isArray(body.messages);
}

/** The list a body that is no `messages` conversation grows by: Gemini's `contents`, the Responses API's `input` items. */
function listOf(body: unknown): 'contents' | 'input' | null {
  if (!isObject(body) || Array.isArray(body.messages)) return null;
  if (Array.isArray(body.contents)) return 'contents';
  if (Array.isArray(body.input)) return 'input';
  return null;
}

/** Stores an API request body (parsed JSON, or raw text/bytes) and returns the manifest's hash. */
export function storeApiRequest(store: StoreOf<'recording'>, body: unknown): string {
  let manifest: RequestManifest;
  const list = listOf(body);
  if (isConversationShaped(body)) {
    const { messages, system, tools, ...fields } = body;
    manifest = {
      v: 1,
      kind: 'chunked',
      fields,
      system: system === undefined ? null : store.putJson(system),
      tools: tools === undefined ? null : store.putJson(tools),
      messages: messages.map((m) => store.putJson(m)),
    };
  } else if (list && isObject(body)) {
    const fields: Record<string, unknown> = {};
    const parts: Record<string, string> = {};
    for (const [name, value] of Object.entries(body)) {
      if (name === list) continue;
      if (PARTS[list].includes(name) && value !== undefined) setOwn(parts, name, store.putJson(value));
      else setOwn(fields, name, value);
    }
    manifest = { v: 2, kind: 'list', fields, parts, list, runs: runsOf(store, (body[list] as unknown[]).map((item) => store.putJson(item))) };
  } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    manifest = { v: 1, kind: 'whole', blob: store.putBlob(body), encoding: 'base64' };
  } else if (typeof body === 'string') {
    manifest = { v: 1, kind: 'whole', blob: store.putBlob(Buffer.from(body, 'utf8')), encoding: 'utf8' };
  } else {
    manifest = { v: 1, kind: 'whole', blob: store.putJson(body), encoding: 'json' };
  }
  return store.putJson(manifest);
}

/** Item hashes as runs whose lengths are the binary digits of their count, largest first (13 items: runs of 8, 4 and 1). */
function runsOf(store: StoreOf<'recording'>, hashes: string[]): string[] {
  const runs: string[] = [];
  let at = 0;
  for (let size = 2 ** Math.floor(Math.log2(Math.max(hashes.length, 1))); size >= 1; size /= 2) {
    if (hashes.length - at < size) continue;
    runs.push(store.putJson(hashes.slice(at, at + size)));
    at += size;
  }
  return runs;
}

/** A run's item hashes, as a version 2 manifest names them; refused unless it is a list of hashes. */
function runItems(store: StoreOf<'recording'>, run: string): string[] {
  const items = store.getJson<unknown>(run);
  if (!Array.isArray(items) || items.some((h) => typeof h !== 'string')) throw new Error(`request run ${run}: ${items === null ? 'missing' : 'not a list of blob hashes'}`);
  return items as string[];
}

/**
 * A version 2 manifest as it must read: a list it knows, parts it knows for that list, each a hash.
 * A pack is untrusted, so anything else is refused, never guessed at.
 */
function checkedList(m: Record<string, unknown>, ref: string): ListManifest {
  const bad = (why: string) => new Error(`request manifest ${ref}: ${why}`);
  const list = m.list;
  if (list !== 'messages' && list !== 'contents' && list !== 'input') throw bad(`its list is ${JSON.stringify(list)}, not messages, contents or input`);
  if (!isObject(m.fields)) throw bad('its fields are not an object');
  if (!Array.isArray(m.runs) || m.runs.some((h) => typeof h !== 'string')) throw bad('its runs are not a list of blob hashes');
  if (!isObject(m.parts)) throw bad('its parts are not an object');
  for (const [name, h] of Object.entries(m.parts)) {
    if (!PARTS[list].includes(name)) throw bad(`it stores "${name}" apart, which a ${list} request never does`);
    if (typeof h !== 'string') throw bad(`its part "${name}" is not a blob hash`);
  }
  return m as unknown as ListManifest;
}

/**
 * Reconstructs the request body stored under a manifest hash. `exact` reads each number as it was
 * stored (parseJsonExact), an id past 2^53 by its digits: for fingerprinting it, and for sending it
 * again; without it, every number is the double JSON.parse reads.
 */
export function loadApiRequest(store: StoreOf<'recording'>, manifestRef: string, opts: { exact?: boolean } = {}): unknown {
  const manifest = store.getJson<RequestManifest>(manifestRef);
  if (!manifest) throw new Error(`missing request manifest ${manifestRef}`);
  const json = (hash: string): unknown => {
    if (!opts.exact) return store.getJson(hash);
    const bytes = store.getBlob(hash);
    return bytes === null ? null : parseJsonExact(bytes.toString('utf8'));
  };
  if (manifest.v === 2) {
    const m = checkedList(manifest as unknown as Record<string, unknown>, manifestRef);
    const body: Record<string, unknown> = { ...m.fields };
    for (const [name, hash] of Object.entries(m.parts)) setOwn(body, name, required(store, hash, json));
    setOwn(body, m.list, m.runs.flatMap((run) => runItems(store, run)).map((h) => required(store, h, json)));
    return opts.exact ? exactFields(store, manifestRef, body, m.list, Object.keys(m.parts)) : body;
  }
  if (manifest.v !== 1) throw new Error(`request manifest ${manifestRef} is version ${JSON.stringify((manifest as { v?: unknown }).v)}, which this Shadowlap doesn't read`);
  if (manifest.kind === 'whole') {
    const bytes = store.getBlob(manifest.blob);
    if (!bytes) throw new Error(`missing blob ${manifest.blob}`);
    if (manifest.encoding === 'json') return opts.exact ? parseJsonExact(bytes.toString('utf8')) : JSON.parse(bytes.toString('utf8'));
    if (manifest.encoding === 'utf8') return bytes.toString('utf8');
    return bytes;
  }
  const body: Record<string, unknown> = { ...manifest.fields };
  if (manifest.system !== null) body.system = json(manifest.system);
  if (manifest.tools !== null) body.tools = json(manifest.tools);
  body.messages = manifest.messages.map((h) => json(h));
  return opts.exact ? exactFields(store, manifestRef, body, 'messages', ['system', 'tools']) : body;
}

/**
 * A request read exactly, its other fields (`model`, `max_tokens`, a seed) read from the manifest's
 * own text as written too: the manifest holds them inline, and getJson read them as doubles.
 */
function exactFields(store: StoreOf<'recording'>, manifestRef: string, body: Record<string, unknown>, list: string, parts: readonly string[]): Record<string, unknown> {
  const text = store.getBlob(manifestRef)?.toString('utf8');
  const manifest = text ? (parseJsonExact(text) as { fields?: unknown }) : null;
  if (!manifest || typeof manifest.fields !== 'object' || manifest.fields === null) return body;
  const out: Record<string, unknown> = { ...(manifest.fields as Record<string, unknown>) };
  for (const name of [...parts, list]) if (Object.hasOwn(body, name)) setOwn(out, name, body[name]);
  return out;
}

/** A part of a version 2 request: its blob must be there, as a pack's reader checks every blob a manifest names. */
function required(store: StoreOf<'recording'>, hash: string, json: (hash: string) => unknown = (h) => store.getJson(h)): unknown {
  const value = json(hash);
  if (value === null && !store.getBlob(hash)) throw new Error(`missing blob ${hash}`);
  return value;
}

/** The blob hashes a stored request references (none when the manifest is missing or malformed). */
export function manifestRefs(store: StoreOf<'recording'>, manifestRef: string): string[] {
  let manifest: RequestManifest | null;
  try {
    manifest = store.getJson<RequestManifest>(manifestRef);
  } catch {
    return [];
  }
  if (!manifest || typeof manifest !== 'object') return [];
  if (manifest.kind === 'whole') return typeof manifest.blob === 'string' ? [manifest.blob] : [];
  if (manifest.kind === 'chunked') return [manifest.system, manifest.tools, ...(Array.isArray(manifest.messages) ? manifest.messages : [])].filter((h): h is string => typeof h === 'string');
  if (manifest.kind === 'list') {
    const runs = Array.isArray(manifest.runs) ? manifest.runs.filter((h): h is string => typeof h === 'string') : [];
    const items = runs.flatMap((run) => {
      try {
        return runItems(store, run);
      } catch {
        return [];
      }
    });
    return [...(isObject(manifest.parts) ? Object.values(manifest.parts) : []), ...runs, ...items].filter((h): h is string => typeof h === 'string');
  }
  return [];
}

/**
 * Brings every blob a stored request needs into `store` by `bring` (which puts one there and says
 * whether it is there now): its manifest's parts and runs, then the items the runs name, which can
 * only be listed once a run is in. A pack's reader brings a request so. Whether every one is there.
 */
export function bringRequest(store: StoreOf<'recording'>, manifestRef: string, bring: (hash: string) => boolean): boolean {
  let all = true;
  const seen = new Set<string>();
  for (let more = true; more; ) {
    more = false;
    for (const h of manifestRefs(store, manifestRef)) {
      if (seen.has(h)) continue;
      seen.add(h);
      if (bring(h)) more = true;
      else all = false;
    }
  }
  return all;
}

