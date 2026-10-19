/**
 * The scope Shadowlap's judge makes its calls in. A judge call is recorded in the run like any
 * model call, but it is none of the agent's: replay strictness, the ended-early check, the run's
 * summary and every check on the agent leave it out. Kept apart from judge.ts so the session and
 * the summary need nothing else of it.
 */

/** The scope judge calls are made in. An agent's own `scope()` can't use it (see RESERVED_SCOPE_PREFIX). */
export const JUDGE_SCOPE = 'shadowlap:judge';

/** Scopes that start with this are Shadowlap's own: the sidecar refuses an agent's call that claims one. */
export const RESERVED_SCOPE_PREFIX = 'shadowlap:';

/** A call Shadowlap's judge made, not the agent. */
export function isJudgeCall(call: { meta: { scope?: unknown } }): boolean {
  return call.meta.scope === JUDGE_SCOPE;
}

/** The agent's own calls: every call but the judge's. */
export function agentCallsOf<T extends { meta: { scope?: unknown } }>(calls: readonly T[]): T[] {
  return calls.some(isJudgeCall) ? calls.filter((c) => !isJudgeCall(c)) : (calls as T[]);
}

/** The judge's calls in a run. */
export function judgeCallsOf<T extends { meta: { scope?: unknown } }>(calls: readonly T[]): T[] {
  return calls.filter(isJudgeCall);
}
