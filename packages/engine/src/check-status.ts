/**
 * How a check came out, in the words every report uses: passed, failed, inconclusive (it could not
 * be decided, as a judge check with no verdict) and not applicable (a `when` rule whose condition
 * never held). The engine evaluates checks (checks/evaluate.ts), for the CLI and the dashboard alike;
 * both read them back from a run or a test result, where a result stored before checks had a status
 * carries only `ok`, so they read the status through `checkStatus`.
 */

import type { CheckStatus } from './types.js';

export type { CheckStatus };

export const CHECK_STATUSES: readonly CheckStatus[] = ['passed', 'failed', 'inconclusive', 'not-applicable'];

/** The verdict words, as every report and page writes them. */
export const STATUS_WORDS: Readonly<Record<CheckStatus, string>> = { passed: 'passed', failed: 'failed', inconclusive: 'inconclusive', 'not-applicable': 'not applicable' };

/**
 * The scope judge checks' model calls are made in (judge-scope.ts). They are the oracle's calls, not
 * the agent's: no check counts them, and a replay's matching leaves them out.
 */
export { JUDGE_SCOPE } from './judge-scope.js';

/** A check result as a run or a test result keeps it. Untrusted: a run can come from a pack. */
export interface StoredCheckLike {
  ok?: unknown;
  status?: unknown;
}

/** A result's status: the one it carries, else what `ok` meant before results had one. */
export function checkStatus(c: StoredCheckLike): CheckStatus {
  if (typeof c.status === 'string' && (CHECK_STATUSES as readonly string[]).includes(c.status)) return c.status as CheckStatus;
  return c.ok === true ? 'passed' : 'failed';
}

/**
 * A run's checks as one outcome: failed when any check failed, else inconclusive when any could not
 * be decided, else passed. A check that did not apply never fails a run.
 */
export function checkOutcome(checks: readonly StoredCheckLike[]): 'passed' | 'failed' | 'inconclusive' {
  const statuses = checks.map(checkStatus);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('inconclusive')) return 'inconclusive';
  return 'passed';
}

/** How many checks came out each way. */
export function countStatuses(checks: readonly StoredCheckLike[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { passed: 0, failed: 0, inconclusive: 0, 'not-applicable': 0 };
  for (const c of checks) counts[checkStatus(c)]++;
  return counts;
}

/**
 * The checks in a few words, as a result line ends: `3 checks passed`, `2 checks passed, 1 not
 * applicable`, `1 of 3 checks failed, 1 inconclusive`. Empty for no checks.
 */
export function statusTally(checks: readonly StoredCheckLike[]): string {
  if (!checks.length) return '';
  const n = countStatuses(checks);
  const noun = (k: number) => `check${k === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (n.failed) parts.push(`${n.failed} of ${checks.length} ${noun(checks.length)} failed`);
  else if (n.passed) parts.push(`${n.passed} ${noun(n.passed)} passed`);
  // The first part names what it counts; those after it read on from it.
  const add = (k: number, word: string) => k && parts.push(parts.length ? `${k} ${word}` : `${k} ${noun(k)} ${word}`);
  add(n.inconclusive, 'inconclusive');
  add(n['not-applicable'], 'not applicable');
  return parts.join(', ');
}
