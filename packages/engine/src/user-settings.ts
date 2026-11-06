import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SPENDING_DEFAULT, spendingUsd, validSpending, type Spending } from './estimates/spending.js';
import { SPENDING_REFUSED } from './estimates/spending-row.js';
import { isObject } from './is-object.js';
import { messageOf } from './message-of.js';
import { withFileLock, writeFileAtomic } from './projects/files.js';
import { shadowlapHome, shadowlapHomeProblem } from './projects/paths.js';

/**
 * Settings that are a person's own, on this machine, whatever project is open: `settings.json` in
 * Shadowlap's folder for this machine's files (shadowlapHome: SHADOWLAP_HOME, else ~/.shadowlap),
 * beside the project list. Never in shadowlap.config.json, which a repository shares, so CI and
 * teammates never take them on, and nothing in the CLI reads them. Spending (estimates/spending.ts)
 * is kept here: when a billed job asks before it starts.
 *
 * The file is JSON a person can read, written whole in one step and owner-only, one writer at a
 * time (projects/files.ts), with keys it doesn't know kept, so a newer Shadowlap's settings survive
 * an older one's write; one a newer Shadowlap wrote is read, never written over. A file that can't
 * be read, or a value it can't hold, leaves the default, and says why.
 */

export const USER_SETTINGS_FILE = 'settings.json';
export const USER_SETTINGS_VERSION = 1;

/** A setting could not be kept: the folder given is no absolute path, the file is no settings or a newer Shadowlap's, or the value is none it holds. */
export class UserSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserSettingsError';
  }
}

export interface UserSettingsOptions {
  /** The folder the file lives in, an absolute path; Shadowlap's folder for this machine's files when left out. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  /** The home folder, where that folder is when SHADOWLAP_HOME names none. */
  home?: string;
  /** How long a write waits for another process's: 5 seconds by default. */
  lockTimeoutMs?: number;
}

/** Spending as kept: the threshold, whether someone set it, the file, and why anything was ignored. */
export interface SpendingSetting {
  /** Dollars in whole cents above which a job asks first: 0 always asks, null never asks. */
  askAbove: Spending;
  /** It was set; else it is the default, $0.50. */
  set: boolean;
  file: string;
  /** What was ignored, and why: a relative SHADOWLAP_HOME, a file that is no settings, a value it can't hold. */
  problems: string[];
}

/**
 * The settings file. A folder given must be an absolute path: a relative one would name a different
 * folder in every directory a command runs in. A relative SHADOWLAP_HOME is ignored, as it is for the
 * project list (shadowlapHome), and the problems say so.
 */
export function userSettingsFile(o: UserSettingsOptions = {}): string {
  if (o.dir !== undefined && !isAbsolute(o.dir)) throw new UserSettingsError(`${o.dir} isn’t an absolute path, so it names a different folder wherever Shadowlap runs: give the folder for this machine’s settings as an absolute path`);
  return join(o.dir ?? shadowlapHome(o.env, o.home), USER_SETTINGS_FILE);
}

/** A relative SHADOWLAP_HOME that was ignored, in the words every file kept for this machine says it in (shadowlapHomeProblem). */
function homeProblems(o: UserSettingsOptions): string[] {
  const problem = o.dir === undefined ? shadowlapHomeProblem(o.env, o.home) : null;
  return problem ? [problem] : [];
}

/** The file's settings as an object, or why they can't be read; none at all when there is no file yet. */
function readRaw(file: string): { raw: Record<string, unknown>; problem: string | null } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { raw: {}, problem: (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : `${file} could not be read: ${messageOf(err)}` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? { raw: parsed, problem: null } : { raw: {}, problem: `${file} holds no settings: it is JSON, but no object` };
  } catch {
    return { raw: {}, problem: `${file} isn’t valid JSON` };
  }
}

/**
 * A value as a message names it: a number as it reads (`Infinity`, `NaN`, `0.505`), which JSON would
 * call null, as a stored 1e999 parses to Infinity; anything else as JSON (`"lots"`).
 */
const named = (v: unknown): string => (typeof v === 'number' ? String(v) : JSON.stringify(v));

/** Spending as a file's settings hold it, or the default and why. */
function spendingOf(raw: Record<string, unknown>, file: string): { askAbove: Spending; set: boolean; problem: string | null } {
  const kept = isObject(raw.spending) ? raw.spending : null;
  if (!kept || !('askAbove' in kept)) return { askAbove: SPENDING_DEFAULT, set: false, problem: null };
  if (validSpending(kept.askAbove)) return { askAbove: kept.askAbove, set: true, problem: null };
  return { askAbove: SPENDING_DEFAULT, set: false, problem: `${file}: spending.askAbove is ${named(kept.askAbove)}, which is no threshold (${SPENDING_REFUSED.toLowerCase()}, or null to never ask), so it asks above the default ${spendingUsd(SPENDING_DEFAULT)}` };
}

/** Spending as this person keeps it on this machine: the default, $0.50, until they change it. */
export function readSpending(o: UserSettingsOptions = {}): SpendingSetting {
  const file = userSettingsFile(o);
  const { raw, problem } = readRaw(file);
  const s = spendingOf(raw, file);
  return { askAbove: s.askAbove, set: s.set, file, problems: [...homeProblems(o), ...[problem, s.problem].filter((x): x is string => x !== null)] };
}

/**
 * Keeps Spending, and says what it was before, for an Undo to write back. Refused for a value it can't
 * hold, and for a file it would lose something of: one that is no settings, or a newer Shadowlap's.
 */
export function writeSpending(askAbove: Spending, o: UserSettingsOptions = {}): SpendingSetting & { was: Spending } {
  if (!validSpending(askAbove)) throw new UserSettingsError(`${named(askAbove)} is no threshold: ${SPENDING_REFUSED.toLowerCase()}, or null to never ask`);
  const file = userSettingsFile(o);
  return withFileLock(file, o.lockTimeoutMs ?? 5000, () => {
    const { raw, problem } = readRaw(file);
    if (problem) throw new UserSettingsError(`${problem}: fix or remove it, and change Spending again`);
    if (typeof raw.version === 'number' && raw.version > USER_SETTINGS_VERSION) throw new UserSettingsError(`${file} was written by a newer Shadowlap: update this one to change its settings`);
    const was = spendingOf(raw, file).askAbove;
    const spending = isObject(raw.spending) ? raw.spending : {};
    // Whole cents as written: 0.1 + 0.2 is kept as 0.3.
    const cents = askAbove === null ? null : Math.round(askAbove * 100) / 100;
    writeFileAtomic(file, `${JSON.stringify({ ...raw, version: USER_SETTINGS_VERSION, spending: { ...spending, askAbove: cents } }, null, 2)}\n`);
    return { askAbove: cents, set: true, file, problems: homeProblems(o), was };
  });
}
