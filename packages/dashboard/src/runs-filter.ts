import type { RunRecord, StoreOf, TestResult } from '@shadowlap/engine';
import type { IndexedRun, RunIndex } from './run-index.js';

/**
 * What the run lists read besides the index's own fields to say which runs failed: a test replay
 * whose golden passed when it ran again since is fixed by that run (`fixed by <run>`), and a capture
 * failed by the verdict its import kept. The Failed chip, `types=failed`, the days' failures and each
 * row's `failed` read the same set (`listFailed`), so the chip, the bars and Status agree.
 */

/**
 * The newest replay of a golden that passed since this run, made after it and still in the store;
 * null when none has. `results`: the golden's, newest first, where the caller has read them.
 */
export function passedSince(store: StoreOf<'recording' | 'tests'>, run: Pick<RunRecord, 'runId' | 'startedAt'>, golden: string, results: readonly TestResult[] = store.listTestResults({ golden, since: run.startedAt, limit: 50 })): string | null {
  for (const r of results) {
    if (r.at < run.startedAt) break;
    if (!r.ok || !r.runId || r.runId === run.runId) continue;
    const passed = store.getRun(r.runId);
    if (passed && passed.startedAt >= run.startedAt) return passed.runId;
  }
  return null;
}

/** A test replay of its own that failed: what a later passing replay of its golden fixes. */
const fixable = (r: IndexedRun): r is IndexedRun & { meta: { test: { golden: string } } } => r.kind === 'test' && !r.attemptKind && r.failed && !!r.meta.test?.golden;

/** The most of a golden's results read back to its oldest failed replay: a passing replay is among the newest. */
const RESULTS_READ = 1000;

const fixedKept = new WeakMap<object, { key: string; fixed: ReadonlyMap<string, string> }>();

/**
 * Each failed test replay whose golden passed when it ran again since, with the run that passed: its
 * golden's results read once for all its failed replays, kept until runs or the tests' results move.
 */
export function fixedByOf(store: StoreOf<'recording' | 'tests' | 'activity'>, index: RunIndex): ReadonlyMap<string, string> {
  const key = `${index.revision}|${index.runs.length}|${store.changeCounts().tests ?? 0}`;
  const kept = fixedKept.get(index);
  if (kept?.key === key) return kept.fixed;
  const byGolden = new Map<string, Array<IndexedRun & { meta: { test: { golden: string } } }>>();
  for (const r of index.runs) {
    if (!fixable(r)) continue;
    const list = byGolden.get(r.meta.test.golden);
    if (list) list.push(r);
    else byGolden.set(r.meta.test.golden, [r]);
  }
  const fixed = new Map<string, string>();
  for (const [golden, failed] of byGolden) {
    const since = Math.min(...failed.map((r) => r.startedAt));
    const results = store.listTestResults({ golden, since, limit: RESULTS_READ });
    for (const r of failed) {
      const by = passedSince(store, r, golden, results);
      if (by) fixed.set(r.runId, by);
    }
  }
  fixedKept.set(index, { key, fixed });
  return fixed;
}

/**
 * Whether a run counts as failed in the lists: it failed and no later replay of its golden fixed it,
 * or it is a capture whose import judged it failed. A capture judged again since the rules changed
 * reads the verdict it kept until its row is judged.
 */
export const listFailed = (r: IndexedRun, fixed: ReadonlyMap<string, string>): boolean => (r.failed || r.meta.judged === 'failed') && !fixed.has(r.runId);
