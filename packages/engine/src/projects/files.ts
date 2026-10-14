import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
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

/** A lock older than this was left by a process that died holding it. */
const STALE_LOCK_MS = 10_000;

/**
 * Runs `fn` holding `<file>.lock`, so the CLI and the dashboard changing the list at the same time
 * don't lose each other's change. The lock is a file created exclusively; one left behind by a
 * crashed process is taken over after {@link STALE_LOCK_MS}.
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
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // released in between
      }
      if (Date.now() > deadline) throw new Error(`${lock} is held by another Shadowlap process. If none is running, delete it.`);
      sleep(15 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
