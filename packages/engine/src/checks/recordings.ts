import { checkStatus } from '../check-status.js';
import { GOOD_LABEL } from '../fixes.js';
import { packHeadRun } from '../golden-consent.js';
import { unpackRun } from '../pack.js';
import { PackError } from '../pack-schema.js';
import type { Price } from '../prices.js';
import { Store } from '../store.js';
import type { CallRecord, RunRecord } from '../types.js';
import { closestName, storedCalls, unreadPaths, type EvaluateOptions, type RecordedCalls } from './evaluate.js';
import { pathsNamed, type CheckResult, type TestSpec } from './grammar.js';
import { judgeRecording } from './recorded.js';

/**
 * Recordings judged by checks from what they recorded, with nothing replayed and no tokens spent,
 * so a check can be tried on every run there is before it is saved: which runs it fails, which it
 * passes, which it can't decide, and how that squares with the labels people gave them (a run
 * labelled `good` it fails, one labelled `bug` it passes). `shadowlap check` prints this report, and
 * the dashboard's check builder judges the agent's recordings by the check being written with it,
 * so the two give the same numbers and the same notes.
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
  /**
   * The recordings by outcome. `notApplicable` counts those that passed only because none of their
   * checks applied (`notApplicable`), and `passed` leaves them out: a check that applied to nothing
   * never counts as passed. The exit status takes them as passed.
   */
  counts: { passed: number; failed: number; inconclusive: number; notApplicable: number };
  /** Recordings given that have no checks to judge them by. */
  unchecked: string[];
  /**
   * What the outcomes say against the runs' labels (recordings labelled good that fail, labelled bug
   * that pass), and the values a check reads that no call it judged has: a misspelt path.
   */
  notes: string[];
}

/** What the outcomes say against the labels people gave the runs: the recordings labelled `label` that a check `fails` or `passes`. */
export interface LabelNote {
  what: 'fails' | 'passes';
  label: string;
  recordings: CheckedRecording[];
}

/**
 * A recording judged that passed only because none of its checks applied: every check came out not
 * applicable, a `when` whose condition never held. It is never counted as passed where the checks
 * are counted (passedWords' rule).
 */
export function notApplicable(r: Pick<CheckedRecording, 'outcome' | 'checks'>): boolean {
  return r.outcome === 'passed' && r.checks.length > 0 && r.checks.every((c) => checkStatus(c) === 'not-applicable');
}

/** The recordings labelled good that fail, and those labelled bug that pass, each a note when there are any. */
export function labelNotes(recordings: readonly CheckedRecording[]): LabelNote[] {
  const goodFails = recordings.filter((x) => x.outcome === 'failed' && x.labels.includes(GOOD_LABEL));
  const bugPasses = recordings.filter((x) => x.outcome === 'passed' && x.labels.includes(BUG_LABEL));
  return [
    ...(goodFails.length ? [{ what: 'fails' as const, label: GOOD_LABEL, recordings: goodFails }] : []),
    ...(bugPasses.length ? [{ what: 'passes' as const, label: BUG_LABEL, recordings: bugPasses }] : []),
  ];
}

/** A recording as a note names it: its pack, else its id's first ten characters. */
const noteId = (x: CheckedRecording): string => x.pack ?? x.runId.slice(0, 10);

/**
 * A label note in words: `fails 2 recordings labelled good: 01K8RG0000, 01K8RG0001`, naming every
 * recording, as `shadowlap check` prints it. With `first`, it names that many and counts the rest:
 * `fails 26 recordings labelled good: a, b, c and 23 more`, or `a, b and c` when there are no more.
 */
export function labelNoteWords(note: LabelNote, o: { first?: number } = {}): string {
  const n = note.recordings.length;
  const ids = note.recordings.map(noteId);
  const first = o.first;
  const named = first === undefined ? ids.join(', ') : ids.length > first ? `${ids.slice(0, first).join(', ')} and ${ids.length - first} more` : ids.length > 1 ? `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)!}` : ids.join('');
  return `${note.what} ${n} recording${n === 1 ? '' : 's'} labelled ${note.label}: ${named}`;
}

/**
 * The values `spec`'s checks read that none of the calls judged by it has, each as a note: a path
 * misspelt, with the name it most likely meant, or the names those calls do have there.
 */
export function unreadNotes(spec: TestSpec, judged: readonly RecordedCalls[]): string[] {
  return unreadPaths(pathsNamed(spec), judged).map((u) => {
    const last = u.path.at(-1);
    const meant = last?.type === 'key' ? closestName(last.key, u.keys) : null;
    return `${u.at} reads ${u.text} from ${u.tool}, which none of the ${u.calls} ${u.tool} call${u.calls === 1 ? '' : 's'} judged has${meant ? `: did you mean ${meant}?` : u.keys.length ? `; they have ${u.keys.join(', ')} there` : ''}`;
  });
}

/**
 * One recording judged by `spec` from what it recorded, from its calls (read from its store unless
 * given): a recording whose checks pass but that exited with an error fails, as its replay would.
 */
export function checkRecording(r: RecordingToCheck & { spec: TestSpec }, o: { prices?: Record<string, Price>; options?: EvaluateOptions } = {}, calls: CallRecord[] = r.store.getCalls(r.run.runId)): CheckedRecording {
  const judged = judgeRecording(r.store, r.run, calls, r.spec, o.prices, o.options);
  const outcome = judged.passed === false ? 'failed' : judged.passed === null ? 'inconclusive' : 'passed';
  return {
    runId: r.run.runId,
    pack: r.pack,
    labels: (r.run.meta?.labels ?? []).filter((l): l is string => typeof l === 'string'),
    source: r.source ?? '--expect',
    outcome,
    why: outcome === 'failed' ? judged.failures : outcome === 'inconclusive' ? judged.unsettled : [],
    checks: judged.checks,
  };
}

/** Judges each recording by its checks, from the recording alone. `read` is handed each recording's calls as they are read. */
export function checkRecordings(recordings: readonly RecordingToCheck[], o: { expect: unknown; prices?: Record<string, Price>; options?: EvaluateOptions; read?: (r: RecordingToCheck, calls: CallRecord[]) => void }): CheckReport {
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
    o.read?.(r, calls);
    const judgedBy = bySpec.get(r.spec) ?? [];
    judgedBy.push({ calls, input: storedCalls(r.store) });
    bySpec.set(r.spec, judgedBy);
    out.push(checkRecording({ ...r, spec: r.spec }, o, calls));
  }
  const na = out.filter(notApplicable).length;
  const count = (k: CheckedRecording['outcome']) => out.filter((x) => x.outcome === k).length;
  const notes = [...labelNotes(out).map((n) => labelNoteWords(n)), ...[...bySpec].flatMap(([spec, judged]) => unreadNotes(spec, judged))];
  return { expect: o.expect ?? null, recordings: out, counts: { passed: count('passed') - na, failed: count('failed'), inconclusive: count('inconclusive'), notApplicable: na }, unchecked, notes };
}

/**
 * The recording a pack holds, read into a store of its own in memory: judging it writes nothing to
 * the project's store, and a pack that can't be read is refused in the words unpacking gives. The
 * caller closes the store.
 */
export function packRecording(dir: string): { run: RunRecord; store: Store } {
  const store = Store.open(':memory:');
  try {
    unpackRun(store, dir);
    const head = packHeadRun(dir);
    const run = head ? store.getRun(head.runId) : null;
    if (!run) throw new PackError(`${dir}: the pack holds no run${head ? ` ${head.runId}` : ' its run.json names last'}`);
    return { run, store };
  } catch (err) {
    store.close();
    throw err;
  }
}
