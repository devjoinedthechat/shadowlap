import { createHash, type Hash } from 'node:crypto';
import { describeBlocks } from './blame.js';
import { canonicalize } from './canonical.js';
import { normalizeConversation, type Turn, type TurnBlock } from './conversation.js';
import { messagesOf, type DatasetMessage } from './dataset.js';
import type { Block } from './deltas.js';
import { sha256 } from './ids.js';
import { isJudgeCall } from './judge-scope.js';
import { loadApiRequest, type RequestManifest } from './manifest.js';
import { applyNormalizers, compilePattern } from './normalize.js';
import { normalizeResponse } from './responses.js';
import type { Store } from './store.js';
import { isModelRequest } from './tasks.js';
import { openAITools } from './translate.js';
import type { CallRecord, Normalizer, RunRecord } from './types.js';

/**
 * Preference pairs, read from what blame, verify and `--repeat` already left in the store. A pair is
 * two answers to the same conversation: one that lost the run, one that went on to pass. Nothing is
 * collected for it; the attempts are runs like any other.
 *
 * - **High:** blame asked the blamed call again and the run passed. Each passing attempt's answer
 *   there is paired with the recorded one, which lost the run: that answer decided it.
 * - **Medium:** verify ran a recording several times and some attempts passed while others failed.
 *   A failing and a passing attempt are paired at the first model call where their answers differ.
 *   Nothing checked that this answer decided the run, only that the runs parted there. `--repeat`
 *   attempts carry nothing but their exit status, so they pair the same way, by exit status, when
 *   both outcomes exist.
 *
 * Identical answers count once, across every source: a verify that finds the two answers a blame
 * already paired adds nothing, and the pair stays high. Two answers only make a pair when they
 * answer the same conversation: attempts whose paths parted before their answers did (a live read
 * that returned something else) make none, and neither does an answer that also passed, from the
 * same point, in another attempt.
 *
 * Scopes: a run whose model calls are made in more than one scope (an agent and the simulated user
 * it talks to) is read in its agent's scope only, the one blame was limited to (`--scope`), so a
 * pair is never the simulated user's lines. Without a blame to say which scope is the agent's, such
 * a run makes no verify or `--repeat` pairs, and its source says so.
 */

export type PairConfidence = 'high' | 'medium';
export type PairSourceKind = 'blame' | 'verify' | 'repeat';

export interface PairAnswer {
  /** The run the answer was given in: the recording, for blame's rejected answer; otherwise an attempt. */
  runId: string;
  callNo: number;
  /** Where it came from: `the recording`, `blame attempt, passed`, `verify attempt, failed`. */
  what: string;
  /** The answer in one line: its text and its tool calls with their arguments. */
  text: string;
  /** The answer without thinking, which the model that wrote it is the only one able to read. */
  blocks: Block[];
}

export interface Pair {
  /** Stable for the same two answers to the same conversation, whichever source made them: `pr-` and 12 hex digits. */
  id: string;
  confidence: PairConfidence;
  /** The source's key (see PairSource). */
  source: string;
  sourceKind: PairSourceKind;
  /** The run the pair is about: the blamed run, or the run verify or `--repeat` replayed. */
  runId: string;
  /** The model call the answers answer, in the rejected answer's run. */
  callNo: number;
  /**
   * The same call in the run the pair is about: its model call that answered the same conversation.
   * Its number can differ from `callNo` when the attempts made more or fewer calls before it (a model
   * list the change dropped). Null when that run never saw the conversation: the attempts took another
   * path first, as when the change verify checked adds a step before the call. A blame's pair is about
   * the recording its rejected answer came from, so it is `callNo`.
   */
  aboutCallNo: number | null;
  /** The conversation at that call in one line: what was asked, and the last thing the model saw. */
  context: string;
  model: string | null;
  rejected: PairAnswer;
  chosen: PairAnswer;
  /** When the chosen answer was given. */
  at: number;
}

export interface PairSource {
  /** `blame:<run>`, `verify:<invocation>` or `repeat:<group>`. */
  key: string;
  kind: PairSourceKind;
  /** The blamed run, the first run verify replayed, or the run `--repeat` replayed. */
  runId: string;
  /** Every run the source replayed (verify replays several). */
  runIds: string[];
  /** `blame · refund-bug`, `verify · 370712a+dirty`, `replay --repeat 5 · 01K5CQ4N7G`. */
  label: string;
  confidence: PairConfidence;
  /** Pairs it made. */
  made: number;
  /** Attempts it ran that are still in the store. */
  attempts: number;
  /** For blame, the blamed call; otherwise the first call a pair came from, or null. */
  callNo: number | null;
  /** Why it made what it made, in a sentence or two. */
  why: string;
  at: number;
  /** For a verify of a repair's candidate: which candidate (the label says `verify · repair candidate 3`). */
  candidate?: number;
}

export interface PairsResult {
  pairs: Pair[];
  sources: PairSource[];
}

type ModelCall = CallRecord & { end: NonNullable<CallRecord['end']> };
type ChunkedManifest = Extract<RequestManifest, { kind: 'chunked' }>;

const squash = (s: string) => s.trim().replace(/\s+/g, ' ');
const short = (id: string) => id.slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A run as a source names it: its first label, or its short id. */
function runName(run: RunRecord): string {
  return run.meta?.labels?.[0] ?? short(run.runId);
}

/** What makes a turn the same turn whatever ids, whitespace and reasoning it carried; '' for one with nothing that counts. */
function turnKey(t: Turn): string {
  const blocks = t.blocks.flatMap((b: TurnBlock): unknown[] => {
    if (b.type === 'thinking') return [];
    if (b.type === 'text') return squash(b.text) ? [{ t: squash(b.text) }] : [];
    if (b.type === 'tool_call') return [{ c: b.name, i: b.input ?? {} }];
    if (b.type === 'tool_result') return [{ res: squash(b.content), e: b.isError === true }];
    return [{ o: b.label }];
  });
  return blocks.length ? sha256(canonicalize({ r: t.role, b: blocks })) : '';
}

/** A conversation's key is the tools it offers, then each turn's key in order. */
const startKey = (tools: readonly string[]): Hash => createHash('sha256').update(`${JSON.stringify(tools)}\n`);

/** The same conversation whatever ids, whitespace and reasoning the attempts carried. */
function conversationKey(turns: readonly Turn[], tools: readonly string[]): string {
  const h = startKey(tools);
  for (const t of turns) {
    const k = turnKey(t);
    if (k) h.update(`${k}\n`);
  }
  return h.digest('hex');
}

/** The same answer whatever ids, whitespace and reasoning came with it; '' for one with nothing to say. */
function answerKey(blocks: readonly Block[]): string {
  const parts = blocks.flatMap((b): unknown[] => (b.type === 'text' ? (squash(b.text) ? [{ t: squash(b.text) }] : []) : b.type === 'tool_call' ? [{ c: b.name, i: b.input ?? {} }] : []));
  return parts.length ? canonicalize(parts) : '';
}

