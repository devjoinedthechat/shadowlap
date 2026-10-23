import type { Dashboard } from '@shadowlap/dashboard';
import { signalExit } from './exit-codes.js';

/**
 * Stopping a process that runs dashboard jobs. Each job leads a process group of its own, so neither
 * a Ctrl-C nor a closing terminal reaches it, nor the agent it started: the process passes the stop
 * on to its dashboard, which stops them, then ends. `shadowlap dashboard` and the dashboard
 * `shadowlap ui` opens both do.
 */

export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Calls `stop` on the first SIGINT, SIGTERM or SIGHUP, and `again` on any after it (someone who
 * does not want to wait). Returns a function that removes the handlers.
 */
export function onStopSignals(stop: (signal: NodeJS.Signals) => void, again: () => void): () => void {
  let stopping = false;
  const handler = (signal: NodeJS.Signals) => {
    if (stopping) return again();
    stopping = true;
    stop(signal);
  };
  for (const s of STOP_SIGNALS) process.on(s, handler);
  return () => {
    for (const s of STOP_SIGNALS) process.off(s, handler);
  };
}

export interface EmbeddedDashboard {
  /** Starts the dashboard on first use and returns the same one after. */
  open(): Promise<Dashboard>;
  /** Stops it, if it was started, waiting for its jobs: the terminal UI was quit. */
  close(): Promise<void>;
}

/**
 * The dashboard the terminal UI starts in its own process when asked (`o` on a run). Once it runs,
 * a stop signal reaches its jobs too: the dashboard stops them before the process ends, and the
 * process then ends as that signal would have ended it (the terminal UI restores the terminal on the
 * way out). A closed terminal (SIGHUP) kills the jobs at once, since nobody is left to wait and the
 * terminal UI cannot draw any more; a SIGINT or SIGTERM gives them the dashboard's grace time, and a
 * second signal kills them at once.
 */
export function embeddedDashboard(start: () => Promise<Dashboard>): EmbeddedDashboard {
  let dashboard: Promise<Dashboard> | undefined;
  let release: (() => void) | null = null;
  const open = (): Promise<Dashboard> => {
    dashboard ??= start().then(
      (d) => {
        release ??= onStopSignals(
          (signal) => {
            void d
              .close(signal === 'SIGHUP' ? { now: true } : {})
              .catch(() => undefined)
              .finally(() => {
                release?.();
                release = null;
                end(signal);
              });
          },
          () => void d.close({ now: true }),
        );
        return d;
      },
      (err: unknown) => {
        dashboard = undefined;
        throw err;
      },
    );
    return dashboard;
  };
  return {
    open,
    close: async () => {
      release?.();
      release = null;
      const d = await dashboard?.catch(() => null);
      if (!d) return;
      // While it waits for its jobs, a Ctrl-C (the terminal UI no longer takes the keys) kills them at
      // once instead of ending the process and leaving them running.
      const kill = () => void d.close({ now: true });
      const releaseWait = onStopSignals(kill, kill);
      try {
        await d.close();
      } catch {
        // stopped all the same
      } finally {
        releaseWait();
      }
    },
  };
}

/** Ends the process the way the signal would have: whatever else listens to it (the terminal UI's cleanup) runs first. */
function end(signal: NodeJS.Signals): void {
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(signalExit(signal));
  }
}
