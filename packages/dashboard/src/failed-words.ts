import { checkStatus, checkWords, FAILURE_WORDS, failureReason, keptCaptureVerdict, type RunRecord, shortRunId, type StoredCheck } from '@shadowlap/engine';
import type { IndexedRun } from './run-index.js';
import type { RunJudged } from './run-outcome.js';

/*
 * What a failed run failed on, in the words a list says it: Runs' issues (issues.ts) title and key
 * a failure with them, as the fix that holds the same failure is found by them (next-step.ts
 * `fixByFailure`).
 */

/** A failure no one has blamed, as the run's page and the terminal UI say it. */
export const NOT_BLAMED = 'not blamed yet';

/**
 * What failed, in the engine's order of why a run failed (`failureReason`): its first failed check
 * with what it saw (`send_email called at most 1 time, but called 2 times`); where a replay left its
 * recording; the agent's exit; the check its outcome names. Then a capture's first rule its import
 * failed it on (`capture`, the run's record), the first of its family's checks it fails today
 * (`family`), an interruption or blame's confirmation. Never where blame found it lost: that names a
 * call, and runs that failed the same way share an issue.
 */
export function failedWords(row: Pick<IndexedRun, 'status' | 'outcome' | 'meta'>, o: { capture?: Pick<RunRecord, 'meta'> | null; family?: Pick<RunJudged, 'first'> | null } = {}): string {
  const reason = failureReason({ status: row.status, checks: row.meta.checks ?? [], outcome: row.outcome, blame: row.meta.blame });
  if (reason?.kind === 'check') return checkFailed(reason.check);
  if (row.outcome.kind === 'diverged') return `diverged at call ${row.outcome.callNo}`;
  if (reason?.kind === 'fix-check') return reason.check;
  if (reason?.kind === 'exit') return FAILURE_WORDS.exit;
  const kept = o.capture ? keptCaptureVerdict(o.capture)?.checks.find((c) => checkStatus(c) === 'failed') : undefined;
  if (kept) return checkFailed(kept);
  const first = o.family?.first;
  if (first) return first.detail ? `${first.label}, but ${first.detail}` : first.label;
  return reason ? FAILURE_WORDS[reason.kind] : 'failed';
}

/** A failed check with what it saw (`send_email called 1 time, but called 2 times`), or its label where it kept nothing more. */
const checkFailed = (c: StoredCheck): string => checkWords(c, c.detail ? ', but ' : '');

/**
 * Run blame's card on a list's row (Needs a look, Runs' issues): the run it blames, named the newest
 * where the row stands for several, and the fix blame joins it to, by its labels or its check.
 */
export const blameCard = (runId: string, several: boolean): string => `Blames ${several ? 'the newest, ' : ''}${shortRunId(runId)}: finds the model call that lost it, then joins the fix its failure belongs to`;
