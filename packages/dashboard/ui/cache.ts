/**
 * Where the prompt cache stopped hitting. One rule, the Context view's and the Overview's: a model
 * call misses when its cache read is smaller than the previous model call's whole input in the same
 * scope and conversation, by at least 1,024 tokens; the tokens sent again are the difference. A
 * conversation that never wrote to the cache is not judged. No DOM here: the tests import it.
 */

export const MISS_MIN_TOKENS = 1024;

export interface UsageCall {
  callNo: number;
  kind: string;
  scope?: string | null;
  /** Which conversation of the run the call belongs to (batch runs hold many); absent means one. */
  conversation?: number | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

/** Everything the model read as input: uncached, written to the cache, and read from it. */
export function wholeInput(u: NonNullable<UsageCall['usage']>): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

export interface CacheMiss {
  callNo: number;
  /** Tokens sent again: what the previous call had in its input and this one did not read from the cache. */
  tokens: number;
}

export function cacheMisses(calls: readonly UsageCall[], min = MISS_MIN_TOKENS): CacheMiss[] {
  const last = new Map<string, NonNullable<UsageCall['usage']>>();
  const out: CacheMiss[] = [];
  for (const c of calls) {
    if (c.kind !== 'api' || !c.usage) continue;
    const key = `${c.scope ?? ''}\u0000${c.conversation ?? 0}`;
    const prev = last.get(key);
    // Only a conversation that uses the cache can miss it: with nothing written or read before, every
    // call would count, and none of them says where a prompt change broke it.
    if (prev && prev.cacheRead + prev.cacheWrite > 0) {
      const gap = wholeInput(prev) - c.usage.cacheRead;
      if (gap >= min) out.push({ callNo: c.callNo, tokens: gap });
    }
    last.set(key, c.usage);
  }
  return out;
}

/** The share of input read from the cache, 0 to 1. */
export function cacheReadShare(calls: readonly UsageCall[]): number {
  let all = 0;
  let read = 0;
  for (const c of calls) {
    if (c.kind !== 'api' || !c.usage) continue;
    all += wholeInput(c.usage);
    read += c.usage.cacheRead;
  }
  return all ? read / all : 0;
}

/**
 * What the Context view says under the chart when the cache never stopped hitting: that the calls
 * read the previous prompt from it, or, for calls that never wrote to it or read from it, that there
 * was nothing to miss.
 */
export function steadyCacheNote(calls: readonly UsageCall[]): string {
  const used = calls.some((c) => c.kind === 'api' && c.usage && c.usage.cacheRead + c.usage.cacheWrite > 0);
  if (!used) return 'No model call here wrote to the prompt cache or read from it, so there was nothing to miss.';
  return calls.some((c) => c.conversation) ? 'Each conversation starts its own context; within each, every model call read the previous prompt from the cache.' : 'Every model call read the previous prompt from the cache.';
}
