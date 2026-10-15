import { Lru, runConversations, type RunConversations } from './conversations.js';
import { storedModelResolver } from './report.js';
import { shortModel } from './prices.js';
import type { Store } from './store.js';
import type { CallRecord, RunRecord, Usage } from './types.js';

/**
 * Where the prompt cache stopped hitting. One rule, used by the run page's Context view, its
 * header and the Overview alike:
 *
 * A model call misses when its cache read is smaller than the previous model call's whole input
 * (uncached, written and read) in the same scope and conversation, by at least 1,024 tokens. The
 * tokens sent again are the difference. A conversation's first call is never a miss: it has no
 * previous call to have cached, which is why a batch run's forty conversations don't flag forty
 * misses. A call is judged when its cache read is known: Anthropic and OpenAI report it (zero
 * included), Gemini leaves it out when it read nothing. A server that reports no cache at all (a
 * local model behind an OpenAI-compatible API) has no cache read to compare.
 */

/** The smallest shortfall that counts as a miss: below it, the difference is the newest turn, not a broken prefix. */
export const CACHE_MISS_MIN_TOKENS = 1024;

/** Every input token of a call: uncached, written to the cache and read from it. */
export function wholeInput(u: Usage): number {
  return u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
}

export interface CacheMiss {
  callNo: number;
  /** Tokens sent again: the previous call's whole input less this call's cache read. */
  sentAgain: number;
  /** The model call it is judged against. */
  previousCallNo: number;
  scope: string | null;
  conversation: number | null;
}

export interface RunCache {
  /** The share of live model calls' input read from the cache; null when no live model call reported usage. Model calls means turns of a conversation: embeddings and token counts read no prompt cache. */
  readShare: number | null;
  /** The same over every model call that reported usage, replayed ones with their recorded numbers. */
  readShareAll: number | null;
  /** Input tokens of live model calls, and how many of them were read from the cache. */
  liveInput: number;
  liveRead: number;
  /** Every miss, in call order, whatever the call's origin. */
  misses: CacheMiss[];
  /** Tokens sent again over all misses. */
  sentAgain: number;
}

const live = (c: CallRecord) => c.origin === 'live' && !c.end?.meta.injected;
const scopeOf = (c: CallRecord) => (typeof c.meta.scope === 'string' ? c.meta.scope : null);

/** Gemini's own API and Gemini models on Vertex: usage leaves the cached count out when it is zero. */
const GEMINI = /:(?:stream)?generateContent\b/i;

/** The tokens a call read from the prompt cache, when its provider says; null when it reports no cache. */
export function cacheRead(c: CallRecord, u: Usage): number | null {
  if (typeof u.cacheReadInputTokens === 'number') return u.cacheReadInputTokens;
  const provider = c.end?.meta.provider ?? c.meta.provider;
  return provider === 'gemini' || GEMINI.test(c.name) ? 0 : null;
}

/** The rule over one run's calls, with its conversations already found. */
export function cacheMisses(calls: readonly CallRecord[], conversations: RunConversations): RunCache {
  const prev = new Map<number, CallRecord>();
  const misses: CacheMiss[] = [];
  let liveInput = 0;
  let liveRead = 0;
  let allInput = 0;
  let allRead = 0;
  for (const c of calls) {
    // Model calls that are turns of a conversation: an embedding or a token count reads no prompt cache.
    const u = c.kind === 'api' ? c.end?.meta.usage : undefined;
    const n = conversations.byCall.get(c.callNo)?.conversation ?? null;
    if (!u || n === null || !conversations.requests.has(c.callNo)) continue;
    const read = cacheRead(c, u);
    allInput += wholeInput(u);
    allRead += read ?? 0;
    if (live(c)) {
      liveInput += wholeInput(u);
      liveRead += read ?? 0;
    }
    const p = prev.get(n);
    prev.set(n, c);
    if (!p || read === null) continue;
    const sentAgain = wholeInput(p.end!.meta.usage!) - read;
    if (sentAgain >= CACHE_MISS_MIN_TOKENS) misses.push({ callNo: c.callNo, sentAgain, previousCallNo: p.callNo, scope: scopeOf(c), conversation: n });
  }
  return {
    readShare: liveInput ? liveRead / liveInput : null,
    readShareAll: allInput ? allRead / allInput : null,
    liveInput,
    liveRead,
    misses,
    sentAgain: misses.reduce((s, m) => s + m.sentAgain, 0),
  };
}