/** A message only OpenAI's chat shape has: what makes normalizeConversation read a body as OpenAI's. */
function openAIOnly(m: unknown): boolean {
  return isObject(m) && (m.role === 'tool' || m.role === 'developer' || Array.isArray(m.tool_calls) || (m.role === 'system' && typeof m.content === 'string'));
}

const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);

/**
 * A tool's result as a person would read it out: a JSON object's fields as `key: value` (`sent: true,
 * to: customer@example.com`), a string field without its quotes; anything else as it came.
 */
function readableResult(content: string): string {
  const s = squash(content);
  if (!s.startsWith('{')) return s;
  try {
    const v: unknown = JSON.parse(content);
    if (!isObject(v)) return s;
    const fields = Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'string' ? squash(x) : JSON.stringify(x)}`);
    return fields.length ? fields.join(', ') : s;
  } catch {
    return s;
  }
}

/**
 * A conversation in one line: what it was about (the first thing the user said) and the last thing
 * the model saw before answering (a tool's result, read out field by field, or what the user said last).
 */
export function contextLine(turns: readonly Turn[], width = 140): string {
  const texts = (t: Turn) => t.blocks.flatMap((b) => (b.type === 'text' && squash(b.text) ? [squash(b.text)] : []));
  const users = turns.filter((t) => t.role === 'user' && texts(t).length);
  const first = users[0] ? texts(users[0]).join(' ') : '';
  const names = new Map<string, string>();
  for (const t of turns) for (const b of t.blocks) if (b.type === 'tool_call' && b.id) names.set(b.id, b.name);
  let last = '';
  for (let i = turns.length - 1; i >= 0 && !last; i--) {
    const t = turns[i]!;
    if (t.role === 'assistant' || t.role === 'system') continue;
    const results = t.blocks.filter((b): b is Extract<TurnBlock, { type: 'tool_result' }> => b.type === 'tool_result');
    const r = results.at(-1);
    if (r) {
      const name = r.name ?? (r.id ? names.get(r.id) : undefined) ?? 'a tool';
      last = `${name} returned ${readableResult(r.content) || '(nothing)'}`;
    } else if (t !== users[0] && texts(t).length) last = `then: ${texts(t).join(' ')}`;
  }
  if (!first && !last) return '(an empty conversation)';
  const head = cut(first || '(no user message)', last ? Math.max(40, Math.floor(width * 0.45)) : width);
  return last ? cut(`${head} · ${last}`, width) : head;
}

/** A message's turn key as an Anthropic-shaped message and as an OpenAI-shaped one, and whether only OpenAI's shape has it. */
type MessageKeys = { anthropic: string; openai: string; openAIOnly: boolean };

/**
 * The keys pairs are read by, kept per store: a conversation's by its request's hash, a message's by
 * its hash, an answer's by its response's hash, and a pair's context line by its request's hash. Blobs are addressed by their content, so a key never
 * goes stale, and a store read again (an attempt ended, a blame finished) keys only what is new. A
 * map that grows past KEY_LIMIT entries starts over.
 */
interface KeyCache {
  conversations: Map<string, string | null>;
  messages: Map<string, MessageKeys | null>;
  parts: Map<string, string | string[] | null>;
  answers: Map<string, string>;
  /** A pair's conversation in one line, by its request's hash. */
  contexts: Map<string, string | null>;
  /** Where a pair's conversation got to (pathKey), and the call it is about's, by their request's hash. */
  paths: Map<string, string | null>;
  /** The turn keys of the requests halving read last, by their hash: a long run's are long, so only TURN_LISTS of them are kept. */
  turns: Map<string, string[] | null>;
}
const KEY_LIMIT = 50_000;
const TURN_LISTS = 512;
const keyCaches = new WeakMap<Store, KeyCache>();

function keyCache(store: Store): KeyCache {
  let cache = keyCaches.get(store);
  if (!cache) keyCaches.set(store, (cache = { conversations: new Map(), messages: new Map(), parts: new Map(), answers: new Map(), contexts: new Map(), paths: new Map(), turns: new Map() }));
  for (const map of [cache.conversations, cache.messages, cache.parts, cache.answers, cache.contexts, cache.paths]) if (map.size > KEY_LIMIT) map.clear();
  return cache;
}

/**
 * Where a conversation got to, whatever the system prompt, the tools offered and the model's words:
 * what the user said, each tool the model called with its input, and what each returned, in order. A
 * changed prompt leaves it as it was; a step more or less doesn't.
 */
function pathKey(turns: readonly Turn[]): string {
  const h = createHash('sha256');
  for (const t of turns) {
    if (t.role === 'system') continue;
    const said = t.role !== 'assistant';
    const blocks = t.blocks.flatMap((b: TurnBlock): unknown[] => {
      if (b.type === 'tool_call') return [{ c: b.name, i: b.input ?? {} }];
      if (b.type === 'tool_result') return [{ res: squash(b.content), e: b.isError === true }];
      if (b.type === 'text') return said && squash(b.text) ? [{ t: squash(b.text) }] : [];
      if (b.type === 'other') return said ? [{ o: b.label }] : [];
      return [];
    });
    if (blocks.length) h.update(`${canonicalize({ r: t.role, b: blocks })}\n`);
  }
  return h.digest('hex');
}

/**
 * Reads what pairs need from the store, each thing once. A model request is stored as its messages
 * plus a list of them, so a conversation's key is made from its messages' keys, each message read
 * and keyed once: a run's thousandth call costs no more to key than reading its list. Turns are
 * rebuilt only for the calls pairs come from.
 */
class Reader {
  private readonly calls = new Map<string, CallRecord[]>();
  private readonly models = new Map<string, ModelCall[]>();
  private readonly keys: KeyCache;
  private readonly answers = new Map<string, Block[]>();
  constructor(readonly store: Store) {
    this.keys = keyCache(store);
  }

  callsOf(runId: string): CallRecord[] {
    let calls = this.calls.get(runId);
    if (!calls) this.calls.set(runId, (calls = this.store.getCalls(runId)));
    return calls;
  }

  /** The run's model calls that were answered, in order; with a scope, only those made in it. */
  modelCalls(runId: string, scope: string | null = null): ModelCall[] {
    const id = `${runId}\n${scope ?? ''}`;
    let calls = this.models.get(id);
    if (!calls) {
      calls =
        scope === null
          ? this.callsOf(runId).filter((c): c is ModelCall => c.kind === 'api' && !!c.requestRef && c.end !== null && c.end.outcome === 'ok' && !!c.end.responseRef && isModelRequest(c.name) && !isJudgeCall(c))
          : this.modelCalls(runId).filter((c) => c.meta.scope === scope);
      this.models.set(id, calls);
    }
    return calls;
  }

  modelCall(runId: string, callNo: number): ModelCall | null {
    return this.modelCalls(runId).find((c) => c.callNo === callNo) ?? null;
  }

  /** The scopes a run's model calls were made in; null for calls made outside any. */
  scopesOf(runId: string): Array<string | null> {
    return [...new Set(this.modelCalls(runId).map((c) => (typeof c.meta.scope === 'string' ? c.meta.scope : null)))];
  }

  /** The conversation a model call answered, as a key; null when its request can't be read as one. */
  key(call: ModelCall): string | null {
    const known = this.keys.conversations.get(call.requestRef!);
    return known !== undefined ? known : (this.read(call.requestRef!)?.key ?? null);
  }

  /**
   * A model call's conversation as its turns' keys in order, the system prompt's first: what halving
   * checks to know the calls it compared are one conversation, each the one before it plus what came
   * since. Null when its request can't be read as a conversation.
   */
  turnKeys(call: ModelCall): string[] | null {
    const ref = call.requestRef!;
    const lists = this.keys.turns;
    let turns = lists.get(ref);
    if (turns !== undefined) {
      // The most recently read stay: a list read again moves to the end.
      lists.delete(ref);
    } else {
      turns = this.read(ref)?.turns ?? null;
      if (lists.size >= TURN_LISTS) lists.delete(lists.keys().next().value!);
    }
    lists.set(ref, turns);
    return turns;
  }

  /** Reads a stored request once: its conversation's key (kept for the store) and its turns' keys. */
  private read(ref: string): { key: string; turns: string[] } | null {
    let out: { key: string; turns: string[] } | null = null;
    try {
      const manifest = this.store.getJson<RequestManifest>(ref);
      if (manifest?.kind === 'chunked') out = this.chunked(manifest);
      else if (manifest) {
        const conv = normalizeConversation(loadApiRequest(this.store, ref));
        if (conv) out = { key: conversationKey(conv.turns, conv.tools), turns: conv.turns.map(turnKey).filter(Boolean) };
      }
    } catch {
      out = null;
    }
    this.keys.conversations.set(ref, out?.key ?? null);
    return out;
  }

  /** What conversationKey would give the stored request, and its turns' keys, from its messages' keys. */
  private chunked(m: ChunkedManifest): { key: string; turns: string[] } | null {
    const messages = m.messages.map((hash) => this.message(hash));
    if (messages.some((x) => x === null)) return null;
    // normalizeConversation reads a body as OpenAI's chat when it has no system field and a message only OpenAI's shape has.
    const openai = m.system === null && messages.some((x) => x!.openAIOnly);
    const tools = this.part(`tools\n${m.tools ?? ''}\n${m.fields.toolConfig === undefined ? '' : JSON.stringify(m.fields.toolConfig)}`, () => normalizeConversation({ ...(m.tools !== null ? { tools: this.store.getJson(m.tools) } : {}), ...(m.fields.toolConfig !== undefined ? { toolConfig: m.fields.toolConfig } : {}), messages: [] })?.tools ?? []);
    if (tools === null) return null;
    const turns: string[] = [];
    if (m.system !== null) {
      const system = this.part(`system\n${m.system}`, () => {
        const turn = normalizeConversation({ system: this.store.getJson(m.system!), messages: [] })?.turns[0];
        return turn ? turnKey(turn) : '';
      });
      if (system === null) return null;
      if (system) turns.push(system as string);
    }
    for (const x of messages) {
      const k = openai ? x!.openai : x!.anthropic;
      if (k) turns.push(k);
    }
    const h = startKey(tools as string[]);
    for (const k of turns) h.update(`${k}\n`);
    return { key: h.digest('hex'), turns };
  }

  /** One stored message's turn, keyed under each shape a request can give it (normalizeConversation decides the shape from the whole body). */
  private message(hash: string): MessageKeys | null {
    let v = this.keys.messages.get(hash);
    if (v !== undefined) return v;
    v = null;
    try {
      const m = this.store.getJson<unknown>(hash);
      if (m !== null) {
        const asAnthropic = normalizeConversation({ system: '', messages: [m] })?.turns[1];
        const asOpenAI = normalizeConversation({ messages: [{ role: 'developer', content: '' }, m] })?.turns[1];
        v = { anthropic: asAnthropic ? turnKey(asAnthropic) : '', openai: asOpenAI ? turnKey(asOpenAI) : '', openAIOnly: openAIOnly(m) };
      }
    } catch {
      v = null;
    }
    this.keys.messages.set(hash, v);
    return v;
  }

  private part(id: string, make: () => string | string[]): string | string[] | null {
    let v = this.keys.parts.get(id);
    if (v !== undefined) return v;
    try {
      v = make();
    } catch {
      v = null;
    }
    this.keys.parts.set(id, v);
    return v;
  }

  /**
   * What only the calls pairs come from (and the calls they are about) are read for: the conversation
   * in one line (contextLine) and where it got to (pathKey). One read gives both, kept for the store.
   */
  private readTurns(ref: string): void {
    let turns: Turn[] | undefined;
    try {
      turns = normalizeConversation(loadApiRequest(this.store, ref))?.turns;
    } catch {
      turns = undefined;
    }
    this.keys.contexts.set(ref, turns ? contextLine(turns) : null);
    this.keys.paths.set(ref, turns ? pathKey(turns) : null);
  }

  /** The conversation a model call answered, in one line (contextLine). */
  context(call: ModelCall): string | null {
    const ref = call.requestRef!;
    if (!this.keys.contexts.has(ref)) this.readTurns(ref);
    return this.keys.contexts.get(ref) ?? null;
  }

  /** Whether two model calls answered the same conversation: the same stored request, or the same key. */
  samePrompt(a: ModelCall, b: ModelCall): boolean {
    if (a.requestRef === b.requestRef) return true;
    const k = this.key(a);
    return k !== null && k === this.key(b);
  }

  /** Whether two model calls were made at the same point of the same path (pathKey), whatever their prompts said. */
  samePath(a: ModelCall, b: ModelCall): boolean {
    if (a.requestRef === b.requestRef) return true;
    for (const ref of [a.requestRef!, b.requestRef!]) if (!this.keys.paths.has(ref)) this.readTurns(ref);
    const k = this.keys.paths.get(a.requestRef!) ?? null;
    return k !== null && k === (this.keys.paths.get(b.requestRef!) ?? null);
  }

  answer(call: ModelCall): Block[] {
    const id = this.answerId(call);
    let blocks = this.answers.get(id);
    if (!blocks) {
      const provider = call.end.meta.provider ?? call.meta.provider;
      try {
        blocks = normalizeResponse(this.store.getBlob(call.end.responseRef!), call.end.meta.headers?.['content-type'], call.end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined).blocks.filter((b) => b.type !== 'thinking');
      } catch {
        blocks = [];
      }
      this.answers.set(id, blocks);
    }
    return blocks;
  }

  answerKey(call: ModelCall): string {
    const id = this.answerId(call);
    let key = this.keys.answers.get(id);
    if (key === undefined) this.keys.answers.set(id, (key = answerKey(this.answer(call))));
    return key;
  }

  /** What an answer is read by: its bytes, the provider that parses them, and how they were sent. */
  private answerId(call: ModelCall): string {
    const provider = call.end.meta.provider ?? call.meta.provider;
    return `${call.end.responseRef!}:${typeof provider === 'string' ? provider : ''}:${call.end.meta.headers?.['content-type'] ?? ''}`;
  }

  modelOf(call: ModelCall): string | null {
    const m = call.end.meta.model ?? call.meta.model;
    return typeof m === 'string' ? m : null;
  }
}

interface Candidate {
  rejected: { run: RunRecord; call: ModelCall; what: string };
  chosen: { run: RunRecord; call: ModelCall; what: string };
}

/** Runs up to this many model calls are compared call by call; longer ones by halving. */
const WALK = 64;

type Difference = { kind: 'pair'; i: number; ca: ModelCall; cb: ModelCall } | { kind: 'same' } | { kind: 'paths'; at: number };

/** Whether one conversation's turns begin with another's: the later call carries on the earlier one. */
function carriesOn(earlier: string[] | null, later: string[] | null): boolean {
  return earlier !== null && later !== null && earlier.length <= later.length && earlier.every((k, i) => k === later[i]);
}

/** Two attempts compared call by call, up to the first call where their conversations or their answers differ. */
function walk(r: Reader, ma: ModelCall[], mb: ModelCall[], n: number): Difference {
  for (let i = 0; i < n; i++) {
    if (!r.samePrompt(ma[i]!, mb[i]!)) return { kind: 'paths', at: ma[i]!.callNo };
    if (r.answerKey(ma[i]!) !== r.answerKey(mb[i]!)) return { kind: 'pair', i, ca: ma[i]!, cb: mb[i]! };
  }
  return { kind: 'same' };
}

/**
 * The model call where two attempts first answered the same conversation differently, among the
 * calls made in `scope` (all of them when null). They pair there when their answers differ; when the
 * conversations part first, a read returned something else and their paths parted.
 *
 * A short run is compared call by call. A long one is halved: while an agent's conversation grows,
 * two attempts whose conversations parted stay parted, so the last call where they agree is found by
 * keying a handful of calls rather than every one. That holds only while each call carries on the
 * one before it, so halving checks it on every call it read, in both attempts: a call that starts
 * another conversation (a sub-agent, a context that was cut or rewritten) sends the comparison back
 * to call by call. What halving can't see is a side conversation between the calls it read whose
 * answer never comes back into the main one.
 */
function firstDifference(r: Reader, a: RunRecord, b: RunRecord, scope: string | null): Difference {
  const ma = r.modelCalls(a.runId, scope);
  const mb = r.modelCalls(b.runId, scope);
  const n = Math.min(ma.length, mb.length);
  if (n <= WALK) return walk(r, ma, mb, n);
  const read = new Set<number>();
  const agree = (i: number) => {
    read.add(i);
    // Their turns first: one read of each request gives both its key and its turns.
    r.turnKeys(ma[i]!);
    r.turnKeys(mb[i]!);
    return r.samePrompt(ma[i]!, mb[i]!);
  };
  if (!agree(0)) return { kind: 'paths', at: ma[0]!.callNo };
  let lo = 0;
  let hi = n - 1;
  if (agree(hi)) lo = hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (agree(mid)) lo = mid;
    else hi = mid;
  }
  // Up to the first call where they disagree, each call read must carry on the one read before it.
  const chain = [...read].filter((i) => i <= lo + 1).sort((x, y) => x - y);
  const grows = (calls: ModelCall[]) => chain.every((i, j) => j === 0 || carriesOn(r.turnKeys(calls[chain[j - 1]!]!), r.turnKeys(calls[i]!)));
  if (!grows(ma) || !grows(mb)) return walk(r, ma, mb, n);
  if (r.answerKey(ma[lo]!) !== r.answerKey(mb[lo]!)) return { kind: 'pair', i: lo, ca: ma[lo]!, cb: mb[lo]! };
  return lo === n - 1 ? { kind: 'same' } : { kind: 'paths', at: ma[lo + 1]!.callNo };
}

function answerOf(r: Reader, run: RunRecord, call: ModelCall, what: string): PairAnswer {
  const blocks = r.answer(call);
  return { runId: run.runId, callNo: call.callNo, what, text: describeBlocks(blocks, 160), blocks };
}

/**
 * The call of the run a pair is about at the same point as the attempt's call the pair was found at:
 * that run's model call in the same place among them (in the agent's scope), or with the same number,
 * when the path up to it is the same (pathKey), whatever the prompts said. A model list or a tool the
 * agent called by itself moves the numbers but not the place; a step more or less moves both, and
 * then the run never got there. A blame's pair is about the run its rejected answer was recorded in.
 */
function aboutCall(r: Reader, about: RunRecord, run: RunRecord, call: ModelCall, scope: string | null): number | null {
  if (about.runId === run.runId) return call.callNo;
  const theirs = r.modelCalls(about.runId, scope);
  const place = theirs[r.modelCalls(run.runId, scope).indexOf(call)];
  for (const c of [place, theirs.find((x) => x.callNo === call.callNo)]) if (c && r.samePath(c, call)) return c.callNo;
  return null;
}

function makePair(r: Reader, source: PairSource, about: RunRecord, c: Candidate, scope: string | null): Pair | null {
  const key = r.key(c.rejected.call);
  const context = key === null ? null : r.context(c.rejected.call);
  if (key === null || context === null) return null;
  const rejected = answerOf(r, c.rejected.run, c.rejected.call, c.rejected.what);
  const chosen = answerOf(r, c.chosen.run, c.chosen.call, c.chosen.what);
  return {
    // Without the source: the same two answers to the same conversation are one pair, however many found them.
    id: `pr-${sha256(`${key}|${r.answerKey(c.rejected.call)}|${r.answerKey(c.chosen.call)}`).slice(0, 12)}`,
    confidence: source.confidence,
    source: source.key,
    sourceKind: source.kind,
    runId: about.runId,
    callNo: c.rejected.call.callNo,
    aboutCallNo: aboutCall(r, about, c.rejected.run, c.rejected.call, scope),
    context,
    model: r.modelOf(c.rejected.call),
    rejected,
    chosen,
    at: c.chosen.run.startedAt,
  };
}

/**
 * Pairs between the failing and passing attempts of one run (verify) or one `--repeat` invocation.
 * Each failing attempt meets each passing one at the first model call where their answers differ;
 * the pair is kept unless the "rejected" answer also passed from the same point in another attempt,
 * or the "chosen" one also failed from it. The same point is the same conversation at the same call
 * of the attempt, so only the calls pairs come from are read in the others.
 */
function contrast(r: Reader, failing: RunRecord[], passing: RunRecord[], scope: string | null, whatFailed: (run: RunRecord) => string, whatPassed: (run: RunRecord) => string) {
  const answered = (run: RunRecord, i: number, like: ModelCall, answer: string) => {
    const c = r.modelCalls(run.runId, scope)[i];
    return !!c && r.samePrompt(c, like) && r.answerKey(c) === answer;
  };
  const out: Candidate[] = [];
  let same = 0;
  let paths = 0;
  let ambiguous = 0;
  for (const f of failing) {
    for (const p of passing) {
      const d = firstDifference(r, f, p, scope);
      if (d.kind === 'same') {
        same++;
        continue;
      }
      if (d.kind === 'paths') {
        paths++;
        continue;
      }
      const rk = r.answerKey(d.ca);
      const ck = r.answerKey(d.cb);
      if (!rk || !ck || passing.some((x) => x !== p && answered(x, d.i, d.ca, rk)) || failing.some((x) => x !== f && answered(x, d.i, d.ca, ck))) {
        ambiguous++;
        continue;
      }
      out.push({ rejected: { run: f, call: d.ca, what: whatFailed(f) }, chosen: { run: p, call: d.cb, what: whatPassed(p) } });
    }
  }
  return { candidates: out, same, paths, ambiguous };
}

/**
 * Adds candidates as pairs, counting identical ones once across every source: the first source to
 * find a pair keeps it (blame before verify before --repeat, so a pair blame proved stays high).
 * Returns how many were new, and how many another source had already made.
 */
function addPairs(r: Reader, pairs: Pair[], seen: Map<string, PairSource>, source: PairSource, about: RunRecord, candidates: Candidate[], scope: string | null = null): { made: number; elsewhere: number } {
  let made = 0;
  const elsewhere = new Set<string>();
  for (const c of candidates) {
    const pair = makePair(r, source, about, c, scope);
    if (!pair) continue;
    const owner = seen.get(pair.id);
    if (owner) {
      if (owner !== source) elsewhere.add(pair.id);
      continue;
    }
    seen.set(pair.id, source);
    pairs.push(pair);
    made++;
  }
  return { made, elsewhere: elsewhere.size };
}

const already = (n: number) => `${n === 1 ? 'One pair was' : `${n} pairs were`} already made by another source, so ${n === 1 ? 'it counts' : 'they count'} once.`;

/** The invocation a verify attempt belongs to: its group, without the run id verify appends per run. */
function verifyInvocation(run: RunRecord): string {
  const group = run.meta?.repeat?.group;
  const parent = run.parentRunId ?? '';
  if (!group) return `${parent}:${run.codeVersion ?? ''}`;
  return group.endsWith(`-${parent}`) ? group.slice(0, -(parent.length + 1)) : group;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A time on this machine's clock, to the minute or to the second: `2026-10-15 13:07`. */
function localTime(ms: number, seconds = false): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`;
}

