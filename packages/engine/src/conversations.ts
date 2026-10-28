import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.js';
import { normalizeConversation, type TurnBlock } from './conversation.js';
import { deepEqual } from './diff.js';
import { loadApiRequest, type RequestManifest } from './manifest.js';
import { normalizeResponse } from './responses.js';
import { parseSse } from './sse.js';
import type { Store, StoreOf } from './store.js';
import type { CallRecord } from './types.js';
import { isObject } from './is-object.js';

/**
 * Conversations within a run. A run can hold many: an overnight batch works through forty tickets
 * in one process, each its own conversation, and a multi-agent run has one per agent at least.
 *
 * A model request continues a conversation when it extends that conversation's latest request in
 * the same scope: the messages (Gemini's contents, the Responses API's input items) sent last time
 * come first again, with the answer and what followed it appended. Cache breakpoints, thinking
 * blocks and Gemini's thought signatures are left out of the comparison, because agents move or drop
 * them from one request to the next. A request that extends no open conversation starts a new one;
 * so does one that repeats another conversation's request word for word, unless that request
 * failed (then it is a retry). Weaker links keep a conversation together when its history was
 * edited: only the first message changed (a system message with the time in it); the request
 * carries tool-use ids the conversation issued (an agent that drops its oldest turns); or it
 * carries the conversation's last answer right after the history it kept (an agent that strips a
 * reminder from earlier messages, trims an old tool result or completes a prefill). The Responses
 * API's `previous_response_id` and `conversation` name the conversation outright. Each scope's
 * conversations are indexed by what a request can continue them by, so a run of thousands of
 * conversations is read in time proportional to its requests.
 *
 * Every other call belongs to the conversation of the model call that asked for it: a tool call is
 * matched to the latest tool request of the same name in its scope, with the same arguments when
 * one has them, and keeps the provider's tool-use id when there is one. A call no model asked for
 * goes with the tool call that was running when it started (an HTTP request a tool sends), else
 * with the latest model call in its scope while a tool that call asked for has not run yet, else
 * with the next model call, which it feeds (the ticket fetched before the first model call).
 */

export interface CallConversation {
  /** The conversation the call belongs to, numbered from 1 in the order they start; null when it belongs to none. */
  conversation: number | null;
  /** A model call whose request starts its conversation. */
  starts: boolean;
  /** A tool call: the model call whose response asked for it, when one did. */
  requestedBy: number | null;
  /** A tool call: the id the provider gave that request (`toolu_…`, `call_…`), when it gave one. */
  toolUseId: string | null;
}

export interface ConversationSpan {
  n: number;
  /** The scope its model calls were made in, or null. */
  scope: string | null;
  /** The model call that starts it. */
  firstCallNo: number;
  /** The last call that belongs to it, of any kind. */
  lastCallNo: number;
  modelCalls: number;
  /** Calls of every kind that belong to it. */
  calls: number;
}

export interface RunConversations {
  conversations: ConversationSpan[];
  /** Every call of the run, by call number. */
  byCall: Map<number, CallConversation>;
  /** Model calls placed by their own request: the requests that show a conversation as it stood. */
  requests: ReadonlySet<number>;
}

export interface ConversationOptions {
  /**
   * Also place tool calls and every other call, which reads model responses. Without it only model
   * calls are placed, from their requests alone, which is all the cache-miss rule needs.
   */
  attribute?: boolean;
}

const NONE: CallConversation = Object.freeze({ conversation: null, starts: false, requestedBy: null, toolUseId: null });

/** Requests that are not a turn of a conversation: embeddings, token counts, model listings, moderation. */
const NOT_A_CONVERSATION = /embed|count_?tokens|countTokens|\/moderations\b|\/models\/?(?:\?|$)|\/rerank\b/i;

/** Whether a model call's request can be part of a conversation at all. */
export function conversationRequest(call: Pick<CallRecord, 'kind' | 'name' | 'requestRef'>): boolean {
  return call.kind === 'api' && !!call.requestRef && !call.name.startsWith('GET ') && !NOT_A_CONVERSATION.test(call.name);
}

const scopeOf = (c: CallRecord): string => (typeof c.meta.scope === 'string' ? c.meta.scope : '');

// ---- caches ---------------------------------------------------------------------------------------

/** A Map that forgets its least recently used entries past `max`. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
}

interface ItemInfo {
  /** The item without its per-request decorations, hashed. */
  hash: string;
  /** Tool-use and tool-result ids it carries. */
  ids: string[];
  /** For an assistant turn, what it said and asked for, comparable with a response's. */
  sig: string[] | null;
  /** A reasoning item (Responses API): left out of the comparison. */
  skip: boolean;
}

interface Digest {
  items: ItemInfo[];
  previousResponseId: string | null;
  conversationId: string | null;
  /** The system prompt sent beside the items (Anthropic's `system`, Gemini's `systemInstruction`, the Responses API's `instructions`), hashed. */
  frame: string | null;
}

export interface RequestedTool {
  name: string;
  input: unknown;
  id: string | null;
}

interface ResponseInfo {
  /** What the response said and asked for, comparable with an assistant turn. */
  sig: string[];
  tools: RequestedTool[];
}

