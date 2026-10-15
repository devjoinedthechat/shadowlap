import { ktok, num } from './format.js';

/**
 * Where the prompt cache stopped hitting. One rule, the Context view's and the Overview's, as the
 * run page's read model judges it on the server: a model call misses when its cache read is smaller
 * than the previous model call's whole input in the same scope and conversation, by at least 1,024
 * tokens; the tokens sent again are the difference. A conversation's first call is never a miss. An
 * agent that never caches its prompt therefore sends each turn's history again, and every such turn
 * counts. No DOM here: the tests import it.
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
    if (prev) {
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

/** Whether any model call wrote to the prompt cache or read from it. */
export function usedCache(calls: readonly UsageCall[]): boolean {
  return calls.some((c) => c.kind === 'api' && !!c.usage && c.usage.cacheRead + c.usage.cacheWrite > 0);
}

/**
 * What the Context view says under the chart: a bold lead, then the rest, where a request path is
 * set in code. Where the cache stopped hitting, with the tokens sent again, and on a fork whose
 * change made a miss, the path that changed; for calls that never used the cache, that each turn
 * sent the conversation so far again, since no change to the prompt is to blame. Without misses,
 * that the calls read the previous prompt from the cache, or that nothing used it.
 */
export function cacheNote(calls: readonly UsageCall[], misses: readonly CacheMiss[], changed: { callNo: number; path: string | null } | null = null): { lead: string | null; parts: Array<string | { code: string }> } {
  const used = usedCache(calls);
  if (misses.length) {
    const tokens = num(misses.reduce((s, m) => s + m.tokens, 0));
    if (!used) return { lead: 'No model call here read from the prompt cache.', parts: [`Each turn sent the conversation so far again: ${tokens} tokens.`] };
    const at = misses
      .slice(0, 8)
      .map((m) => `#${m.callNo}`)
      .join(', ');
    const lead = `The cache stopped hitting at ${at}${misses.length > 8 ? ` and ${misses.length - 8} more` : ''}.`;
    const tail = 'A change early in the prompt does this to every call after it.';
    if (changed?.path && misses.some((m) => m.callNo === changed.callNo)) return { lead, parts: ['The prompt changed at ', { code: changed.path }, `, so everything after it was written to the cache again: ${tokens} tokens. ${tail}`] };
    return { lead, parts: [`${tokens} tokens were sent again. ${tail}`] };
  }
  if (!used) return { lead: null, parts: ['No model call here wrote to the prompt cache or read from it, and none sent 1,024 tokens of its conversation again.'] };
  return { lead: null, parts: [calls.some((c) => c.conversation) ? 'Each conversation starts its own context; within each, every model call read the previous prompt from the cache.' : 'Every model call read the previous prompt from the cache.'] };
}

/**
 * The Context view's third number: where the cache stopped hitting (the first six, then how many
 * more), or, for calls that never used the cache, the tokens sent again in all, since every turn
 * after the first would be listed.
 */
export function missStat(calls: readonly UsageCall[], misses: readonly CacheMiss[]): { value: string; label: string; warn: boolean } {
  if (!misses.length) return { value: 'none', label: 'where the cache stopped hitting', warn: false };
  if (!usedCache(calls)) return { value: ktok(misses.reduce((s, m) => s + m.tokens, 0)), label: 'tokens sent again, turn after turn', warn: true };
  const shown = misses.slice(0, 6).map((m) => `#${m.callNo}`).join(', ');
  return { value: `${shown}${misses.length > 6 ? ` +${misses.length - 6}` : ''}`, label: 'where the cache stopped hitting', warn: true };
}