/**
 * Blame sources are named by their run's first label (`blame · refund-bug`). Runs labelled alike
 * (every run of one failure, blamed one by one) are told apart by their short ids.
 */
function nameBlames(sources: PairSource[]): void {
  const blames = sources.filter((s) => s.kind === 'blame');
  const count = (label: string) => blames.filter((s) => s.label === label).length;
  for (const s of blames.filter((x) => count(x.label) > 1)) {
    if (!s.label.endsWith(short(s.runId))) s.label = `${s.label} · ${short(s.runId)}`;
  }
}

/**
 * Verify sources are named by the repair candidate they verified (`verify · repair candidate 3`), else
 * by the code they verified (`verify · 370712a+dirty`), else by when they ran. Two verifies named
 * alike are told apart by the second they started, and past that by their order.
 */
function nameVerifies(sources: PairSource[], versions: Map<PairSource, string | null>): void {
  const verifies = sources.filter((s) => s.kind === 'verify');
  const count = (label: string) => verifies.filter((s) => s.label === label).length;
  const clashing = verifies.filter((s) => count(s.label) > 1);
  for (const s of clashing) {
    const version = versions.get(s) ?? null;
    // Candidate 2 of two repairs: each keeps its candidate, told apart by when it ran.
    s.label = s.candidate !== undefined ? `${s.label} · ${localTime(s.at, true).slice(11)}` : version ? `verify · ${version} · ${localTime(s.at, true).slice(11)}` : `verify · ${localTime(s.at, true)}`;
  }
  const seen = new Map<string, number>();
  for (const s of [...clashing].sort((x, y) => x.at - y.at)) {
    if (count(s.label) < 2) continue;
    const n = (seen.get(s.label) ?? 0) + 1;
    seen.set(s.label, n);
    if (n > 1) s.label = `${s.label} (${n})`;
  }
}

