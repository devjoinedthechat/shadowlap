import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { withLockFile } from '../lock-file.js';

/** Small-file plumbing for the project list: one writer at a time, and never a half-written file. */

/**
 * Replaces `file` with `text` in one step: written to a temporary file beside it (owner-only, never
 * following a link that was planted there), flushed, then renamed over the old one. A crash leaves
 * the old list or the new one, never part of either; a write that fails, or stops short as on a full
 * disk, leaves the old one, and no temporary file.
 */
export function writeFileAtomic(file: string, text: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  const bytes = Buffer.from(text, 'utf8');
  try {
    try {
      // Node writes until all of it is written or a write fails, and then says how much was written
      // without throwing: short is that failure.
      if (writeSync(fd, bytes) !== bytes.length) throw new Error(`${file} could not be written whole: the disk may be full`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** What withFileLock throws while another process still holds the lock once its wait is up: for a caller that skips its write rather than fail. */
export class FileLockBusyError extends Error {
  override readonly name = 'FileLockBusyError';
}

/**
 * Runs `fn` holding `<file>.lock`, so the CLI and the dashboard changing the list at the same time
 * don't lose each other's change (lock-file.ts: a lock whose process is gone is taken over at once,
 * and one whose process runs on this machine is not, but on Windows after ten seconds). A lock is
 * held for the time it takes to read and write a small file, so waiting for one is rare and short;
 * a `timeoutMs` of 0 tries once.
 */
export function withFileLock<T>(file: string, timeoutMs: number, fn: () => T): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  return withLockFile(lock, { wait: timeoutMs, mode: 0o600, busy: () => new FileLockBusyError(`${lock} is held by another shadowlap process. If none is running, delete it.`) }, fn);
}