interface StoreCaches {
  /** Message blobs by hash: content-addressed, so an entry never goes stale. */
  items: Lru<string, ItemInfo>;
  /** Requests stored whole (Gemini, the Responses API) by manifest hash. */
  wholes: Lru<string, Digest | null>;
  responses: Lru<string, ResponseInfo>;
  /** Response ids (the Responses API's `resp_…`), read only when a request names a previous response. */
  responseIds: Lru<string, string | null>;
  runs: Lru<string, RunConversations>;
}

const caches = new WeakMap<object, StoreCaches>();
function cachesFor(store: StoreOf<never>): StoreCaches {
  let c = caches.get(store);
  if (!c) {
    c = { items: new Lru(50_000), wholes: new Lru(5_000), responses: new Lru(20_000), responseIds: new Lru(5_000), runs: new Lru(32) };
    caches.set(store, c);
  }
  return c;
}

/**
 * What a run's calls amount to now: a call or an end row arriving changes it, so an analysis made
 * before is not reused for a run that is still recording.
 */
export function runStamp(calls: readonly CallRecord[]): string {
  let ends = 0;
  let last = 0;
  for (const c of calls) {
    if (c.end) ends++;
    last = Math.max(last, c.at, c.end?.at ?? 0);
  }
  return `${calls.length}:${ends}:${last}`;
}

// ---- requests -------------------------------------------------------------------------------------

/** Parts of a turn that agents add, move or drop between requests without changing the conversation. */
const DECORATIONS = new Set(['cache_control', 'thoughtSignature', 'thought_signature']);

function isReasoning(v: unknown): boolean {
  return isObject(v) && (v.type === 'thinking' || v.type === 'redacted_thinking' || v.type === 'reasoning' || v.thought === true || isObject(v.reasoningContent));
}

function undecorated(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => !isReasoning(x)).map(undecorated);
  if (!isObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!DECORATIONS.has(k)) out[k] = undecorated(x);
  return out;
}

function collectIds(v: unknown, out: string[]): void {
  if (Array.isArray(v)) {
    for (const x of v) collectIds(x, out);
    return;
  }
  if (!isObject(v)) return;
  const id = (x: unknown) => {
    if (typeof x === 'string' && x) out.push(x);
  };
  if (v.type === 'tool_use' || v.type === 'server_tool_use') id(v.id);
  if (v.type === 'tool_result') id(v.tool_use_id);
  if (v.role === 'tool') id(v.tool_call_id);
  if (Array.isArray(v.tool_calls)) for (const tc of v.tool_calls) if (isObject(tc)) id(tc.id);
  if (typeof v.type === 'string' && /^(?:function|custom_tool|computer|local_shell)_call(?:_output)?$/.test(v.type)) id(v.call_id);
  if (isObject(v.toolUse)) id(v.toolUse.toolUseId);
  if (isObject(v.toolResult)) id(v.toolResult.toolUseId);
  if (isObject(v.functionCall)) id(v.functionCall.id);
  if (isObject(v.functionResponse)) id(v.functionResponse.id);
  if (Array.isArray(v.content)) collectIds(v.content, out);
  if (Array.isArray(v.parts)) collectIds(v.parts, out);
}

function canonical(v: unknown): string {
  try {
    return canonicalize(v);
  } catch {
    return JSON.stringify(v) ?? 'null';
  }
}

function blockSig(b: TurnBlock | { type: string; text?: string; name?: string; input?: unknown }): string | null {
  if (b.type === 'text' && 'text' in b && typeof b.text === 'string') return b.text.trim() ? `t:${b.text.trim()}` : null;
  if (b.type === 'tool_call' && 'name' in b) return `c:${String(b.name)}:${canonical(b.input ?? {})}`;
  return null;
}

type Shape = 'messages' | 'contents' | 'input';

function itemInfo(item: unknown, shape: Shape): ItemInfo {
  const skip = isObject(item) && item.type === 'reasoning';
  const ids: string[] = [];
  collectIds(item, ids);
  let sig: string[] | null = null;
  if (!skip) {
    try {
      const turn = normalizeConversation({ [shape]: [item] })?.turns.at(-1);
      if (turn?.role === 'assistant') sig = turn.blocks.map(blockSig).filter((s): s is string => s !== null);
    } catch {
      // an item no shape reads: compared by its hash alone
    }
  }
  return { hash: createHash('sha256').update(canonical(undecorated(item))).digest('base64url').slice(0, 24), ids, sig, skip };
}

function listOf(body: Record<string, unknown>): { list: unknown[]; shape: Shape } | null {
  if (Array.isArray(body.messages)) return { list: body.messages, shape: 'messages' };
  if (Array.isArray(body.contents)) return { list: body.contents, shape: 'contents' };
  if (typeof body.input === 'string') return { list: [{ role: 'user', content: body.input }], shape: 'input' };
  if (Array.isArray(body.input)) return { list: body.input, shape: 'input' };
  if (typeof body.prompt === 'string') return { list: [{ role: 'user', content: body.prompt }], shape: 'messages' };
  return null;
}

function idField(v: unknown): string | null {
  if (typeof v === 'string' && v) return v;
  if (isObject(v) && typeof v.id === 'string' && v.id) return v.id;
  return null;
}

