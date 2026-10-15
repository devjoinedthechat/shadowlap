import { hostname } from 'node:os';

/**
 * Whether the process behind a run that is still `running` is there to finish it. A run is
 * recorded by one process (the `shadowlap` command whose sidecar writes it), which the store names
 * next to the run until it ends. A run left `running` by a process that was killed, ran out of
 * memory or lost its machine is abandoned: nothing will write to it again, so it must not hold up
 * a clean-up for ever.
 */

/** A run whose process can't be asked (it ran on another machine, or the store didn't name it) counts as abandoned after this long without a call. */
export const SILENT_UNKNOWN_MS = 24 * 3_600_000;

/** A run whose process is still there counts as abandoned only after this long without a call: a process id can be reused. */
export const SILENT_OWNED_MS = 7 * 24 * 3_600_000;

/** Whether a process with this id runs on this machine; one that belongs to another user counts. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The process a run is recorded by, as the store keeps it. */
export interface RunOwner {
  pid: number;
  host: string;
}

/** This process, as a run's owner. */
export function currentOwner(): RunOwner {
  return { pid: process.pid, host: hostname() };
}

/**
 * Whether a run still `running` was left by its process: that process is gone from this machine,
 * or nothing was heard from the run (its start or its latest call, `lastAt`) for longer than a
 * recording waits. A run this very process records is never left.
 */
export function recorderGone(owner: RunOwner | null, lastAt: number, now = Date.now()): boolean {
  const silent = now - lastAt;
  if (owner && owner.host === hostname()) {
    if (owner.pid === process.pid) return false;
    return !processAlive(owner.pid) || silent > SILENT_OWNED_MS;
  }
  return silent > SILENT_UNKNOWN_MS;
}
