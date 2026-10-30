import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach } from 'vitest';

/**
 * How long before its test's own timeout a command the test started counts as hung. Stopped then, it
 * fails the test with the command and what it printed; the timeout says neither, and leaves the
 * command running beside the tests after it, which on a busy machine makes them time out in turn.
 */
export const HANG_MARGIN_MS = 5_000;

/** When the test running now must have its commands back: its timeout less the margin. */
let deadline: number | null = null;
/** The commands still running, each stopped once its test is over, however that ended. */
const running = new Set<ChildProcess>();

/**
 * Limits the commands each test in the file starts and `watch`es: one still running HANG_MARGIN_MS
 * before its test would time out is stopped, and the test fails saying so; any still running when a
 * test ends is stopped as well.
 */
export function limitHangs(): void {
  beforeEach(({ task }) => {
    deadline = Date.now() + task.timeout - HANG_MARGIN_MS;
  });
  afterEach(async () => {
    deadline = null;
    await Promise.all([...running].map(stop));
  });
}

/**
 * Watches `child`, the command `what`: once its test's deadline passes, it is stopped, and `fail` is
 * given why, with the end of what it printed (`printed`).
 */
export function watch(child: ChildProcess, what: string, printed: () => string, fail: (err: Error) => void): void {
  running.add(child);
  const started = Date.now();
  const timer =
    deadline === null
      ? null
      : setTimeout(
          () => {
            void stop(child);
            fail(new Error(`${what} was still running after ${Math.round((Date.now() - started) / 1000)} s, ${HANG_MARGIN_MS / 1000} s before its test would time out, so it was stopped as hung. The end of what it printed:\n${printed().slice(-4000)}`));
          },
          Math.max(0, deadline - started),
        );
  child.once('exit', () => {
    if (timer) clearTimeout(timer);
    running.delete(child);
  });
}

/**
 * Stops a command as Ctrl-C does, which ends the attempts it runs and their agents with it; killed
 * outright if it still runs 5 s later. Resolves once it has exited.
 */
function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill('SIGINT');
  });
}
