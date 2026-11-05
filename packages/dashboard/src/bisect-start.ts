import type { TestResult } from '@shadowlap/engine';

/**
 * Where Find breaking commit starts from a golden's replay, from the golden's results: a revision it
 * passed at before the replay, and those a dialog offers. Whoever asks for several runs reads the
 * results once (`KnownResults`, next-step.ts, a list's rows).
 */

/** How many of a golden's newest results it reads. */
export const GOLDEN_HISTORY = 10_000;

/** What a caller has read of a golden for many of its runs: its results that passed under the checks it has now, newest first, and this run's own. */
export interface KnownResults {
  passes: readonly TestResult[];
  result: TestResult | null;
}

/** Which results a search from a golden's replay may start from. */
export interface StartBefore {
  /** Before the replay. */
  before: number;
  /** At another commit than its own. */
  own: string | null;
  /** The recording the replay failed on. */
  recording: string | null;
}

/** A revision tested as committed. */
export const clean = (rev: string | null): rev is string => !!rev && !rev.endsWith('+dirty');

const startsAt = (r: TestResult, o: StartBefore): r is TestResult & { revision: string } => r.at < o.before && clean(r.revision) && r.revision !== o.own;

/**
 * Where a search starts from, among results that passed under the checks the golden has now, newest
 * first: the first pass of the recording the replay failed on, else the first. An earlier recording
 * of the golden (before an update), or a pass under other checks, may be a commit where it already
 * fails.
 */
export function startFromPasses(passes: readonly TestResult[], o: StartBefore): string | null {
  let first: string | null = null;
  for (const r of passes) {
    if (!startsAt(r, o)) continue;
    first ??= r.revision;
    if (!o.recording || r.goldenRunId === o.recording) return r.revision;
  }
  return first;
}

/** Each revision a golden ran at before the replay, newest first, and how it did there: what a dialog offers. */
export function revisionsBefore(history: readonly TestResult[], o: StartBefore, verdictOf: (r: TestResult) => string): Array<{ rev: string; at: number; runs: number; failed: number; inconclusive: number }> {
  const at = new Map<string, { rev: string; at: number; runs: number; failed: number; inconclusive: number }>();
  for (const r of history) {
    if (!startsAt(r, o)) continue;
    const row = at.get(r.revision) ?? { rev: r.revision, at: r.at, runs: 0, failed: 0, inconclusive: 0 };
    row.runs++;
    const verdict = verdictOf(r);
    if (verdict === 'failed') row.failed++;
    else if (verdict === 'inconclusive') row.inconclusive++;
    row.at = Math.max(row.at, r.at);
    at.set(r.revision, row);
  }
  return [...at.values()].sort((a, b) => b.at - a.at);
}
