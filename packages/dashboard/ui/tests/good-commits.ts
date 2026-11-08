import { shortDate } from '../goldens.js';
import type { GoodChoice } from '../runspage/find-commit.js';
import type { BisectMiss, BisectRevision, UntestedCommit } from '../types.js';

/**
 * The commits Find breaking commit's dialog offers on Tests as good ones, newest first, as the mock
 * words them: each with its subject and how the golden did there, then the few before the one it
 * failed at that it was never tested at. In the Tests chunk: the first look never asks for a commit.
 */

/** What a golden's dialog offers commits from: those it was tested at, those it never was, and a search that named no first bad commit. */
export interface GoodCommitsOf {
  revisions: readonly BisectRevision[];
  untested?: readonly UntestedCommit[] | undefined;
  missed?: Pick<BisectMiss, 'good' | 'outcome'> | null | undefined;
}

/** A revision and the name a search was given for it: one may be the other's short form. */
const sameRev = (a: string, b: string) => a === b || a.startsWith(b) || b.startsWith(a);

/** How the golden did at a commit it was tested at: its verdict, with its tally where it ran several attempts; a pass under other checks says so. */
function howItDid(r: BisectRevision): string {
  const tally = r.rate && r.rate.attempts > 1 ? ` ${r.rate.passes} of ${r.rate.attempts}` : '';
  if (r.verdict === 'inconclusive') return `inconclusive${tally}`;
  if (r.result === 'fail') return `failed${tally}`;
  return r.sameChecks ? `passed${tally}` : `passed${tally} under other checks`;
}

/** The commit a search from it named no first bad commit at, by why. */
const TRIED: Partial<Record<NonNullable<BisectMiss['outcome']>, string>> = {
  'fails-at-good': 'tried: it already fails there',
  untestable: 'tried: it could not be tested there',
};

/**
 * The dialog's list: its name, each commit with how the golden did there (`passed`, `failed 4 of 8`,
 * `inconclusive`, `passed under other checks`), the one a search already failed at saying so, then
 * `not tested there`; tested at none, the name says `none tested yet` and no commit says how.
 * `initial` is the one to start on: the newest that passed under today's checks, older than the one
 * a search from it named no first bad commit; else the newest offered; '' when none is known, for
 * the dialog to ask for any commit.
 */
export function goodCommits(f: GoodCommitsOf): { label: string; options: GoodChoice[]; initial: string } {
  const tried = f.missed?.good ?? null;
  const at = tried ? f.revisions.findIndex((r) => sameRev(r.rev, tried)) : -1;
  const marked = f.missed?.outcome ? TRIED[f.missed.outcome] : undefined;
  const tested = f.revisions.map((r, i) => ({ value: r.rev, subject: r.subject || shortDate(r.at), how: (i === at ? marked : undefined) ?? howItDid(r) }));
  const none = !tested.length;
  const untested = (f.untested ?? []).map((c) => ({ value: c.rev, subject: c.subject, how: none ? null : 'not tested there' }));
  // Nothing older than the one tried is known: the dialog starts on a field for any commit ('').
  const older = at >= 0 ? f.revisions.slice(at + 1) : f.revisions;
  const initial = older.find((r) => r.result === 'pass' && r.sameChecks)?.rev ?? older[0]?.rev ?? (at >= 0 ? '' : (untested[0]?.value ?? ''));
  return { label: none && untested.length ? 'Good commit · none tested yet' : 'Good commit', options: [...tested, ...untested], initial };
}
