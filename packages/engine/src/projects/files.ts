import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Small-file plumbing for the project list: one writer at a time, and never a half-written file. */

/**
 * Replaces `file` with `text` in one step: written to a temporary file beside it (owner-only, never
 * following a link that was planted there), flushed, then renamed over the old one. A crash leaves
 * the old list or the new one, never part of either.
 */
export function writeFileAtomic(file: string, text: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/**
 * A lock older than this is taken over even when its holder seems alive: a lock is held for a
 * few milliseconds, so one this old was left behind (its process's id reused, or the list shared
 * with another machine).
 */
const STALE_LOCK_MS = 10_000;

/** Whether the process that took a lock is still running: true, false, or null when the lock doesn't say. */
function holderAlive(lock: string): boolean | null {
  let pid: number;
  try {
    pid = Number(readFileSync(lock, 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null; // just created, its id not written yet
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes a lock left by a process that died. Only one process clears a given lock: the one that
 * creates `<lock>.stale` first. It then checks the lock is still the one found stale (nobody can
 * have replaced it while it stood there) before removing it. Returns whether it was cleared.
 */
function clearStaleLock(lock: string, found: { ino: number; mtimeMs: number }): boolean {
  const guard = `${lock}.stale`;
  try {
    closeSync(openSync(guard, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Another process is clearing it. A guard left by one that died in between goes after a while.
    try {
      if (Date.now() - statSync(guard).mtimeMs > STALE_LOCK_MS) rmSync(guard, { force: true });
    } catch {
      // gone already
    }
    return false;
  }
  try {
    const now = statSync(lock);
    if (now.ino !== found.ino || now.mtimeMs !== found.mtimeMs) return false;
    rmSync(lock, { force: true });
    return true;
  } catch {
    return true; // released in between
  } finally {
    rmSync(guard, { force: true });
  }
}

/**
 * Runs `fn` holding `<file>.lock`, so the CLI and the dashboard changing the list at the same time
 * don't lose each other's change. The lock is a file created exclusively, holding the process id;
 * one whose process is gone, or older than {@link STALE_LOCK_MS}, is taken over. A lock is held for
 * the time it takes to read and write a small file, so waiting for one is rare and short.
 */
export function withFileLock<T>(file: string, timeoutMs: number, fn: () => T): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let found;
      try {
        found = statSync(lock);
      } catch {
        continue; // released in between
      }
      if ((holderAlive(lock) === false || Date.now() - found.mtimeMs > STALE_LOCK_MS) && clearStaleLock(lock, found)) continue;
      if (Date.now() > deadline) throw new Error(`${lock} is held by another Shadowlap process. If none is running, delete it.`);
      sleep(5 + Math.floor(Math.random() * 15));
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
