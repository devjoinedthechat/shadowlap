import { kindLabel, runKind, type ClassifiableRun, type KindFacts } from './classify.js';
import { storedModelResolver, type ModelResolver } from './report.js';
import type { StoreOf } from './store.js';

// A run's kind in words, and the model of each of its calls, as the terminal UI and the dashboard both
// show them: worked out here, in the engine, so the dashboard needs nothing of the terminal UI.

/** One resolver per store: it caches request lookups for runs recorded before the model was stored per call. */
const resolvers = new WeakMap<object, ModelResolver>();
export function modelResolver(store: StoreOf<'recording'>): ModelResolver {
  let r = resolvers.get(store);
  if (!r) {
    r = storedModelResolver(store);
    resolvers.set(store, r);
  }
  return r;
}

/** What runLabel reads of a run: a RunRecord, or the same fields from a lighter query. */
export type LabelledRun = Pick<ClassifiableRun, 'mode' | 'status' | 'divergence' | 'meta'>;

/**
 * What a run's kind depends on besides the run: its calls and, for a replay that exited with an
 * error without leaving its recording, the run it replayed, since a replay that served every call
 * of a recording that failed the same way reproduced that failure (a clean replay). The run it
 * replayed is read only then.
 */
export function kindFacts(store: StoreOf<'recording'>, run: LabelledRun & Pick<ClassifiableRun, 'runId' | 'parentRunId'>, calls: number): KindFacts {
  if (run.mode !== 'replay' || run.divergence || run.status !== 'failed' || !run.parentRunId) return { calls };
  const parent = store.getRun(run.parentRunId);
  // The agent's calls on both sides: a judge check's calls are none of what the replay reproduced.
  return { calls: store.countAgentCalls(run.runId), parent: parent ? { calls: store.countAgentCalls(parent.runId), status: parent.status } : null };
}

/**
 * A run's kind in words: recording, capture, fork @n, clean replay, replay or test. The engine's
 * classification decides, as it does for the dashboard's run list. Given only a call count, a
 * replay that exited with an error is not called clean: pass `kindFacts` for that.
 */
export function runLabel(run: LabelledRun, facts: number | KindFacts): string {
  return kindLabel(runKind(run, typeof facts === 'number' ? { calls: facts } : facts), run.divergence);
}
