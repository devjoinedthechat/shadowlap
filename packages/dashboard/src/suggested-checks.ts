import { FixIdError, resolveFix, suggestChecks, type CheckSuggestion, type Store, type StoredFix } from '@shadowlap/engine';
import { answer, failed, type ReadAnswer, type ReadTable } from './read-registry.js';

/**
 * The check builder's suggested checks, a pooled read (routes/checks.ts asks it): at most three rules
 * that fail a failed recording and none of the good runs it is compared with, its fix's and the agent's
 * recordings labelled good, mined and judged by the engine's suggestChecks from what the recordings
 * hold. Nothing is replayed, sent or written. Finding the good runs reads every run's record, so it is
 * worked out beside the server.
 */

export type { CheckSuggestion, SuggestedRule, SuggestionShape } from '@shadowlap/engine';

export type CheckSuggestionsJob = {
  kind: 'check-suggestions';
  /** The failed recording. */
  runId: string;
  /** The number of the call the check is made from; null in a fix's builder, which is made from none. */
  at: number | null;
  /** The labels of the checks the builder holds: a rule among them is left out. */
  have: string[];
  max: number;
  /** In a fix's builder, the fix whose good runs come first, by its id or a unique prefix of it; null for a check made from a call, which takes the fix the run fails in. */
  fix: string | null;
};

export interface CheckSuggestions {
  runId: string;
  /** The good runs the run is compared with, none of which a suggestion fails, the fix's first. */
  goods: string[];
  suggestions: CheckSuggestion[];
}

/**
 * The fix a fix's builder names, found as Fixes finds one (`resolveFix`: its id or a unique prefix of
 * it), when it holds the run as failing; else why not, a prefix several fixes share in its own words.
 */
function fixHolding(store: Store, id: string, runId: string): { fix: StoredFix } | { why: string } {
  let fix: StoredFix | null;
  try {
    fix = resolveFix(store, id);
  } catch (err) {
    if (err instanceof FixIdError) return { why: err.message };
    throw err;
  }
  return fix && store.fixLinks(fix.fixId, 'failing').some((l) => l.ref === runId) ? { fix } : { why: `no fix ${id.slice(0, 40)} holds this run as failing` };
}

function checkSuggestions(store: Store, job: CheckSuggestionsJob): ReadAnswer {
  const run = store.getRun(job.runId);
  if (!run) return failed(404, `no run ${job.runId}`);
  let fix: StoredFix | undefined;
  if (job.fix !== null) {
    const held = fixHolding(store, job.fix, run.runId);
    if ('why' in held) return failed(404, held.why);
    fix = held.fix;
  }
  const out = suggestChecks(store, run, { at: job.at, have: job.have, max: job.max, ...(fix ? { fix } : {}) });
  const body: CheckSuggestions = { runId: run.runId, goods: out.goods.map((r) => r.runId), suggestions: out.suggestions };
  return answer(body);
}

export const SUGGEST_READS: ReadTable<CheckSuggestionsJob> = {
  'check-suggestions': (store, job) => checkSuggestions(store, job),
};