const scopeList = (scopes: Array<string | null>) => scopes.map((s) => (s === null ? 'no scope' : s)).join(', ');

/**
 * The scope the agent answers in, for attempts of these recordings: the one a blame of one of them
 * (or of a run it came from) was limited to. When none was, every model call is the agent's if they
 * were all made in one scope; when they were made in several, nothing says which is the agent's.
 */
function agentScope(r: Reader, store: Store, byId: Map<string, RunRecord>, recordings: string[], attempts: RunRecord[]): { scope: string | null } | { several: Array<string | null> } {
  for (const id of recordings) {
    let run = byId.get(id) ?? store.getRun(id);
    for (let depth = 0; run && depth < 100; depth++) {
      const s = run.meta?.blame?.scope;
      if (typeof s === 'string' && s) return { scope: s };
      run = run.parentRunId ? (byId.get(run.parentRunId) ?? store.getRun(run.parentRunId)) : null;
    }
  }
  const scopes = [...new Set(attempts.flatMap((a) => r.scopesOf(a.runId)))];
  return scopes.length > 1 ? { several: scopes } : { scope: null };
}

/**
 * What findPairs last found for a store, and the runs it read it from: the pairs change only when a
 * run does (a new attempt, a blame, a run that ends), so a screen that reads them on every load reads
 * them once.
 */
