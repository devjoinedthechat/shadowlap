import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../store.js';
import { projectDbPath } from './paths.js';

/**
 * Deleting a project's recordings: its store, `.shadowlap/shadowlap.db` and the files SQLite keeps
 * beside it. Nothing else: the folder and its code, `shadowlap.config.json` and the goldens in the
 * repository are never touched.
 */

export class RecordingsError extends Error {
  constructor(
    readonly code: 'recording' | 'store',
    message: string,
  ) {
    super(message);
    this.name = 'RecordingsError';
  }
}

const STORE_FILES = ['shadowlap.db', 'shadowlap.db-wal', 'shadowlap.db-shm', 'shadowlap.db-journal'];
/** A run marked as running that started longer ago than this was left by a process that died. */
const RECENT_RUN_MS = 15 * 60 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether something is recording into the folder's store right now: a `shadowlap run` whose
 * process is alive (`.shadowlap/active.json`), or a run still marked running that started in the
 * last quarter of an hour. A store that can't be opened to look (one held by a long write, or from a
 * newer Shadowlap) can't be said to be idle: that throws rather than answering no.
 */
export function recordingInProgress(folder: string, now: number = Date.now()): boolean {
  const active = join(folder, '.shadowlap', 'active.json');
  if (existsSync(active)) {
    try {
      const pid = (JSON.parse(readFileSync(active, 'utf8')) as { pid?: unknown }).pid;
      if (typeof pid === 'number' && alive(pid)) return true;
    } catch {
      // unreadable: the store check below still applies
    }
  }
  const db = projectDbPath(folder);
  if (!existsSync(db)) return false;
  let store: Store;
  try {
    store = Store.open(db);
  } catch (err) {
    throw new RecordingsError('store', `Shadowlap can’t open the store to check that nothing is recording into it: ${(err as Error).message}`);
  }
  try {
    return store.listRuns(20).some((r) => r.status === 'running' && now - r.startedAt < RECENT_RUN_MS);
  } finally {
    store.close();
  }
}

/** Checks the store can be deleted safely; returns the files that would go, relative to the folder. */
export function storeFilesToDelete(folder: string, now: number = Date.now()): string[] {
  const dir = join(folder, '.shadowlap');
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return [];
  }
  // Never follow a link a checkout could have planted: the store is a plain folder, or it isn't ours.
  if (st.isSymbolicLink() || !st.isDirectory()) throw new RecordingsError('store', `${dir} isn’t a plain folder, so Shadowlap won’t delete anything in it. Delete the recordings yourself.`);
  const present = (): string[] => {
    const files: string[] = [];
    for (const name of STORE_FILES) {
      let f;
      try {
        f = lstatSync(join(dir, name));
      } catch {
        continue;
      }
      if (!f.isFile()) throw new RecordingsError('store', `${join(dir, name)} isn’t a plain file, so Shadowlap won’t delete it. Delete the recordings yourself.`);
      files.push(`.shadowlap/${name}`);
    }
    return files;
  };
  // The files are checked before the store is opened to look for a live run, and listed again after.
  if (!present().length) return [];
  if (recordingInProgress(folder, now)) throw new RecordingsError('recording', 'A run is being recorded in this folder. Let it finish or stop it, then delete the recordings.');
  return present();
}

/** Deletes the folder's store. Returns what it deleted, relative to the folder. */
export function deleteRecordings(folder: string, now: number = Date.now()): string[] {
  const files = storeFilesToDelete(folder, now);
  for (const rel of files) rmSync(join(folder, rel), { force: true });
  return files;
}