/** A model request reduced to what continuity needs; null when it is not a conversation. */
function digest(store: StoreOf<'recording'>, call: CallRecord, cache: StoreCaches): Digest | null {
  if (!conversationRequest(call)) return null;
  const ref = call.requestRef!;
  let manifest: RequestManifest | null;
  try {
    manifest = store.getJson<RequestManifest>(ref);
  } catch {
    return null;
  }
  if (!isObject(manifest)) return null;
  if (manifest.kind === 'chunked' && Array.isArray(manifest.messages)) {
    // Each message is its own blob: one parse per distinct message across the whole store.
    const items: ItemInfo[] = [];
    for (const hash of manifest.messages) {
      let info = cache.items.get(hash);
      if (!info) {
        let message: unknown = null;
        try {
          message = store.getJson(hash);
        } catch {
          // a missing blob still holds its place
        }
        info = itemInfo(message, 'messages');
        cache.items.set(hash, info);
      }
      items.push(info);
    }
    return { items, previousResponseId: null, conversationId: null, frame: typeof manifest.system === 'string' ? manifest.system : null };
  }
  const known = cache.wholes.get(ref);
  if (known !== undefined) return known;
  let d: Digest | null = null;
  try {
    const body = loadApiRequest(store, ref);
    const found = isObject(body) ? listOf(body) : null;
    if (found && isObject(body)) {
      const system = body.systemInstruction ?? body.instructions ?? body.system;
      d = {
        items: found.list.map((item) => itemInfo(item, found.shape)),
        previousResponseId: idField(body.previous_response_id),
        conversationId: idField(body.conversation),
        frame: system === undefined || system === null ? null : createHash('sha256').update(canonical(undecorated(system))).digest('base64url').slice(0, 24),
      };
    }
  } catch {
    d = null;
  }
  cache.wholes.set(ref, d);
  return d;
}

// ---- responses ------------------------------------------------------------------------------------

/**
 * Tool-use ids in a streamed response, in the order its tool calls appear. normalizeResponse keeps
 * the ids of a JSON response; a stream spreads them over its events.
 */
function streamedToolIds(bytes: Buffer): string[] {
  const ids: Array<[number, string]> = [];
  const seen = new Set<string>();
  let order = 0;
  const add = (key: string, id: unknown, at: number) => {
    if (typeof id !== 'string' || !id || seen.has(key)) return;
    seen.add(key);
    ids.push([at, id]);
  };
  for (const e of parseSse(bytes)) {
    const d = e.data;
    if (!isObject(d)) continue;
    // Anthropic: the block's index orders it.
    if (d.type === 'content_block_start' && isObject(d.content_block) && (d.content_block.type === 'tool_use' || d.content_block.type === 'server_tool_use')) {
      add(`a${String(d.index)}`, d.content_block.id, typeof d.index === 'number' ? d.index : order++);
    }
    // OpenAI Chat Completions: the first chunk of each tool call carries its id.
    if (Array.isArray(d.choices)) {
      for (const ch of d.choices) {
        const calls = isObject(ch) && isObject(ch.delta) && Array.isArray(ch.delta.tool_calls) ? ch.delta.tool_calls : [];
        for (const tc of calls) if (isObject(tc)) add(`o${String(tc.index ?? 0)}`, tc.id, 1e6 + order++);
      }
    }
    // The Responses API: each function call is announced as an output item.
    if (d.type === 'response.output_item.added' && isObject(d.item) && d.item.type === 'function_call') add(`r${String(d.output_index ?? order)}`, d.item.call_id, 2e6 + order++);
    // Gemini, when it numbers its function calls.
    if (Array.isArray(d.candidates) && isObject(d.candidates[0]) && isObject(d.candidates[0].content) && Array.isArray(d.candidates[0].content.parts)) {
      for (const p of d.candidates[0].content.parts) if (isObject(p) && isObject(p.functionCall)) add(`g${order}`, p.functionCall.id, 3e6 + order++);
    }
  }
  return ids.sort((a, b) => a[0] - b[0]).map(([, id]) => id);
}

/** A response's own id: `resp_…` from the Responses API, which a later request names as `previous_response_id`. */
function responseIdOf(store: StoreOf<'recording'>, call: CallRecord): string | null {
  const end = call.end;
  if (call.kind !== 'api' || !end?.responseRef || end.outcome !== 'ok') return null;
  const cache = cachesFor(store);
  const known = cache.responseIds.get(end.responseRef);
  if (known !== undefined) return known;
  let id: string | null = null;
  try {
    const bytes = store.getBlob(end.responseRef);
    if (bytes?.length) {
      if (end.meta.headers?.['content-type']?.includes('text/event-stream')) {
        for (const e of parseSse(bytes)) {
          const d = e.data;
          if (!isObject(d)) continue;
          const found = isObject(d.response) ? d.response.id : isObject(d.message) ? d.message.id : d.id;
          if (typeof found === 'string' && found) {
            id = found;
            break;
          }
        }
      } else {
        const body = JSON.parse(bytes.toString('utf8')) as unknown;
        id = isObject(body) && typeof body.id === 'string' ? body.id : null;
      }
    }
  } catch {
    id = null;
  }
  cache.responseIds.set(end.responseRef, id);
  return id;
}

const EMPTY_RESPONSE: ResponseInfo = Object.freeze({ sig: [], tools: [] });