const memo = new WeakMap<Store, { signature: string; result: PairsResult }>();

/**
 * What pairs are read from: each run's place, outcome and meta (blame, probes, verify, repeat
 * groups). A run still recording is never read for pairs (blame, verify and --repeat read only
 * attempts that ended), so the calls it records change nothing until it ends, and its status says so.
 */
function signature(store: Store, runs: readonly RunRecord[]): string {
  const h = createHash('sha256');
  for (const r of runs) h.update(`${r.runId}|${r.parentRunId ?? ''}|${r.status}|${r.startedAt}|${r.endedAt ?? ''}|${r.codeVersion ?? ''}|${JSON.stringify(r.meta ?? null)}\n`);
  // A repair keeps its report once its candidates are verified: the verifies are named after them then.
  h.update(JSON.stringify(store.query(REPORTS_SQL)));
  return h.digest('hex');
}

const REPORTS_SQL = 'SELECT (SELECT COUNT(*) FROM verdicts) AS verdicts, (SELECT COUNT(*) FROM repairs) AS repairs';

/**
 * The repair candidate each verify attempt checked, by the attempt's run: what the verdicts and the
 * repair reports in the store say, as Fixes names the same verifies ("repair candidate 3").
 */
function candidateAttempts(store: Store): Map<string, number> {
  const out = new Map<string, number>();
  const note = (runs: ReadonlyArray<{ attempts: ReadonlyArray<{ runId: string }> }>, candidate: number) => {
    for (const x of runs) for (const a of x.attempts) if (!out.has(a.runId)) out.set(a.runId, candidate);
  };
  for (const v of store.listVerdicts()) if (v.candidate !== null) note(v.report.runs, v.candidate);
  for (const r of store.listRepairs()) for (const c of r.report.candidates) if (c.verify) note(c.verify.runs, c.id);
  return out;
}

