import { writeSync } from 'node:fs';

/**
 * Structured events for the dashboard's job runner. `shadowlap dashboard` starts the CLI with an
 * extra pipe and `SHADOWLAP_EVENTS_FD` naming it; commands report what they made through it, one
 * JSON object per line, so a job can link to a new run, a fix or a file without parsing the
 * human-readable output. Outside a dashboard job this does nothing.
 */
export type JobEvent =
  /** A run this command created (a recording, a replay, a fork, an attempt, an import). */
  | { type: 'run'; runId: string; role?: 'new' | 'passing' | 'failing' | 'attempt' | 'imported' }
  /** Something to open afterwards; `href` is a dashboard route such as `#/fixes/fx-…`. */
  | { type: 'link'; label: string; href: string }
  /** A file the command wrote, which the dashboard may offer as a download. */
  | { type: 'file'; path: string; label?: string }
  /** The command's machine-readable result (the same object `--json` prints, when it has one). */
  | { type: 'result'; data: unknown };

function eventsFd(env: NodeJS.ProcessEnv): number | null {
  const fd = Number(env.SHADOWLAP_EVENTS_FD);
  return Number.isInteger(fd) && fd >= 3 ? fd : null;
}

/** Whether this command runs as a dashboard job, whose drawer shows its output: what to do next can name the dashboard's button. */
export function inDashboardJob(env: NodeJS.ProcessEnv = process.env): boolean {
  return eventsFd(env) !== null;
}

/** Reports one event to the dashboard job that started this command. Never throws. */
export function emitJobEvent(event: JobEvent, env: NodeJS.ProcessEnv = process.env): void {
  const fd = eventsFd(env);
  if (fd === null) return;
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`);
  } catch {
    // the dashboard went away, or the descriptor isn't ours: the command's own output still stands
  }
}
