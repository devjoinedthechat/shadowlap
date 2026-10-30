import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach } from 'vitest';

/**
 * How long before its test's own timeout a command the test started counts as hung. Stopped then, it
 * fails the test with the command and what it printed; the timeout says neither, and leaves the
 * command running beside the tests after it, which on a busy machine makes them time out in turn.
 */
export const HANG_MARGIN_MS = 5_000;

/** When the test running now must have its commands back: its timeout less the margin. */
let deadline: number | null = null;
/** The commands still running, each stopped once its test is over, however that ended: with whether it leads a process group. */
const running = new Map<ChildProcess, boolean>();

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
    await Promise.all([...running].map(([child, group]) => stop(child, group)));
  });
}

/**
 * Watches `child`, the command `what`: once its test's deadline passes, it is stopped, and `fail` is
 * given why, with the end of what it printed (`printed`). `group`: it was started `detached` on macOS
 * or Linux, so it leads a process group, and what it started (a command it runs in turn) is stopped
 * with it.
 */
export function watch(child: ChildProcess, what: string, printed: () => string, fail: (err: Error) => void, o: { group?: boolean } = {}): void {
  const group = o.group === true && process.platform !== 'win32';
  running.set(child, group);
  const started = Date.now();
  const timer =
    deadline === null
      ? null
      : setTimeout(
          () => {
            void stop(child, group);
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
 * Runs Node on `argv`, watched: how it exited, and what it printed on either stream. `group`: it
 * leads a process group of its own (`detached`, on macOS and Linux), so what it starts in turn (the
 * CLI the GitHub Action runs, the agents that runs) is stopped with it.
 */
export function runNode(argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; group?: boolean }): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const group = o.group === true && process.platform !== 'win32';
    const child = spawn(process.execPath, argv, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
    let out = '';
    watch(child, `node ${argv.join(' ')}`, () => out, reject, { group });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

/**
 * Stops a command as Ctrl-C does, which ends the attempts it runs and their agents with it; what is
 * left of it 5 s later is killed outright. Resolves once the command has exited.
 */
function stop(child: ChildProcess, group: boolean): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const signal = (s: NodeJS.Signals) => {
    try {
      // A negative pid is the group the command leads, which lives on while anything in it does.
      if (group && child.pid) process.kill(-child.pid, s);
      else child.kill(s);
    } catch {
      // already gone
    }
  };
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    signal('SIGINT');
    setTimeout(() => signal('SIGKILL'), 5_000).unref();
  });
}