/** What a model call's response said and which tools it asked for; cached by response blob. */
export function responseInfo(store: StoreOf<'recording'>, call: CallRecord): ResponseInfo {
  const end = call.end;
  if (call.kind !== 'api' || !end?.responseRef || end.outcome !== 'ok') return EMPTY_RESPONSE;
  const cache = cachesFor(store);
  const known = cache.responses.get(end.responseRef);
  if (known) return known;
  let info = EMPTY_RESPONSE;
  try {
    const bytes = store.getBlob(end.responseRef);
    if (bytes?.length) {
      const type = end.meta.headers?.['content-type'];
      const provider = end.meta.provider ?? call.meta.provider;
      const r = normalizeResponse(bytes, type, end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
      const streamed = r.kind === 'sse' && !type?.includes('vnd.amazon.eventstream');
      const calls = r.blocks.filter((b): b is Extract<typeof b, { type: 'tool_call' }> => b.type === 'tool_call');
      const ids = streamed && calls.some((b) => !b.id) ? streamedToolIds(bytes) : [];
      info = {
        sig: r.blocks.map(blockSig).filter((s): s is string => s !== null),
        tools: calls.map((b, i) => ({ name: b.name, input: b.input, id: b.id ?? ids[i] ?? null })),
      };
    }
  } catch {
    info = EMPTY_RESPONSE;
  }
  cache.responses.set(end.responseRef, info);
  return info;
}

// ---- model calls ----------------------------------------------------------------------------------

/** A conversation as the run is read: its latest request, and where the scope's indexes file it. */
interface Open {
  n: number;
  scope: string;
  items: string[];
  /** Keys of `items`, of `items` after the first, and of its length with its first item (the indexes below). */
  key: string;
  tailKey: string | null;
  editKey: string;
  /** The last item of its latest request when that is an assistant turn (a prefill): what it says. */
  lastSig: string[] | null;
  /** The system prompt its latest request was sent with, hashed. */
  frame: string | null;
  lastCall: CallRecord;
  conversationId: string | null;
  first: number;
  last: number;
  modelCalls: number;
  calls: number;
  /** When it last took a model call, for most-recent-first choices. */
  touched: number;
}

/** The conversation among `list` that last took a model call. */
const recent = (list: Iterable<Open>) => {
  let best: Open | undefined;
  for (const x of list) if (!best || x.touched > best.touched) best = x;
  return best;
};
const isPrefix = (a: readonly string[], b: readonly string[]) => a.length <= b.length && a.every((h, i) => h === b[i]);
const sameItems = (a: readonly string[], b: readonly string[]) => a.length === b.length && isPrefix(a, b);
/** How many items two requests share from the start. */
function leading(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Contiguous `part` inside `whole`. */
function contains(whole: readonly string[], part: readonly string[]): boolean {
  if (!part.length || part.length > whole.length) return false;
  outer: for (let i = 0; i + part.length <= whole.length; i++) {
    for (let j = 0; j < part.length; j++) if (whole[i + j] !== part[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Keys of the item sequences of a request from `from` on: `out[k]` keys `hashes[from..k)`. Equal
 * sequences get equal keys, so a request finds the conversations whose latest request is one of
 * its prefixes by lookups, not by comparing itself with every conversation; each match found is
 * still checked item by item.
 */
function sequenceKeys(hashes: readonly string[], from: number): string[] {
  const out: string[] = new Array<string>(hashes.length + 1);
  out[from] = '0:';
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let k = from; k < hashes.length; k++) {
    const h = hashes[k]!;
    for (let i = 0; i <= h.length; i++) {
      const c = i < h.length ? h.charCodeAt(i) : 0x2c;
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995);
      b ^= b >>> 13;
    }
    out[k + 1] = `${k + 1 - from}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
  }
  return out;
}

/** The edited-history index's key: a conversation's length, with its first item from two items on. */
const editKey = (length: number, first: string | undefined) => (length < 2 ? `${length}|` : `${length}|${first ?? ''}`);

/** Conversations filed by a key, most recently filed last. An entry goes stale when its conversation is filed elsewhere. */
class Shelf {
  private readonly lists = new Map<string, Open[]>();
  constructor(private readonly keyOf: (x: Open) => string | null) {}
  file(x: Open): void {
    const key = this.keyOf(x);
    if (key === null) return;
    let list = this.lists.get(key);
    if (!list) this.lists.set(key, (list = []));
    list.push(x);
    // Drop stale entries now and then, so a list stays about as long as what is filed under it now.
    if (list.length >= 64 && (list.length & (list.length - 1)) === 0) {
      const live = [...new Set(list.filter((y) => this.keyOf(y) === key))];
      this.lists.set(key, live);
    }
  }
  /** What is filed under `key` now, the most recently filed first, at most `max` of them. */
  *under(key: string | null | undefined, max = Infinity): Generator<Open> {
    const list = key ? this.lists.get(key) : undefined;
    if (!list) return;
    const seen = new Set<Open>();
    for (let i = list.length - 1; i >= 0 && seen.size < max; i--) {
      const x = list[i]!;
      if (seen.has(x) || this.keyOf(x) !== key) continue;
      seen.add(x);
      yield x;
    }
  }
}

/** One scope's conversations, indexed by what a request can continue them by. */
class ScopeIndex {
  readonly all: Open[] = [];
  /** By their latest request: the requests that extend it, and the same request again. */
  readonly byKey = new Shelf((x) => x.key);
  /** By their latest request after its first item: a request whose first message alone changed. */
  readonly byTail = new Shelf((x) => x.tailKey);
  /** By their length and first item: a request that edited their history and carries their answer. */
  readonly byEdit = new Shelf((x) => x.editKey);
  /** Tool-use ids to the conversation that last carried each. */
  readonly byId = new Map<string, Open>();
  readonly byConversationId = new Map<string, Open>();
  /** Response ids (`resp_…`) to their conversation, read from responses only once a request names one. */
  private readonly owners = new Map<string, Open>();
  private readonly modelCalls: Array<[CallRecord, Open]> = [];
  private scanned = 0;
  /** Model calls scanned before their answer arrived, with the record read then. */
  private unanswered: Array<[number, CallRecord]> = [];

  took(c: CallRecord, conv: Open): void {
    this.modelCalls.push([c, conv]);
  }

  /**
   * The conversation whose model call answered with response `id`. `cur` gives the newest record of
   * a call: a model call read before its answer arrived (a run still recording) is read again once
   * it has one.
   */
  ownerOf(store: StoreOf<'recording'>, id: string, cur: (c: CallRecord) => CallRecord = (c) => c): Open | undefined {
    if (!this.owners.has(id)) {
      for (; this.scanned < this.modelCalls.length; this.scanned++) {
        const [c, conv] = this.modelCalls[this.scanned]!;
        const rec = cur(c);
        const rid = responseIdOf(store, rec);
        if (rid) this.owners.set(rid, conv);
        else if (!rec.end) this.unanswered.push([this.scanned, rec]);
      }
      if (!this.owners.has(id) && this.unanswered.length) {
        this.unanswered = this.unanswered.filter(([i, seen]) => {
          const [c, conv] = this.modelCalls[i]!;
          const rec = cur(c);
          if (rec === seen) return true;
          const rid = responseIdOf(store, rec);
          if (rid) this.owners.set(rid, conv);
          return !rid && !rec.end;
        });
      }
    }
    return this.owners.get(id);
  }
}

/**
 * The weakest link: a request that edited the history it continues. An agent strips a reminder from
 * an earlier message, trims an old tool result, or replaces a prefilled answer with the whole of it,
 * so the request no longer starts with the conversation's latest one. It still carries that
 * request's answer, as the assistant turn right after the history it kept (or in place of the
 * prefill); it is longer, has the same system prompt, and from two items on the same first item.
 * The candidate sharing the most leading items wins. An answer counts only when it says something
 * particular (a tool call, or a text of some length) and the request has no other turn like it, as
 * a few-shot example's label would be. Only the request's last two assistant turns are looked at,
 * and a bounded number of conversations for each, so a run of unrelated requests stays linear.
 */
function editedLink(s: ScopeIndex, items: readonly ItemInfo[], hashes: readonly string[], frame: string | null, answerOf: (x: Open) => string[]): Open | undefined {
  const turns: number[] = [];
  for (let j = items.length - 1; j >= 1 && turns.length < 2; j--) if (items[j]!.sig?.length) turns.push(j);
  let best: { x: Open; lead: number } | undefined;
  for (const j of turns) {
    const turn = items[j]!.sig!;
    if (items.some((other, i) => i !== j && other.sig !== null && sameItems(other.sig, turn))) continue;
    for (const [length, prefill] of [
      [j, false],
      [j + 1, true],
    ] as const) {
      if (length >= hashes.length) continue;
      for (const x of s.byEdit.under(editKey(length, hashes[0]), 16)) {
        if (x.items.length !== length || x.frame !== frame || (prefill && !x.lastSig)) continue;
        const lead = leading(x.items, hashes);
        if (lead >= length || (length >= 2 && lead < 1)) continue;
        if (!sameAnswer(turn, answerOf(x), prefill ? x.lastSig : null)) continue;
        if (!best || lead > best.lead || (lead === best.lead && x.touched > best.x.touched)) best = { x, lead };
      }
    }
  }
  return best?.x;
}

/** The smallest answer that tells conversations apart: a tool call, or this much text ("OK" and "refund" do not). */
const PARTICULAR = 16;

/** An assistant turn of a request is the answer a response gave: the same blocks, or the prefill it was given with the text written after it. */
function sameAnswer(turn: readonly string[], answer: readonly string[], prefill: readonly string[] | null): boolean {
  if (!turn.length || !answer.length) return false;
  if (!answer.some((x) => x.startsWith('c:')) && answer.join(' ').length - 2 < PARTICULAR) return false;
  if (!prefill) return contains(answer, turn) || contains(turn, answer);
  const text = (sig: readonly string[]) => sig.filter((x) => x.startsWith('t:')).map((x) => x.slice(2)).join(' ');
  const whole = text(turn);
  const start = text(prefill);
  const rest = text(answer);
  return !!rest && whole.length >= start.length + rest.length && whole.startsWith(start) && whole.endsWith(rest);
}

/**
 * Places a run's calls in conversations. `calls` are the run's calls as `store.getCalls` returns
 * them. The result is cached per store and run until the run changes.
 */
export function runConversations(store: Store, calls: readonly CallRecord[], options: ConversationOptions = {}): RunConversations {
  const cache = cachesFor(store);
  const runId = calls[0]?.runId ?? '';
  const key = `${runId}\n${options.attribute ? 'all' : 'model'}\n${runStamp(calls)}`;
  const known = runId ? cache.runs.get(key) : undefined;
  if (known) return known;
  const placement = new Placement(store, cache, !!options.attribute);
  placement.add(calls);
  const result = placement.result(calls, true);
  if (runId) cache.runs.set(key, result);
  return result;
}

/**
 * A run's conversations as its calls arrive, for a run still recording: each call is placed once,
 * from what came before it, when it first shows up, so bringing the analysis up to date costs as much
 * as the calls that arrived since, not as much as the run is long. An answer that arrives later is
 * read where later calls need it (a retry, the tools a model asked for). What this gives a call no
 * model asked for can differ from `runConversations` over the finished run, which also looks at the
 * calls after it: a call no model asked for that feeds the model call after it waits, in no
 * conversation, until that model call arrives. A page following a recording reads the finished run
 * whole once it ends.
 */
export class LiveConversations {
  private readonly placement: Placement;
  private readonly seen: CallRecord[] = [];
  private runId: string | null = null;

  constructor(store: Store, options: ConversationOptions = {}) {
    this.placement = new Placement(store, cachesFor(store), !!options.attribute, true);
  }

  /**
   * The conversations of `calls`, the run's calls as `store.getCalls` returns them now: the calls
   * placed before, in the same order, then those that arrived since. Null when they are not (another
   * run, or calls gone): start again with a new one.
   */
  update(calls: readonly CallRecord[]): RunConversations | null {
    const runId = calls[0]?.runId ?? this.runId;
    if (this.runId !== null && runId !== this.runId) return null;
    if (calls.length < this.seen.length) return null;
    const changed: CallRecord[] = [];
    for (let i = 0; i < this.seen.length; i++) {
      const c = calls[i]!;
      const had = this.seen[i]!;
      if (c.callNo !== had.callNo) return null;
      if (c !== had) {
        changed.push(c);
        this.seen[i] = c;
      }
    }
    this.runId = runId;
    this.placement.revise(changed);
    const arrived = calls.slice(this.seen.length);
    this.seen.push(...arrived);
    this.placement.add(arrived);
    return this.placement.result(calls);
  }
}

/**
 * The placing itself, in call order: the model calls by their requests first, then every other call
 * (`attribute`). Kept between `add`s, so a run's calls can be placed as they arrive (LiveConversations);
 * given every call at once it is the analysis of the whole run. Each call is read through `cur`: the
 * newest record of it, so an answer that arrived after the call was placed is the one read.
 */
class Placement {
  private readonly byCall = new Map<number, CallConversation>();
  private readonly open: Open[] = [];
  private readonly scopes = new Map<string, ScopeIndex>();
  private readonly ofCall = new Map<number, Open>();
  private clock = 0;
  /** The newest record of each call placed, by call number. */
  private readonly latest = new Map<number, CallRecord>();
  /** Model calls already looked at by their requests, and other calls already looked at for their conversation. */
  private readonly tried = new Set<number>();
  private readonly triedOther = new Set<number>();
  /** Model calls that belong to a conversation, oldest first: all of them, and per scope. */
  private readonly models: CallRecord[] = [];
  private readonly modelsIn = new Map<string, CallRecord[]>();
  /** For each model call, which of the tools it asked for a tool call has matched, with the record they were read from. */
  private readonly used = new Map<number, { rec: CallRecord; u: boolean[] }>();
  /** Tool calls placed so far, oldest first, with their conversations. */
  private readonly tools: Array<[CallRecord, Open]> = [];
  /** Live: calls that feed the next model call, which has not arrived yet, oldest first. */
  private waiting: CallRecord[] = [];

  constructor(
    private readonly store: Store,
    private readonly cache: StoreCaches,
    private readonly attribute: boolean,
    /** The run is still recording: a call that goes with the next model call waits for it. */
    private readonly live = false,
  ) {}

  private readonly cur = (c: CallRecord): CallRecord => this.latest.get(c.callNo) ?? c;
  private readonly response = (c: CallRecord): ResponseInfo => responseInfo(this.store, this.cur(c));

  /** Newer records of calls placed before: their answers arrived. */
  revise(changed: readonly CallRecord[]): void {
    for (const c of changed) this.latest.set(c.callNo, c);
  }

  /** Places `calls`, which come after every call placed so far. */
  add(calls: readonly CallRecord[]): void {
    for (const c of calls) this.latest.set(c.callNo, c);
    for (const c of calls) {
      if (c.kind !== 'api' || this.tried.has(c.callNo)) continue;
      this.tried.add(c.callNo);
      this.placeModelCall(c);
    }
    if (!this.attribute) return;
    for (const c of calls) {
      if (this.ofCall.has(c.callNo)) {
        const scope = scopeOf(c);
        this.models.push(c);
        const list = this.modelsIn.get(scope);
        if (list) list.push(c);
        else this.modelsIn.set(scope, [c]);
      }
    }
    if (this.waiting.length) {
      const waiting = this.waiting;
      this.waiting = [];
      for (const t of waiting) this.placeOther(t);
    }
    for (const t of calls) {
      if (this.byCall.has(t.callNo) || this.triedOther.has(t.callNo)) continue;
      this.triedOther.add(t.callNo);
      this.placeOther(t);
    }
  }

  /** What it found for `calls`; `last` when nothing is added after, which saves copying what it keeps. */
  result(calls: readonly CallRecord[], last = false): RunConversations {
    const byCall = last ? this.byCall : new Map(this.byCall);
    for (const c of calls) if (!byCall.has(c.callNo)) byCall.set(c.callNo, NONE);
    return {
      conversations: this.open.map((x) => ({ n: x.n, scope: x.scope || null, firstCallNo: x.first, lastCallNo: x.last, modelCalls: x.modelCalls, calls: x.calls })),
      byCall,
      requests: new Set(this.ofCall.keys()),
    };
  }

  private placeModelCall(c: CallRecord): void {
    const { store, open, scopes, ofCall, byCall, response, cur } = this;
    const d = digest(store, c, this.cache);
    if (!d) return;
    const scope = scopeOf(c);
    let s = scopes.get(scope);
    if (!s) scopes.set(scope, (s = new ScopeIndex()));
    const items = d.items.filter((i) => !i.skip);
    const hashes = items.map((i) => i.hash);
    const ids = items.flatMap((i) => i.ids);
    const keys = sequenceKeys(hashes, 0);
    const tails = hashes.length >= 2 ? sequenceKeys(hashes, 1) : null;

    let chosen: Open | undefined;
    if (d.conversationId) chosen = s.byConversationId.get(d.conversationId);
    else if (d.previousResponseId) chosen = s.ownerOf(store, d.previousResponseId, cur) ?? recent(s.all);
    else {
      // Conversations whose latest request this one extends.
      const ext: Open[] = [];
      for (let k = 1; k < hashes.length; k++) for (const x of s.byKey.under(keys[k])) if (x.items.length === k && isPrefix(x.items, hashes)) ext.push(x);
      if (ext.length === 1) chosen = ext[0];
      else if (ext.length > 1) {
        // Two conversations whose latest requests were the same (branches that started alike):
        // the answer appended after that request says whose turn this is.
        const answered = ext.filter((x) => {
          const sig = items[x.items.length]?.sig;
          return !!sig?.length && contains(response(x.lastCall).sig, sig);
        });
        const pool = answered.length ? answered : ext;
        const longest = Math.max(...pool.map((x) => x.items.length));
        chosen = recent(pool.filter((x) => x.items.length === longest));
      } else {
        const same = [...s.byKey.under(keys[hashes.length])].filter((x) => sameItems(x.items, hashes));
        if (same.length) {
          // The same request again: a retry when the last one failed, otherwise a branch of its own.
          chosen = recent(same.filter((x) => cur(x.lastCall).end?.outcome === 'error'));
        } else {
          // Weaker links, when the history was edited: only the first message changed (a system
          // message with the time in it); the request carries tool-use ids a conversation issued
          // (an agent that drops its oldest turns); or it carries a conversation's answer.
          const firstChanged: Open[] = [];
          if (tails) for (let k = 2; k < hashes.length; k++) for (const x of s.byTail.under(tails[k])) if (x.items.length === k && x.items.every((h, i) => i === 0 || h === hashes[i])) firstChanged.push(x);
          const carried = new Set<Open>();
          for (const id of ids) {
            const x = s.byId.get(id);
            if (x) carried.add(x);
          }
          chosen = recent(firstChanged) ?? recent(carried) ?? editedLink(s, items, hashes, d.frame, (x) => response(x.lastCall).sig);
        }
      }
    }
    let conv = chosen;
    if (!conv) {
      conv = { n: open.length + 1, scope, items: [], key: '', tailKey: null, editKey: '', lastSig: null, frame: null, lastCall: c, conversationId: d.conversationId, first: c.callNo, last: c.callNo, modelCalls: 0, calls: 0, touched: 0 };
      open.push(conv);
      s.all.push(conv);
      if (d.conversationId && !s.byConversationId.has(d.conversationId)) s.byConversationId.set(d.conversationId, conv);
    }
    conv.items = hashes;
    conv.key = keys[hashes.length]!;
    conv.tailKey = tails ? tails[hashes.length]! : null;
    conv.editKey = editKey(hashes.length, hashes[0]);
    conv.lastSig = items.at(-1)?.sig ?? null;
    conv.frame = d.frame;
    conv.lastCall = c;
    s.byKey.file(conv);
    s.byTail.file(conv);
    s.byEdit.file(conv);
    s.took(c, conv);
    for (const id of ids) s.byId.set(id, conv);
    conv.touched = ++this.clock;
    conv.modelCalls++;
    conv.calls++;
    conv.last = Math.max(conv.last, c.callNo);
    ofCall.set(c.callNo, conv);
    byCall.set(c.callNo, { conversation: conv.n, starts: !chosen, requestedBy: null, toolUseId: null });
  }

  // ---- everything else ----

  /** The model calls a call in `scope` looks at: its own scope's, else the nearest enclosing scope's that has some, else all. */
  private near(scope: string): CallRecord[] {
    for (let s: string | null = scope; s !== null; s = s.includes('/') ? s.slice(0, s.lastIndexOf('/')) : s ? '' : null) {
      const list = this.modelsIn.get(s);
      if (list?.length) return list;
    }
    return this.models;
  }

  /** Which tools a model call asked for are matched already; read again when the call's answer arrived since. */
  private usedOf(m: CallRecord): boolean[] {
    const rec = this.cur(m);
    let e = this.used.get(m.callNo);
    if (!e || e.rec !== rec) {
      e = { rec, u: this.response(rec).tools.map((_, i) => e?.u[i] ?? false) };
      this.used.set(m.callNo, e);
    }
    return e.u;
  }

  private requestedBy(t: CallRecord): { model: CallRecord; tool: RequestedTool } | null {
    let args: unknown;
    try {
      args = t.requestRef ? this.store.getJson<{ args?: unknown }>(t.requestRef)?.args : undefined;
    } catch {
      args = undefined;
    }
    // Its own scope first; then every scope, for a tool recorded outside the scope its model call ran in.
    const models = this.models;
    const own = this.modelsIn.get(scopeOf(t)) ?? [];
    for (const list of own.length === models.length ? [models] : [own, models]) {
      let byName: { model: CallRecord; tool: RequestedTool; index: number } | null = null;
      for (let i = before(list, t.callNo), seen = 0; i >= 0 && seen < LOOK_BACK; i--, seen++) {
        const m = list[i]!;
        const tools = this.response(m).tools;
        const u = this.usedOf(m);
        for (let k = 0; k < tools.length; k++) {
          if (u[k] || !sameTool(tools[k]!.name, t.name)) continue;
          if (args !== undefined && sameArgs(tools[k]!.input, args)) {
            u[k] = true;
            return { model: m, tool: tools[k]! };
          }
          byName ??= { model: m, tool: tools[k]!, index: k };
        }
      }
      if (byName) {
        this.usedOf(byName.model)[byName.index] = true;
        return { model: byName.model, tool: byName.tool };
      }
    }
    return null;
  }

  /** The tool call that was running when `c` started, in its scope: `c` is part of what the tool did. */
  private runningAt(c: CallRecord): Open | undefined {
    const tools = this.tools;
    for (let i = tools.length - 1, seen = 0; i >= 0 && seen < CONTAIN_LOOK_BACK; i--, seen++) {
      const [t, conv] = tools[i]!;
      const end = this.cur(t).end?.at;
      if (end !== undefined && scopeOf(t) === scopeOf(c) && t.at <= c.at && c.at < end && (!c.end || c.end.at <= end)) return conv;
    }
    return undefined;
  }

  private placeOther(t: CallRecord): void {
    const { ofCall, byCall } = this;
    if (t.kind === 'tool') {
      const asked = this.requestedBy(t);
      if (asked) {
        const conv = ofCall.get(asked.model.callNo)!;
        conv.calls++;
        conv.last = Math.max(conv.last, t.callNo);
        byCall.set(t.callNo, { conversation: conv.n, starts: false, requestedBy: asked.model.callNo, toolUseId: asked.tool.id });
        this.tools.push([t, conv]);
        return;
      }
    }
    // No model asked for it. Made while a tool ran (an HTTP request the tool sends, a tool it
    // calls), it goes with that tool. Otherwise it goes with the model call still waiting on tools
    // it asked for (none of them has run yet), else with the next model call, which it feeds.
    let conv = this.runningAt(t);
    if (!conv) {
      const list = this.near(scopeOf(t));
      const i = before(list, t.callNo);
      const prev = i >= 0 ? list[i]! : null;
      const next = list[i + 1] ?? null;
      if (!(prev && this.usedOf(prev).some((u) => !u)) && !next && this.live) {
        // The model call it feeds may be on its way: placed once one arrives.
        this.waiting.push(t);
        return;
      }
      const owner = prev && this.usedOf(prev).some((u) => !u) ? prev : (next ?? prev);
      conv = owner ? ofCall.get(owner.callNo) : undefined;
    }
    if (!conv) return;
    conv.calls++;
    conv.last = Math.max(conv.last, t.callNo);
    byCall.set(t.callNo, { conversation: conv.n, starts: false, requestedBy: null, toolUseId: null });
    if (t.kind === 'tool') this.tools.push([t, conv]);
  }
}

// ---- everything else ------------------------------------------------------------------------------

/** How far back a tool call looks for the model call that asked for it. */
const LOOK_BACK = 256;
/** How many of the latest tool calls a call looks through for one that was running when it started. */
const CONTAIN_LOOK_BACK = 64;

const sameTool = (requested: string, recorded: string) => requested === recorded || requested.endsWith(`__${recorded}`) || recorded.endsWith(`__${requested}`);

/**
 * The arguments a model asked for, as the tool was called with them: equal, or every argument the
 * model gave with the same value (an SDK that records arguments by name adds the defaults).
 */
function sameArgs(input: unknown, args: unknown): boolean {
  if (deepEqual(input, args)) return true;
  if (!isObject(input) || !isObject(args)) return false;
  const given = Object.entries(input);
  return given.length > 0 && given.every(([k, v]) => k in args && deepEqual(v, args[k]));
}

/** The index of the last call in `list` (in call order) before `callNo`; -1 when there is none. */
function before(list: readonly CallRecord[], callNo: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.callNo < callNo) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * The model call whose request shows a call's conversation as it stood at that call: the call's
 * own request for a model call, else the latest request of its conversation before it, else the
 * first one after it (a call made before its conversation's first model call). Null when the
 * call belongs to no conversation.
 */
export function conversationRequestFor(calls: readonly CallRecord[], conversations: RunConversations, callNo: number): CallRecord | null {
  const self = calls.find((c) => c.callNo === callNo);
  if (!self) return null;
  if (self.kind === 'api' && self.requestRef) return self;
  const n = conversations.byCall.get(callNo)?.conversation ?? null;
  if (n === null) return null;
  const members = calls.filter((c) => conversations.requests.has(c.callNo) && conversations.byCall.get(c.callNo)?.conversation === n);
  return [...members].reverse().find((c) => c.callNo < callNo) ?? members.find((c) => c.callNo > callNo) ?? null;
}
