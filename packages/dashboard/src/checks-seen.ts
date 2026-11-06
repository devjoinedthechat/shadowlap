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
 * changed. A write never waits, and never writes over what it couldn't read: while another process
 * holds the lock, while the file can't be read, or when the write fails, it is skipped, and the next
 * request makes it (outcome-work.ts). A read that fails answers with what was read of the file last,
 * and nothing is kept from it. A file that is no JSON is as none, and one a newer Shadowlap wrote is
 * read as none and never written over; where the folder can't be written, the times are kept for as
 * long as the process runs.
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

/** A project's goldens' checks as last seen, by the golden's folder, and whether that is the file as it is now. */
export interface Seen {
  seen: ReadonlyMap<string, SeenChecks>;
  /** False when the file couldn't be read just now: `seen` is what was read of it last, to answer with, and never to keep from. */
  current: boolean;
}

type Projects = Map<string, Map<string, SeenChecks>>;
const empty = (): Projects => new Map();
/** A file a newer Shadowlap wrote, in a format this one doesn't know: read as none, and never written over. */
const NEWER = Symbol('newer');
/** A write: made; for a later call to make, as nothing was written; or never to be made, so kept in this process alone. */
type Kept = 'written' | 'later' | 'never';

/** The file as last read, by its path, with what stat said of it then: read again once that changes. */
const files = new Map<string, { stat: string; projects: Projects }>();
/** What this process couldn't write, by the file's path: kept for as long as it runs. */
const unwritten = new Map<string, Projects>();

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException).code ?? '';
/** No file there, nor a folder for one: none yet. */
const missing = (err: unknown) => codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR';

/** The file's projects: none without a file, or in one that is no JSON of this format; null when it couldn't be read. */
function parse(file: string): Projects | typeof NEWER | null {
  const out = empty();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return missing(err) ? out : null;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return out;
  }
  if (!isObject(data)) return out;
  if (typeof data.format === 'number' && data.format > FORMAT) return NEWER;
  if (data.format !== FORMAT || !isObject(data.projects)) return out;
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

/** The file as stat sees it, so that a write shows: each one replaces it, so its inode changes with its time and size. */
function statOf(file: string): string {
  const s = statSync(file);
  return `${s.mtimeMs}:${s.size}:${s.ino}`;
}

/**
 * The file as it is now: as last read while stat says it is unchanged, else read again. One that
 * can't be read just then is read again by the next call, and until then is what was read of it last.
 */
function projectsNow(file: string): { projects: Projects; current: boolean } {
  const was = files.get(file);
  const last = { projects: was?.projects ?? empty(), current: false };
  let stat: string;
  try {
    stat = statOf(file);
  } catch (err) {
    if (!missing(err)) return last;
    files.delete(file);
    return { projects: empty(), current: true };
  }
  if (was?.stat === stat) return { projects: was.projects, current: true };
  const read = parse(file);
  if (read === null) return last;
  const projects = read === NEWER ? empty() : read;
  files.set(file, { stat, projects });
  return { projects, current: true };
}

function text(projects: Projects): string {
  const out: Record<string, Record<string, SeenChecks>> = {};
  for (const [d, goldens] of projects) out[d] = Object.fromEntries(goldens);
  return `${JSON.stringify({ format: FORMAT, projects: out }, null, 2)}\n`;
}

const fileOf = (env: NodeJS.ProcessEnv) => join(shadowlapHome(env), CHECKS_SEEN_FILE);

/** Each golden's checks as last seen in the project, by the golden's folder, and whether the file could be read for them just now. */
export function seenChecks(dir: string, env: NodeJS.ProcessEnv = process.env): Seen {
  const file = fileOf(env);
  const mine = unwritten.get(file)?.get(dir);
  if (mine) return { seen: mine, current: true };
  const { projects, current } = projectsNow(file);
  return { seen: projects.get(dir) ?? new Map(), current };
}

/** Under the file's lock: the project's entry written into the file as read afresh, but never over one it couldn't read, nor a newer Shadowlap's. */
function writeEntry(file: string, dir: string, entry: Map<string, SeenChecks>): Kept {
  // Read afresh, never the copy kept for reads: every other project's entry stays as it was written.
  const projects = parse(file);
  // Couldn't be read just then: written over, every other project's entry in it would be lost.
  if (projects === null) return 'later';
  if (projects === NEWER) return 'never';
  projects.delete(dir);
  projects.set(dir, entry);
  while (projects.size > PROJECTS) projects.delete(projects.keys().next().value!);
  try {
    writeFileAtomic(file, text(projects));
  } catch {
    // The lock was made in the folder, so it can be written: a write that fails there (a full disk, or
    // Windows refusing to replace a file another program has open, which it says with EPERM) is made
    // again by a later call.
    return 'later';
  }
  return 'written';
}

/** What making the lock says when the folder can't be written: kept in this process, as no later call writes it either. */
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST']);

/**
 * Keeps each golden's checks as seen now in the project, the goldens no longer there left out: the
 * project's entry alone, written into the file as it is then. False when nothing was written, for a
 * later call to write it: another process held the file, it couldn't be read, or the write failed.
 * Where it can't be written at all, in a folder that can't be or over a newer Shadowlap's file, the
 * entry is kept for as long as this process runs.
 */
export function keepSeenChecks(dir: string, seen: ReadonlyMap<string, SeenChecks>, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = fileOf(env);
  const entry = new Map(seen);
  let kept: Kept;
  try {
    // Tried once: a request never waits for another process's write.
    kept = withFileLock(file, 0, () => writeEntry(file, dir, entry));
  } catch (err) {
    // Another process writing it, or a lock that couldn't be made just then (out of file handles).
    if (err instanceof FileLockBusyError || !UNWRITABLE.has(codeOf(err))) return false;
    kept = 'never';
  }
  if (kept === 'later') return false;
  if (kept === 'written') unwritten.get(file)?.delete(dir);
  else unwritten.set(file, (unwritten.get(file) ?? empty()).set(dir, entry));
  return true;
}
