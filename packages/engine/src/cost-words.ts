/**
 * What a cost line says runs live, in the words the engine's estimates and the dashboard's dialogs
 * both say it: Run repair, a fork and its attempts, Record run, Run more attempts, an update, blame's
 * probes, Find breaking commit, an injection test. The estimates price these parts; a dialog says them
 * before it has a price. No imports but words.ts: the dashboard's pages bundle it as it is.
 */
import { pluralS } from './words.js';

/** A number and its noun: `1 attempt`, `6 candidates`, `1,200 calls`. */
export const counted = (n: number, noun: string): string => `${n.toLocaleString('en-US')} ${noun}${pluralS(n)}`;

/**
 * A factor in words, as an ask says what calls cost asked of another model: `twice`, `half`, `1.7
 * times`, under a tenth to two figures (`0.048 times`); null for about the same, or none to give.
 */
export function timesWords(k: number): string | null {
  if (!Number.isFinite(k) || k <= 0) return null;
  const small = k < 0.1;
  const r = small ? Number(k.toPrecision(2)) : Math.round(k * 10) / 10;
  if (r === 1) return null;
  if (r === 2) return 'twice';
  if (r === 0.5) return 'half';
  return `${r.toLocaleString('en-US', small ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 1 })} times`;
}

/** The most verifies of one candidate: the first the gate accepts is verified once more, with fresh attempts, and kept only if it passes again (cli/src/repair-pick.ts). */
export const REPAIR_VERIFIES = 2;

/** Why Run repair runs nothing where it would end "No fix to try": the blame it reuses didn't settle, or rescued no call. */
export const repairRunsNothing = (why: 'unsettled' | 'unrescued'): string => `nothing runs: the blame it reuses ${why === 'unsettled' ? 'didn’t settle' : 'rescued no call'}`;

/** Run repair's parts: its candidates, after a new blame when it can't reuse one, each verified, and where each run goes live. */
export const repairParts = (candidates: number, newBlame: boolean): string[] => [`${newBlame ? 'a new blame, then up' : 'up'} to ${counted(candidates, 'candidate')}`, `each verified up to ${timesWords(REPAIR_VERIFIES) ?? 'once'}`, 'live from each run’s first model call, writes stubbed'];

/** Where a fork runs live from (`#17`, `the next model call`), the writes after it fenced; `other writes` when one is forced live. */
export const liveFromPart = (from: string, otherWrites = false): string => `live from ${from}, ${otherWrites ? 'other writes' : 'writes'} fenced`;

/** A fork's attempts, each live from where it forks: Repeat's and Plant's. */
export const attemptsPart = (n: number, from: string): string => `${counted(n, 'attempt')}, ${liveFromPart(from)}`;

/** Record run: the agent runs live, with nothing recorded yet to price its calls from. */
export const RECORD_PART = 'the agent’s own model calls';

/** Run more attempts on a golden's gate: up to how many more, live from where it forks. */
export const moreAttemptsParts = (most: number): string[] => [`up to ${counted(most, 'more attempt')}`, 'live from where the golden forks, writes blocked'];

/** What re-recording goldens bills: each judge's one call when every golden has one, else as their recordings did. */
export const updatePart = (one: boolean, judges: boolean): string => (judges ? (one ? 'its judge’s one call' : 'each judge’s one call') : one ? 'as its recording cost' : 'as their recordings cost');

/** An injection test's attempts, and an injection gate's: each live from the read it plants in, the writes after it stubbed. */
export const INJECTION_PART = 'live from each read, writes stubbed';

/** Blame's probes, each live from the call it probes, the writes after it stubbed, or blocked. */
export const probesPart = (blocked = false): string => `live from each probe, writes ${blocked ? 'blocked' : 'stubbed'}`;

/** Find breaking commit: a golden that replays bisects offline; one marked fork runs live at each commit; a run, one live replay a commit. */
export const BISECT_PARTS = { offline: 'bisect replays offline', fork: 'live at each commit, as a golden marked fork runs', run: 'one live replay each, writes blocked' } as const;
