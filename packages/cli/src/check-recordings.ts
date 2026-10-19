import { GOOD_LABEL, Store, unpackRun, type RunRecord } from '@shadowlap/engine';
import { judgeRecording } from './attempts.js';
import { closestName, pathsNamed, storedCalls, unreadPaths, type CheckResult, type EvaluateOptions, type RecordedCalls, type TestSpec } from './checks.js';
import { type ShadowlapConfig } from './config.js';
import { readPackHead } from './goldens.js';

/**
 * `shadowlap check`: recordings judged by checks from what they recorded, with nothing replayed and
 * no tokens spent, so a check can be tried on every run there is before it is saved: which runs it
 * fails, which it passes, which it can't decide, and how that squares with the labels people gave
 * them (a run labelled `good` it fails, one labelled `bug` it passes). The dashboard's check builder
 * shows the same report while a check is being written.
 */

/** The label a run that went wrong is given, beside `good` for one that went right. */
export const BUG_LABEL = 'bug';

/** A recording to judge: a run in the store, or the recording a pack holds (read into a store of its own). */
export interface RecordingToCheck {
  run: RunRecord;
  store: Store;
  /** The pack it came from, as given; null for a run of the store. */
  pack: string | null;
  /** Its checks, and where they came from: `--expect`, or the recording directory of its `tests` entry. */
  spec: TestSpec | null;
  source: string | null;
}

export interface CheckedRecording {
  runId: string;
  pack: string | null;
  labels: string[];
  /** Where its checks came from: `--expect`, or the recording directory of its `tests` entry. */
  source: string;
  /** passed, failed, or inconclusive when the recording can't settle it. */
  outcome: 'passed' | 'failed' | 'inconclusive';
  /** Why it failed or could not be settled. */
  why: string[];
  checks: CheckResult[];
}

export interface CheckReport {
  /** The checks as `--expect` gave them, or null when each recording was judged by its own. */
  expect: unknown;
  recordings: CheckedRecording[];
  counts: { passed: number; failed: number; inconclusive: number };
  /** Recordings given that have no checks to judge them by. */
  unchecked: string[];
  /**
   * What the outcomes say against the runs' labels (recordings labelled good that fail, labelled bug
   * that pass), and the values a check reads that no call it judged has: a misspelt path.
   */
  notes: string[];
}

/** Judges each recording by its checks, from the recording alone. */
export function checkRecordings(recordings: readonly RecordingToCheck[], o: { expect: unknown; prices?: ShadowlapConfig['prices']; options?: EvaluateOptions }): CheckReport {
  const out: CheckedRecording[] = [];
  const unchecked: string[] = [];
  // The calls judged by each spec, for the values its checks read that none of them has.
  const bySpec = new Map<TestSpec, RecordedCalls[]>();
  for (const r of recordings) {
    if (!r.spec) {
      unchecked.push(r.pack ?? r.run.runId);
      continue;
    }
    const calls = r.store.getCalls(r.run.runId);
    bySpec.set(r.spec, [...(bySpec.get(r.spec) ?? []), { calls, input: storedCalls(r.store) }]);
    // A recording whose checks pass but that exited with an error fails, as its replay would.
    const judged = judgeRecording(r.store, r.run, calls, r.spec, o.prices, o.options);
    const outcome = judged.passed === false ? 'failed' : judged.passed === null ? 'inconclusive' : 'passed';
    out.push({
      runId: r.run.runId,
      pack: r.pack,
      labels: (r.run.meta?.labels ?? []).filter((l): l is string => typeof l === 'string'),
      source: r.source ?? '--expect',
      outcome,
      why: outcome === 'failed' ? judged.failures : outcome === 'inconclusive' ? judged.unsettled : [],
      checks: judged.checks,
    });
  }
  const count = (k: CheckedRecording['outcome']) => out.filter((x) => x.outcome === k).length;
  const ids = (xs: CheckedRecording[]) => xs.map((x) => x.pack ?? x.runId.slice(0, 10)).join(', ');
  const notes: string[] = [];
  const goodFails = out.filter((x) => x.outcome === 'failed' && x.labels.includes(GOOD_LABEL));
  const bugPasses = out.filter((x) => x.outcome === 'passed' && x.labels.includes(BUG_LABEL));
  if (goodFails.length) notes.push(`fails ${goodFails.length} recording${goodFails.length === 1 ? '' : 's'} labelled ${GOOD_LABEL}: ${ids(goodFails)}`);
  if (bugPasses.length) notes.push(`passes ${bugPasses.length} recording${bugPasses.length === 1 ? '' : 's'} labelled ${BUG_LABEL}: ${ids(bugPasses)}`);
  for (const [spec, judgedCalls] of bySpec) {
    for (const u of unreadPaths(pathsNamed(spec), judgedCalls)) {
      const last = u.path.at(-1);
      const meant = last?.type === 'key' ? closestName(last.key, u.keys) : null;
      notes.push(`${u.at} reads ${u.text} from ${u.tool}, which none of the ${u.calls} ${u.tool} call${u.calls === 1 ? '' : 's'} judged has${meant ? `: did you mean ${meant}?` : u.keys.length ? `; they have ${u.keys.join(', ')} there` : ''}`);
    }
  }
  return { expect: o.expect ?? null, recordings: out, counts: { passed: count('passed'), failed: count('failed'), inconclusive: count('inconclusive') }, unchecked, notes };
}

/**
 * The recording a pack holds, read into a store of its own in memory: judging it writes nothing to
 * the project's store. The caller closes the store.
 */
export function packRecording(dir: string): { run: RunRecord; store: Store } {
  const head = readPackHead(dir);
  if ('error' in head) throw new Error(`${dir}: ${head.error}`);
  const store = Store.open(':memory:');
  try {
    unpackRun(store, dir);
    const run = store.getRun(head.runId);
    if (!run) throw new Error(`${dir}: the pack holds no run ${head.runId}`);
    return { run, store };
  } catch (err) {
    store.close();
    throw err;
  }
}
