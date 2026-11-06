import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FileLockBusyError, isObject, shadowlapHome, withFileLock, writeFileAtomic } from '@shadowlap/engine';

/**
 * When each golden's checks were last seen to change, kept for this machine in Shadowlap's folder
 * (shadowlapHome): a run recorded before then is judged by today's checks (run-outcome.ts). The
 * config file's time says when it was last written, not whose checks the write changed, so the
 * dashboard keeps a key for each golden's `expect` as it read it, and when it saw the key change: by
 * the config's write that changed it, as near as the file's time tells. A golden first seen has no
 * such time: its checks came with it, when it was packed.
 *
 * The file is a cache every dashboard on this machine reads and writes. So a write changes its
 * project's entry alone, in the file as read afresh under its lock (the engine's, as Spending's and
 * the project list's), and replaces the file in one step; and the file is read again once it has
 * changed. A write never waits: while another process holds the lock it is skipped, and the next
 * request makes it (outcome-work.ts). One that can't be read or written is as none, and only costs
 * the times it held.
 */

export const CHECKS_SEEN_FILE = 'checks-seen.json';
const FORMAT = 1;
/** The most projects the file keeps, the one least lately changed going first. */
const PROJECTS = 200;

/** A golden's checks as last seen: a key for its `expect`, and when it was seen to change (null: not since it was first seen). */
export interface SeenChecks {
  key: string;
  at: number | null;
}

type Projects = Map<string, Map<string, SeenChecks>>;

/** The file as last read, by its path, with what stat said of it then: read again once that changes. */
const files = new Map<string, { stat: string; projects: Projects }>();
/** What this process couldn't write, by the file's path: kept for as long as it runs. */
const unwritten = new Map<string, Projects>();

function parse(file: string): Projects {
  const out: Projects = new Map();
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  if (!isObject(data) || data.format !== FORMAT || !isObject(data.projects)) return out;
  for (const [dir, goldens] of Object.entries(data.projects)) {
    if (!isObject(goldens)) continue;
    const seen = new Map<string, SeenChecks>();
    for (const [path, v] of Object.entries(goldens)) {
      if (isObject(v) && typeof v.key === 'string' && (v.at === null || (typeof v.at === 'number' && Number.isFinite(v.at)))) seen.set(path, { key: v.key, at: v.at });
    }
    out.set(dir, seen);
  }
  return out;
}

/** The file as stat sees it, so that a write shows: each one replaces it, so its inode changes with its time and size. Null without one. */
function statOf(file: string): string | null {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return null;
  }
}

/** The file as it is now: as last read while stat says it is unchanged, else read again. */
function current(file: string): Projects {
  const stat = statOf(file);
  const was = files.get(file);
  if (stat !== null && was?.stat === stat) return was.projects;
  const projects = parse(file);
  if (stat === null) files.delete(file);
  else files.set(file, { stat, projects });
  return projects;
}

function text(projects: Projects): string {
  const out: Record<string, Record<string, SeenChecks>> = {};
  for (const [d, goldens] of projects) out[d] = Object.fromEntries(goldens);
  return `${JSON.stringify({ format: FORMAT, projects: out }, null, 2)}\n`;
}

const fileOf = (env: NodeJS.ProcessEnv) => join(shadowlapHome(env), CHECKS_SEEN_FILE);

/** Each golden's checks as last seen in the project, by the golden's folder. */
export function seenChecks(dir: string, env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, SeenChecks> {
  const file = fileOf(env);
  return unwritten.get(file)?.get(dir) ?? current(file).get(dir) ?? new Map();
}

/**
 * Keeps each golden's checks as seen now in the project, the goldens no longer there left out: the
 * project's entry alone, written into the file as it is then. False when another process held the
 * file, so that nothing was written: a later call writes it.
 */
export function keepSeenChecks(dir: string, seen: ReadonlyMap<string, SeenChecks>, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = fileOf(env);
  const entry = new Map(seen);
  try {
    // Tried once: a request never waits for another process's write.
    withFileLock(file, 0, () => {
      // Read afresh, never the copy kept for reads: every other project's entry stays as it was written.
      const projects = parse(file);
      projects.delete(dir);
      projects.set(dir, entry);
      while (projects.size > PROJECTS) projects.delete(projects.keys().next().value!);
      writeFileAtomic(file, text(projects));
    });
  } catch (err) {
    if (err instanceof FileLockBusyError) return false;
    // a folder that can't be written: the times are kept for as long as this process runs
    const mine = unwritten.get(file) ?? new Map<string, Map<string, SeenChecks>>();
    unwritten.set(file, mine.set(dir, entry));
    return true;
  }
  unwritten.get(file)?.delete(dir);
  return true;
}