/** Every pair the attempts in the store make, and every source read, including those that made none. */
export function findPairs(store: Store, options: { runs?: RunRecord[] } = {}): PairsResult {
  const runs = options.runs ?? store.allRuns();
  const sig = options.runs ? null : signature(store, runs);
  const known = sig === null ? undefined : memo.get(store);
  if (known && known.signature === sig) return { pairs: [...known.result.pairs], sources: [...known.result.sources] };
  const result = readPairs(store, runs);
  if (sig !== null) memo.set(store, { signature: sig, result });
  return { pairs: [...result.pairs], sources: [...result.sources] };
}

function readPairs(store: Store, runs: RunRecord[]): PairsResult {
  const byId = new Map(runs.map((x) => [x.runId, x]));
  const r = new Reader(store);
  const pairs: Pair[] = [];
  const sources: PairSource[] = [];
  const seen = new Map<string, PairSource>();
  const byStart = (a: RunRecord, b: RunRecord) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId);

  // ---- blame: high ----
  const probes = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const of = run.meta?.probe?.of;
    if (of) probes.set(of, [...(probes.get(of) ?? []), run]);
  }
  for (const run of runs) {
    const blame = run.meta?.blame;
    if (!blame) continue;
    const attempts = (probes.get(run.runId) ?? []).sort(byStart);
    const source: PairSource = { key: `blame:${run.runId}`, kind: 'blame', runId: run.runId, runIds: [run.runId], label: `blame · ${runName(run)}`, confidence: 'high', made: 0, attempts: attempts.length, callNo: blame.callNo, why: '', at: blame.at };
    sources.push(source);
    if (blame.outcome !== 'blamed' || blame.callNo === null) {
      source.why =
        blame.outcome === 'unrescuable'
          ? blame.unsettled === true
            ? 'Not settled from the first model call: blame could not tell whether another answer makes the run pass, so there is none to prefer yet.'
            : 'Not rescued from any model call: no other answer made the run pass, so there is none to prefer.'
          : 'The search stopped before it settled, so no call was blamed.';
      continue;
    }
    const k = blame.callNo;
    const recorded = r.modelCall(run.runId, k);
    if (!recorded || r.key(recorded) === null) {
      source.why = `The recording's answer at #${k} can't be read, so there is nothing to pair it with.`;
      continue;
    }
    const rejectedKey = r.answerKey(recorded);
    const passing = attempts.filter((a) => a.meta?.probe?.callNo === k && a.meta.probe.passed);
    let same = 0;
    let parted = 0;
    const candidates: Candidate[] = [];
    for (const a of passing) {
      const call = r.modelCall(a.runId, k);
      if (!call || !r.samePrompt(call, recorded)) {
        parted++;
        continue;
      }
      const key = r.answerKey(call);
      if (!key || key === rejectedKey) {
        same++;
        continue;
      }
      candidates.push({ rejected: { run, call: recorded, what: 'the recording' }, chosen: { run: a, call, what: 'blame attempt, passed' } });
    }
    if (!rejectedKey) {
      source.why = `The recording's answer at #${k} has no text or tool call, so there is nothing to pair it with.`;
      continue;
    }
    const added = addPairs(r, pairs, seen, source, run, candidates);
    source.made = added.made;
    const differing = candidates.length;
    if (source.made) {
      const dup = differing - source.made - added.elsewhere;
      source.why = `Probe #${k} rescued the run: ${plural(differing, 'attempt')} passed after a different answer at #${k}.${dup ? ` ${dup === 1 ? 'One' : dup} answered like another, so ${dup === 1 ? 'it counts' : 'they count'} once.` : ''}${added.elsewhere ? ` ${already(added.elsewhere)}` : ''}${same ? ` ${plural(same, 'attempt')} that passed answered as the recording did.` : ''}`;
    } else if (added.elsewhere) {
      source.why = `Probe #${k} rescued the run, but another source had already made ${added.elsewhere === 1 ? 'the pair' : `all ${added.elsewhere} pairs`} its attempts make: identical answers count once.`;
    } else if (!passing.length) {
      source.why = `No attempt that passed at #${k} is in the store any more.`;
    } else if (parted === passing.length) {
      source.why = `The attempts that passed at #${k} saw another conversation than the recording, so their answers don't answer the same question.`;
    } else {
      source.why = `Every attempt that passed at #${k} answered as the recording did, so there is nothing to contrast.`;
    }
  }

  // ---- verify: medium ----
  const verifyVersions = new Map<PairSource, string | null>();
  const invocations = new Map<string, RunRecord[]>();
  for (const run of runs) {
    if (!run.meta?.verify || !run.parentRunId) continue;
    const key = verifyInvocation(run);
    invocations.set(key, [...(invocations.get(key) ?? []), run]);
  }
  // A repair verifies each candidate in the working tree: one revision, minutes apart. Each is named by its candidate.
  const candidates = invocations.size ? candidateAttempts(store) : new Map<string, number>();
  for (const [key, attempts] of invocations) {
    attempts.sort(byStart);
    const byRun = new Map<string, RunRecord[]>();
    for (const a of attempts) byRun.set(a.parentRunId!, [...(byRun.get(a.parentRunId!) ?? []), a]);
    const first = attempts[0]!;
    const versions = [...new Set(attempts.map((a) => a.codeVersion).filter((v): v is string => !!v))];
    const candidate = attempts.map((a) => candidates.get(a.runId)).find((n) => n !== undefined);
    const label = candidate !== undefined ? `verify · repair candidate ${candidate}` : `verify · ${versions[0] ?? localTime(first.startedAt)}`;
    const source: PairSource = { key: `verify:${key}`, kind: 'verify', runId: first.parentRunId!, runIds: [...byRun.keys()], label, confidence: 'medium', made: 0, attempts: attempts.length, callNo: null, why: '', at: first.startedAt, ...(candidate !== undefined ? { candidate } : {}) };
    sources.push(source);
    verifyVersions.set(source, versions[0] ?? null);
    // One verify checks one fix to one agent: a blame of any run it replayed says which scope is the agent's.
    const scope = agentScope(r, store, byId, [...byRun.keys()], attempts);
    const mixed: string[] = [];
    const n = { same: 0, paths: 0, ambiguous: 0, elsewhere: 0, scoped: 0 };
    let undecided = 0;
    for (const [runId, list] of byRun) {
      // An attempt verify could not judge (a judge that could not answer, a condition it could not
      // read), or one its provider was unavailable for, neither passed nor failed: it is no answer to
      // prefer another to, and is counted apart.
      const unjudged = (a: RunRecord) => a.meta?.verify?.verdict === 'inconclusive' || a.meta?.verify?.verdict === 'unavailable';
      const unsure = list.filter(unjudged);
      const failing = list.filter((a) => a.meta?.verify?.passed === false && !unjudged(a));
      const passing = list.filter((a) => a.meta?.verify?.passed === true);
      undecided += unsure.length;
      if (!failing.length || !passing.length) continue;
      const role = list[0]!.meta?.verify?.role ?? 'target';
      mixed.push(`${role === 'holdout' ? 'held-out' : role} ${short(runId)} failed ${failing.length} of ${list.length}${unsure.length ? `, ${unsure.length} inconclusive` : ''}`);
      if ('several' in scope) {
        n.scoped++;
        continue;
      }
      const c = contrast(r, failing, passing, scope.scope, () => 'verify attempt, failed', () => 'verify attempt, passed');
      n.same += c.same;
      n.paths += c.paths;
      n.ambiguous += c.ambiguous;
      const about = byId.get(runId) ?? store.getRun(runId);
      if (!about) continue;
      const before = pairs.length;
      const added = addPairs(r, pairs, seen, source, about, c.candidates, scope.scope);
      source.made += added.made;
      n.elsewhere += added.elsewhere;
      if (source.callNo === null && pairs.length > before) source.callNo = pairs[before]!.callNo;
    }
    const none = undecided ? `No run both passed and failed: each passed every attempt it was judged in or none, and ${plural(undecided, 'attempt')} could not be judged.` : 'No run both passed and failed: each passed every attempt or none.';
    source.why = whyContrast(mixed, n, 'several' in scope ? scope.several : [], source.made, none);
  }
  nameVerifies(sources, verifyVersions);
  nameBlames(sources);

  // ---- --repeat: medium, by exit status ----
  const groups = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const m = run.meta;
    // Blame's probes, verify's and test's attempts and a model's scoring attempts all carry a repeat group of their own: none is a --repeat.
    if (!m?.repeat || m.probe || m.verify || m.task || m.test) continue;
    groups.set(m.repeat.group, [...(groups.get(m.repeat.group) ?? []), run]);
  }
  for (const [group, attempts] of groups) {
    attempts.sort(byStart);
    const first = attempts[0]!;
    const parentId = first.parentRunId ?? first.runId;
    const finished = attempts.filter((a) => a.status === 'completed' || a.status === 'failed');
    const passing = finished.filter((a) => a.status === 'completed');
    const failing = finished.filter((a) => a.status === 'failed');
    const of = first.meta?.repeat?.of ?? attempts.length;
    const source: PairSource = { key: `repeat:${group}`, kind: 'repeat', runId: parentId, runIds: [parentId], label: `replay --repeat ${of} · ${short(parentId)}`, confidence: 'medium', made: 0, attempts: attempts.length, callNo: null, why: '', at: first.startedAt };
    sources.push(source);
    if (!failing.length || !passing.length) {
      source.why = !finished.length ? 'No attempt finished, so there is nothing to contrast.' : !failing.length ? `${finished.length === 1 ? 'The attempt' : `All ${finished.length} attempts`} exited 0, so there is nothing to contrast.` : `${finished.length === 1 ? 'The attempt' : `All ${finished.length} attempts`} exited with an error, so there is nothing to contrast.`;
      continue;
    }
    const mixed = [`${failing.length} of ${finished.length} attempts exited with an error`];
    const scope = agentScope(r, store, byId, [parentId], finished);
    if ('several' in scope) {
      source.why = whyContrast(mixed, { same: 0, paths: 0, ambiguous: 0, elsewhere: 0, scoped: 1 }, scope.several, 0, '');
      continue;
    }
    const c = contrast(r, failing, passing, scope.scope, (a) => `attempt, ${a.status === 'failed' ? 'exited with an error' : 'failed'}`, () => 'attempt, exited 0');
    const about = byId.get(parentId) ?? store.getRun(parentId) ?? first;
    const before = pairs.length;
    const added = addPairs(r, pairs, seen, source, about, c.candidates, scope.scope);
    source.made = added.made;
    if (pairs.length > before) source.callNo = pairs[before]!.callNo;
    source.why = whyContrast(mixed, { same: c.same, paths: c.paths, ambiguous: c.ambiguous, elsewhere: added.elsewhere, scoped: 0 }, [], source.made, '');
  }

  const kindOrder: Record<PairSourceKind, number> = { blame: 0, verify: 1, repeat: 2 };
  sources.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || b.at - a.at);
  const order = new Map(sources.map((s, i) => [s.key, i]));
  pairs.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1) || order.get(a.source)! - order.get(b.source)! || a.callNo - b.callNo || a.at - b.at);
  return { pairs, sources };
}

