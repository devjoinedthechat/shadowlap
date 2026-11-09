import { checkStatus, checkWords, FAILURE_WORDS, failureReason, keptCaptureVerdict, type RunRecord, type StoredCheck } from '@shadowlap/engine';
import type { IndexedRun } from './run-index.js';
import type { RunJudged } from './run-outcome.js';

/*
 * What a failed run failed on, in the words a list says it: Runs' issues (issues.ts) title and key
 * a failure with them, as the fix that holds the same failure is found by them (next-step.ts
 * `fixByFailure`), and the row of failed runs nobody has blamed names its newest's failure with
 * them, on Fixes and on Needs a look.
 */

/** A failure no one has blamed, as the run's page and the terminal UI say it. */
export const NOT_BLAMED = 'not blamed yet';

/**
 * What failed, in the engine's order of why a run failed (`failureReason`): its first failed check
 * with what it saw (`send_email called at most 1 time, but called 2 times`); where a replay left its
 * recording; the agent's exit; the check its outcome names. Then a capture's first rule its import
 * failed it on (`capture`, the run's record), the first of its family's checks it fails today
 * (`family`), an interruption. A run blame saw fail that kept no check of its own failed the check
 * of the fix that lists it (`fixCheck`), ahead of blame's confirmation. Never where blame found it
 * lost: that names a call, and runs that failed the same way share an issue.
 */
export function failedWords(row: Pick<IndexedRun, 'status' | 'outcome' | 'meta' | 'fixCheck'>, o: { capture?: Pick<RunRecord, 'meta'> | null; family?: Pick<RunJudged, 'first'> | null } = {}): string {
  const reason = failureReason({ status: row.status, checks: row.meta.checks ?? [], outcome: row.outcome, blame: row.meta.blame });
  if (reason?.kind === 'check') return checkFailed(reason.check);
  if (row.outcome.kind === 'diverged') return `diverged at call ${row.outcome.callNo}`;
  if (reason?.kind === 'fix-check') return reason.check;
  if (reason?.kind === 'exit') return FAILURE_WORDS.exit;
  const kept = o.capture ? keptCaptureVerdict(o.capture)?.checks.find((c) => checkStatus(c) === 'failed') : undefined;
  if (kept) return checkFailed(kept);
  const first = o.family?.first;
  if (first) return first.detail ? `${first.label}, but ${first.detail}` : first.label;
  if (reason?.kind === 'blame' && row.fixCheck) return row.fixCheck;
  return reason ? FAILURE_WORDS[reason.kind] : 'failed';
}

/** A failed check with what it saw (`send_email called 1 time, but called 2 times`), or its label where it kept nothing more. */
const checkFailed = (c: StoredCheck): string => checkWords(c, c.detail ? ', but ' : '');

/** Where an instruction was planted, naming the call as the run's page does (`#2 lookup_order`): `planted in #2 lookup_order’s result`. */
export const plantedWords = (callNo: number, tool: string | null): string => `planted in #${callNo}${tool ? ` ${tool}` : ''}’s result`;
