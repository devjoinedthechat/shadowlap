import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { withLockFile } from '@shadowlap/engine';

/**
 * `.shadowlap/active.json`: the run `shadowlap run` is recording or replaying in this folder, for a
 * `shadowlap mcp` its MCP client started with a minimal environment (mcp-sidecar.ts). The run that started
 * last writes it; a run that ends removes it only while it still names that run.
 *
 * Both happen under `.shadowlap/active.json.lock` (the engine's lock file). Without it, a run
 * starting between an ending run's check and its removal lost its file, and two runs starting at
 * once could leave neither's. Readers take no lock: the file is replaced in one rename, so a reader
 * sees a whole file or none.
 */

export interface ActiveRun {
  url: string;
  runId: string;
  pid: number;
}

/** How long a run waits for another starting or ending in the same folder: each holds the lock for a write. */
const WAIT_MS = 2_000;

export function activeRunFile(cwd: string): string {
  return join(cwd, '.shadowlap', 'active.json');
}

function underLock(file: string, wait: number, fn: () => void): void {
  withLockFile(`${file}.lock`, { wait, mode: 0o600, busy: () => new Error(`${file} is being changed by another run (if no Shadowlap command is running, delete ${file}.lock)`) }, fn);
}

/**
 * Names `run` in the folder's active-run file. It carries the sidecar's session token, so it is the
 * owner's only, and it is written beside the path and renamed over it: a symbolic link left at the
 * path is replaced, never followed. Throws when the folder can't be written.
 */
export function markActiveRun(cwd: string, run: ActiveRun, wait: number = WAIT_MS): void {
  const file = activeRunFile(cwd);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  underLock(file, wait, () => {
    const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify(run) + '\n', { mode: 0o600, flag: 'wx' });
    try {
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  });
}

/** Removes the folder's active-run file if it still names `runId`: another run that started since has written its own. */
export function clearActiveRun(cwd: string, runId: string, wait: number = WAIT_MS): void {
  const file = activeRunFile(cwd);
  underLock(file, wait, () => {
    let named: unknown;
    try {
      named = (JSON.parse(readFileSync(file, 'utf8')) as { runId?: unknown }).runId;
    } catch {
      return; // gone already, or not a file this could have written
    }
    if (named === runId) rmSync(file, { force: true });
  });
}
