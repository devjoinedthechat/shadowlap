import { suggestChecks, type CheckSuggestion, type Store, type StoredFix } from '@shadowlap/engine';
import { answer, failed, type ReadAnswer, type ReadTable } from './read-registry.js';

/**
 * The check builder's suggested checks, a pooled read (routes/checks.ts asks it): at most three rules
 * that fail a failed recording and pass every good run it is compared with, its fix's and the agent's
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
  /** In a fix's builder, the fix whose good runs come first; null for a check made from a call, which takes the fix the run fails in. */
  fix: string | null;
};

export interface CheckSuggestions {
  runId: string;
  /** The good runs each suggestion passes, the fix's first. */
  goods: string[];
  suggestions: CheckSuggestion[];
}

function checkSuggestions(store: Store, job: CheckSuggestionsJob): ReadAnswer {
  const run = store.getRun(job.runId);
  if (!run) return failed(404, `no run ${job.runId}`);
  let fix: StoredFix | undefined;
  if (job.fix !== null) {
    const found = store.getFix(job.fix);
    if (!found || !store.fixLinks(found.fixId, 'failing').some((l) => l.ref === run.runId)) return failed(404, `no fix ${job.fix} holds this run as failing`);
    fix = found;
  }
  const out = suggestChecks(store, run, { at: job.at, have: job.have, max: job.max, ...(fix ? { fix } : {}) });
  const body: CheckSuggestions = { runId: run.runId, goods: out.goods.map((r) => r.runId), suggestions: out.suggestions };
  return answer(body);
}

export const SUGGEST_READS: ReadTable<CheckSuggestionsJob> = {
  'check-suggestions': (store, job) => checkSuggestions(store, job),
};