/** The rule over one run, reading what it needs from the store. */
export function runCache(store: Store, calls: readonly CallRecord[]): RunCache {
  return cacheMisses(calls, runConversations(store, calls));
}

export interface CacheUseMiss {
  runId: string;
  callNo: number;
  sentAgain: number;
  /** The model, shortened as the run page shows it. */
  model: string | null;
  scope: string | null;
  startedAt: number;
}

export interface CacheUse {
  /** The share of live model calls' input read from the cache; null without live model calls. */
  readShare: number | null;
  liveInput: number;
  liveRead: number;
  /** Misses among live model calls, and the tokens they sent again. */
  misses: number;
  sentAgain: number;
  /** The largest misses among live calls, largest first. */
  largest: CacheUseMiss[];
  /** Runs that had live model calls reporting usage. */
  runs: number;
}

export interface CacheUseOptions {
  /** Runs started before this time only (exclusive): last week against this one. */
  until?: number;
  /** How many of the largest misses to keep (4, as the Overview shows). */
  limit?: number;
}

/** One run's part of `cacheUse`: its live input and reads, and its misses among live calls; null without live usage. */
type RunUse = { liveInput: number; liveRead: number; misses: CacheUseMiss[] } | null;

/** Each finished run's part, per store: a finished run's calls never change, so the Overview reads them once. */
const finishedUse = new WeakMap<Store, Lru<string, RunUse>>();

function runUse(store: Store, run: RunRecord, modelOf: ReturnType<typeof storedModelResolver>): RunUse {
  const calls = store.getCalls(run.runId);
  if (!calls.some((c) => c.kind === 'api' && live(c) && c.end?.meta.usage)) return null;
  const r = runCache(store, calls);
  if (!r.liveInput) return null;
  const byNo = new Map(calls.map((c) => [c.callNo, c]));
  const misses: CacheUseMiss[] = [];
  for (const m of r.misses) {
    const c = byNo.get(m.callNo)!;
    if (!live(c)) continue;
    const model = c.end?.meta.model ?? c.meta.model ?? modelOf(c) ?? null;
    misses.push({ runId: run.runId, callNo: m.callNo, sentAgain: m.sentAgain, model: model ? shortModel(model) : null, scope: m.scope, startedAt: run.startedAt });
  }
  return { liveInput: r.liveInput, liveRead: r.liveRead, misses };
}

/**
 * Live model calls' cache use across the runs started since `since` (ms since the epoch): the
 * share of their input read from the cache, and the largest misses. Runs imported from a pack or a
 * capture are left out: their calls were live somewhere else. A finished run is worked out once
 * per store; a run still recording is read again each time.
 */
export function cacheUse(store: Store, since: number, options: CacheUseOptions = {}): CacheUse {
  const limit = options.limit ?? 4;
  const runs = store.allRuns().filter((r) => r.startedAt >= since && (options.until === undefined || r.startedAt < options.until) && !importedRecording(r));
  const modelOf = storedModelResolver(store);
  let known = finishedUse.get(store);
  if (!known) finishedUse.set(store, (known = new Lru(8192)));
  let liveInput = 0;
  let liveRead = 0;
  let counted = 0;
  let misses = 0;
  let sentAgain = 0;
  const all: CacheUseMiss[] = [];
  for (const run of runs) {
    const finished = run.status !== 'running' ? `${run.runId}\n${run.status}\n${run.endedAt ?? ''}` : null;
    let use = finished === null ? undefined : known.get(finished);
    if (use === undefined) {
      use = runUse(store, run, modelOf);
      if (finished !== null) known.set(finished, use);
    }
    if (!use) continue;
    counted++;
    liveInput += use.liveInput;
    liveRead += use.liveRead;
    for (const m of use.misses) {
      misses++;
      sentAgain += m.sentAgain;
      all.push({ ...m });
    }
  }
  all.sort((a, b) => b.sentAgain - a.sentAgain || b.startedAt - a.startedAt || a.callNo - b.callNo);
  return { readShare: liveInput ? liveRead / liveInput : null, liveInput, liveRead, misses, sentAgain, largest: all.slice(0, limit), runs: counted };
}

function importedRecording(run: RunRecord): boolean {
  return !!run.meta?.imported && run.mode === 'record';
}
