/**
 * What a cost line says runs live, in the words the engine's estimates and the dashboard's dialogs
 * both say it: Run repair, a fork, its attempts, Record run. The estimates price these parts; a
 * dialog says them before it has a price. No imports but words.ts: the dashboard's pages bundle it
 * as it is.
 */
import { pluralS } from './words.js';

/** A number and its noun: `1 attempt`, `6 candidates`, `1,200 calls`. */
export const counted = (n: number, noun: string): string => `${n.toLocaleString('en-US')} ${noun}${pluralS(n)}`;

/** Why Run repair runs nothing where it would end "No fix to try": the blame it reuses didn't settle, or rescued no call. */
export const repairRunsNothing = (why: 'unsettled' | 'unrescued'): string => `nothing runs: the blame it reuses ${why === 'unsettled' ? 'didn’t settle' : 'rescued no call'}`;

/** Run repair's parts: its candidates, after a new blame when it can't reuse one, each verified, and where each run goes live. */
export const repairParts = (candidates: number, newBlame: boolean): string[] => [`${newBlame ? 'a new blame, then up' : 'up'} to ${counted(candidates, 'candidate')}`, 'each verified up to twice', 'live from each run’s first model call, writes stubbed'];

/** Where a fork runs live from (`#17`, `the next model call`), the writes after it fenced; `other writes` when one is forced live. */
export const liveFromPart = (from: string, otherWrites = false): string => `live from ${from}, ${otherWrites ? 'other writes' : 'writes'} fenced`;

/** A fork's attempts, each live from where it forks: Repeat's and Plant's. */
export const attemptsPart = (n: number, from: string): string => `${counted(n, 'attempt')}, ${liveFromPart(from)}`;

/** Record run: the agent runs live, with nothing recorded yet to price its calls from. */
export const RECORD_PART = 'the agent’s own model calls';