function whyContrast(mixed: string[], n: { same: number; paths: number; ambiguous: number; elsewhere: number; scoped: number }, scopes: Array<string | null>, made: number, none: string): string {
  if (!mixed.length) return none;
  const lines = [`${mixed.join('; ')}.`.replace(/^./, (c) => c.toUpperCase())];
  if (n.scoped) lines.push(`${n.scoped === 1 ? 'Its' : 'Their'} model calls are made in more than one scope (${scopeList(scopes)}), and no blame says which is the agent's, so none is read: blame ${n.scoped === 1 ? 'the run' : 'one of the runs'} with --scope <the agent's>, and its pairs come from that scope's calls.`);
  if (made) lines.push(`Pairs come from the first model call where a failing and a passing attempt answered differently.`);
  if (n.same) lines.push(`${n.same === 1 ? 'Once' : `${n.same} times`} a failing attempt answered every model call as a passing one did: its failure wasn't an answer.`);
  if (n.paths) lines.push(`${n.paths === 1 ? 'Once' : `${n.paths} times`} the attempts saw different conversations before their answers differed, as when a live read returns something else.`);
  if (n.ambiguous) lines.push(`${plural(n.ambiguous, 'answer')} left out: the same answer, from the same point, also passed (or failed) elsewhere.`);
  if (n.elsewhere) lines.push(already(n.elsewhere));
  return lines.join(' ');
}

/** How many pairs there are at each confidence. */
export function countPairs(pairs: readonly Pair[]): { all: number; high: number; medium: number } {
  const high = pairs.filter((p) => p.confidence === 'high').length;
  return { all: pairs.length, high, medium: pairs.length - high };
}

// ---- export ----

export type PairFormat = 'openai-preference' | 'trl';
export const PAIR_FORMATS: PairFormat[] = ['openai-preference', 'trl'];

