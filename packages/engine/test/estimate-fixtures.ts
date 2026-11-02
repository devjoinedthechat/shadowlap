import { JUDGE_SCOPE } from '../src/judge-scope.js';
import type { CallRecord, Effect, Origin, RunRecord, Usage } from '../src/types.js';

/**
 * A recording worked out by hand for the estimate tests, at the engine's DEFAULT_PRICES (USD per
 * million tokens: claude-sonnet-5 2 in, 10 out, 0.20 a cache read; claude-haiku-4-5 1 in, 5 out;
 * claude-opus-5-5 4 in, 20 out, 0.20 a cache read):
 *
 *   #1 model  claude-sonnet-5   1,000 in, 200 out                  $0.0040
 *   #2 tool   lookup_order (read)
 *   #3 model  claude-sonnet-5   2,000 in, 1,000 cache reads, 100 out  $0.0052
 *   #4 tool   send_email (write)
 *   #5 model  claude-sonnet-5   3,000 in, 300 out                  $0.0090
 *   #6 model  claude-haiku-4-5  the judge's, 500 in, 50 out        $0.00075
 *   #7 tool   archive (read)
 *
 * The agent's calls come to $0.0182, and with the judge's $0.01895.
 */

const use = (inputTokens: number, outputTokens: number, cacheReadInputTokens = 0, cacheCreationInputTokens = 0): Usage => ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens });

export interface ApiOptions {
  scope?: string;
  origin?: Origin;
  /** How it ended: answered, failed, answered by Shadowlap (`injected`), or not at all (`open`). */
  ended?: 'ok' | 'error' | 'injected' | 'open';
  provider?: string;
  /** Its request was kept, as a recording keeps it (an import may not). */
  request?: boolean;
}

/** A model call as the store reads it back, its usage and model on its end. */
export function api(callNo: number, model: string | null, usage: Usage | null, o: ApiOptions = {}): CallRecord {
  const ended = o.ended ?? 'ok';
  return {
    runId: 'run',
    callNo,
    kind: 'api',
    name: 'POST /v1/messages',
    fingerprint: `api-${callNo}`,
    occurrence: 0,
    origin: o.origin ?? 'live',
    effect: null,
    requestRef: o.request === false ? null : `request-${callNo}`,
    meta: { ...(o.scope ? { scope: o.scope } : {}), ...(model ? { model } : {}), ...(o.provider ? { provider: o.provider } : {}) },
    at: callNo,
    end:
      ended === 'open'
        ? null
        : { runId: 'run', callNo, attempt: 0, responseRef: null, outcome: ended === 'error' ? 'error' : 'ok', meta: { ...(usage ? { usage } : {}), ...(model ? { model } : {}), ...(ended === 'injected' ? { injected: true } : {}) }, at: callNo },
    attempts: [],
  };
}

/** A tool call that answered, in `scope` when one is given. */
export function tool(callNo: number, name: string, effect: Effect, origin: Origin = 'live', scope?: string): CallRecord {
  return { runId: 'run', callNo, kind: 'tool', name, fingerprint: `tool-${callNo}`, occurrence: 0, origin, effect, requestRef: null, meta: scope ? { scope } : {}, at: callNo, end: { runId: 'run', callNo, attempt: 0, responseRef: null, outcome: 'ok', meta: {}, at: callNo }, attempts: [] };
}

/** The hand-worked recording above, every call live as recorded. */
export function recording(): CallRecord[] {
  return [
    api(1, 'claude-sonnet-5', use(1000, 200), { provider: 'anthropic' }),
    tool(2, 'lookup_order', 'read'),
    api(3, 'claude-sonnet-5', use(2000, 100, 1000), { provider: 'anthropic' }),
    tool(4, 'send_email', 'write'),
    api(5, 'claude-sonnet-5', use(3000, 300), { provider: 'anthropic' }),
    api(6, 'claude-haiku-4-5', use(500, 50), { scope: JUDGE_SCOPE, provider: 'anthropic' }),
    tool(7, 'archive', 'read'),
  ];
}

/** What each of the recording's model calls costs at DEFAULT_PRICES. */
export const COST = { 1: 0.004, 3: 0.0052, 5: 0.009, 6: 0.00075 } as const;
/** The agent's calls, and with the judge's. */
export const AGENT = 0.0182;
export const ALL = 0.01895;

/** A run record of the recording's shape: recorded, or a replay of it that forked. */
export function runRecord(o: Partial<RunRecord> = {}): RunRecord {
  return { runId: 'run', parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.js'], cwd: '/project' }, codeVersion: null, startedAt: 1, endedAt: 2, ...o };
}
