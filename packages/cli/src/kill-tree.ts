import { spawnSync, type ChildProcess } from 'node:child_process';

/**
 * Stops an agent Shadowlap started and what it started in turn (`npm start` runs node, a test
 * harness its workers). On macOS and Linux an agent started with a process group of its own
 * (`detached`) is signalled as a group. Windows has no process groups, and a signal there ends the
 * one process it reaches, leaving its children running; so there the agent's whole tree is ended with
 * `taskkill /T /F`, as the dashboard stops a job, while the agent is still running (once it has
 * exited, its children can no longer be found from it). Never throws.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals, o: { group?: boolean; platform?: NodeJS.Platform; taskkill?: (pid: number) => boolean } = {}): void {
  const pid = child.pid;
  try {
    if (pid && (o.platform ?? process.platform) === 'win32') {
      if (child.exitCode === null && child.signalCode === null && (o.taskkill ?? taskkill)(pid)) return;
    } else if (pid && o.group) {
      // A negative pid is the group the agent leads, which lives on while anything in it does.
      process.kill(-pid, signal);
      return;
    }
    child.kill(signal);
  } catch {
    // already gone
  }
}

/** Ends a process and every process below it; false when taskkill couldn't (not found, or gone). */
function taskkill(pid: number): boolean {
  const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
  return r.status === 0;
}