/** Each format's row, in one line, for the command that writes it. */
export const PAIR_SHAPES: Record<PairFormat, string> = {
  'openai-preference': '{ input: { messages, tools }, preferred_output, non_preferred_output }',
  trl: '{ prompt, chosen, rejected }, as chat messages (with tools when the conversation had them)',
};

export interface PairRowsOptions {
  format: PairFormat;
  /** The project's redaction rules (see redactConversation). */
  redact?: Normalizer[];
}

type Rule = Normalizer & { path: string };

/**
 * Redaction for rows that keep only messages (decision 6): rules without a path apply to every
 * string; rules with a path apply to the message fields kept. A model-call rule's path is a path into
 * the request, so it is applied to the request before its messages are read; a tool rule's
 * `$.args…` path applies to each call of that tool in the conversation and the answers, and its
 * `$.result…` path to the tool's results that are JSON.
 */
function pathRules(rules: readonly Normalizer[]): { api: Rule[]; args: Rule[]; result: Rule[] } {
  const withPath = rules.filter((x): x is Rule => typeof x.path === 'string');
  return {
    api: withPath.filter((x) => x.kind === undefined || x.kind === 'api'),
    args: withPath.filter((x) => x.kind === 'tool' && /^\$\.args(\.|\[|$)/.test(x.path)),
    result: withPath.filter((x) => x.kind === 'tool' && /^\$\.result(\.|\[|$)/.test(x.path)),
  };
}

function redactArgs(name: string, input: unknown, rules: Rule[]): unknown {
  return rules.length ? (applyNormalizers({ args: input }, rules, 'tool', name) as { args: unknown }).args : input;
}

function redactResult(name: string, content: string, rules: Rule[]): string {
  if (!rules.length) return content;
  try {
    const parsed = JSON.parse(content) as unknown;
    return JSON.stringify((applyNormalizers({ result: parsed }, rules, 'tool', name) as { result: unknown }).result);
  } catch {
    return content; // not JSON: a path can't point into it
  }
}

function redactTurns(turns: Turn[], rules: ReturnType<typeof pathRules>): Turn[] {
  if (!rules.args.length && !rules.result.length) return turns;
  const names = new Map<string, string>();
  return turns.map((t) => ({
    ...t,
    blocks: t.blocks.map((b): TurnBlock => {
      if (b.type === 'tool_call') {
        if (b.id) names.set(b.id, b.name);
        return { ...b, input: redactArgs(b.name, b.input, rules.args) };
      }
      if (b.type === 'tool_result') {
        const name = b.name ?? (b.id ? names.get(b.id) : undefined);
        return name ? { ...b, content: redactResult(name, b.content, rules.result) } : b;
      }
      return b;
    }),
  }));
}

function redactDeep(value: unknown, rules: Array<{ re: RegExp; replace: string }>): unknown {
  if (typeof value === 'string') return rules.reduce((s, x) => ((x.re.lastIndex = 0), s.replace(x.re, x.replace)), value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, rules));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, rules)]));
  return value;
}

type ChatMessage = Record<string, unknown>;

/** Dataset messages as OpenAI chat messages: tool call arguments as JSON text. */
function openAIMessage(m: DatasetMessage): ChatMessage {
  if (m.role === 'assistant' && m.tool_calls?.length) {
    return { role: 'assistant', ...(m.content ? { content: m.content } : {}), tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) };
  }
  if (m.role === 'tool') return { role: 'tool', content: m.content, ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) };
  return { role: m.role, content: m.content };
}

/** Dataset messages as Hugging Face chat messages, which TRL's chat templates read: arguments as objects, tool results named. */
function hfMessage(m: DatasetMessage, names: Map<string, string>): ChatMessage {
  if (m.role === 'assistant' && m.tool_calls?.length) {
    for (const c of m.tool_calls) names.set(c.id, c.name);
    return { role: 'assistant', content: m.content, tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments ?? {} } })) };
  }
  if (m.role === 'tool') {
    const name = m.tool_call_id ? names.get(m.tool_call_id) : undefined;
    return { role: 'tool', content: m.content, ...(name ? { name } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) };
  }
  return { role: m.role, content: m.content };
}

function answerMessage(answer: PairAnswer, rules: ReturnType<typeof pathRules>): DatasetMessage {
  const text = answer.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  const calls = answer.blocks.flatMap((b, i) => (b.type === 'tool_call' ? [{ id: b.id ?? `answer_${i + 1}`, name: b.name, arguments: redactArgs(b.name, b.input, rules.args) }] : []));
  return { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) };
}

/**
 * Pairs as rows to train on: the conversation as the model saw it at the call, in the provider-
 * neutral messages `export dataset` writes, and the two answers. Rows whose request can't be read
 * are left out.
 */
export function pairRows(store: Store, pairs: readonly Pair[], options: PairRowsOptions): unknown[] {
  const rules = options.redact ?? [];
  const paths = pathRules(rules);
  const pathless = rules.filter((x) => x.path === undefined && x.pattern !== undefined).map((x) => ({ re: compilePattern(x.pattern!), replace: x.replace }));
  const rows: unknown[] = [];
  const calls = new Map<string, CallRecord[]>();
  for (const pair of pairs) {
    let runCalls = calls.get(pair.rejected.runId);
    if (!runCalls) calls.set(pair.rejected.runId, (runCalls = store.getCalls(pair.rejected.runId)));
    const call = runCalls.find((c) => c.callNo === pair.rejected.callNo);
    if (!call?.requestRef) continue;
    let body: unknown;
    try {
      body = loadApiRequest(store, call.requestRef);
    } catch {
      continue;
    }
    if (paths.api.length) body = applyNormalizers(body, paths.api, 'api', call.name);
    const conv = normalizeConversation(body);
    if (!conv) continue;
    // The rules without a path apply to every string while tool calls' arguments are still objects,
    // as `export dataset` applies them: on the JSON text a format writes them as, a pattern would
    // mask a number or a quote and leave text that no longer parses.
    const mask = <T>(value: T): T => (pathless.length ? (redactDeep(value, pathless) as T) : value);
    const messages = mask(messagesOf(redactTurns(conv.turns, paths)));
    const tools = mask(openAITools(body));
    const chosen = mask(answerMessage(pair.chosen, paths));
    const rejected = mask(answerMessage(pair.rejected, paths));
    let row: unknown;
    if (options.format === 'trl') {
      const names = new Map<string, string>();
      const prompt = messages.map((m) => hfMessage(m, names));
      row = { prompt, chosen: [hfMessage(chosen, new Map(names))], rejected: [hfMessage(rejected, new Map(names))], ...(tools.length ? { tools } : {}) };
    } else {
      row = { input: { messages: messages.map(openAIMessage), ...(tools.length ? { tools } : {}) }, preferred_output: [openAIMessage(chosen)], non_preferred_output: [openAIMessage(rejected)] };
    }
    rows.push(row);
  }
  return rows;
}
