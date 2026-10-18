import { accessSync, constants, existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectDbPath } from './paths.js';
import { processAlive } from '../liveness.js';
import { readStore } from './store-reader.js';

/**
 * Deleting a project's recordings: its store, `.shadowlap/shadowlap.db` and the files SQLite keeps
 * beside it. Nothing else: the folder and its code, `shadowlap.config.json` and the goldens in the
 * repository are never touched, and neither are the files other commands made from the runs in
 * `.shadowlap/` ({@link MADE_FOLDERS}), which the Remove dialog names.
 */

/** Folders in `.shadowlap/` that hold what commands made from the runs: repair reports and their goldens, exports, files sent to dashboard jobs. */
export const MADE_FOLDERS = ['repairs', 'exports', 'uploads'] as const;

/** Those of {@link MADE_FOLDERS} a project's folder has, as `.shadowlap/repairs`: deleting the recordings leaves them. */
export function madeFiles(folder: string): string[] {
  return MADE_FOLDERS.map((name) => `.shadowlap/${name}`).filter((rel) => {
    try {
      return lstatSync(join(folder, rel)).isDirectory();
    } catch {
      return false;
    }
  });
}

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

/**
 * Whether something is recording into the folder's store right now, by the store's own record of
 * the process recording each run still running (run_owners), the rule gc, rm and the dashboard's
 * delete follow: a run whose process is alive is recorded however long ago it started, and one
 * whose process was killed is not, however recently. A `shadowlap run` whose process is alive
 * (`.shadowlap/active.json`) counts too, as it starts. A store that can't be opened to look (one
 * held by a long write, or from a newer Shadowlap) can't be said to be idle: that throws rather
 * than answering no.
 */
export function recordingInProgress(folder: string, now: number = Date.now()): boolean {
  const active = join(folder, '.shadowlap', 'active.json');
  if (existsSync(active)) {
    try {
      const pid = (JSON.parse(readFileSync(active, 'utf8')) as { pid?: unknown }).pid;
      if (typeof pid === 'number' && processAlive(pid)) return true;
    } catch {
      // unreadable: the store check below still applies
    }
  }
  const db = projectDbPath(folder);
  if (!existsSync(db)) return false;
  try {
    // Read-only: a store about to be deleted isn't migrated first.
    return readStore(db, (store) => store.liveRecordings(now).length > 0);
  } catch (err) {
    throw new RecordingsError('store', `Shadowlap can’t open the store to check that nothing is recording into it: ${(err as Error).message}`);
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
  // A folder this process can't write to can't lose a file: said before the project leaves the list.
  try {
    accessSync(dir, constants.W_OK);
  } catch (err) {
    throw new RecordingsError('store', `Shadowlap can’t delete files in ${dir}: ${(err as Error).message}. Delete the recordings yourself.`);
  }
  if (recordingInProgress(folder, now)) throw new RecordingsError('recording', 'A run is being recorded in this folder. Let it finish or stop it, then delete the recordings.');
  return present();
}

/** Deletes the folder's store. Returns what it deleted, relative to the folder. */
export function deleteRecordings(folder: string, now: number = Date.now()): string[] {
  const files = storeFilesToDelete(folder, now);
  for (const rel of files) rmSync(join(folder, rel), { force: true });
  return files;
}
