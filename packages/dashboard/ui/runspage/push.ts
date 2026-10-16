import type { JobView } from '../types.js';

/**
 * Push in the Runs page's bulk bar, apart from the bar so the tests run it: which of the runs picked
 * go, waiting for the push job to end, and whether the bar then lets go of the runs it picked (as
 * the design does once they are in the store). No DOM here.
 */

/** What the bar knows of a run picked, as far as Push is concerned. */
export interface PushPick {
  runId: string;
  status: string;
  /** Only on this machine; undefined when the page didn't say. */
  local?: boolean;
}

/** The runs Push sends: those only here, or not known to be in the store, and runs still recording (queued until they end). */
export function pushable(runs: readonly PushPick[]): string[] {
  return runs.filter((r) => r.status === 'running' || r.local !== false).map((r) => r.runId);
}

/**
 * Reads a job until it has ended, every `ms`: its last view, or null when it can't be read any
 * more (the server went away, or was restarted and lost it).
 */
export async function untilDone(job: JobView, read: (id: string, since: number) => Promise<JobView>, o: { ms?: number; wait?: (ms: number) => Promise<void> } = {}): Promise<JobView | null> {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  for (let v = job; ; ) {
    if (v.done) return v;
    await wait(o.ms ?? 400);
    try {
      v = await read(job.id, v.total);
    } catch {
      return null;
    }
  }
}

/** Whether the bar lets go of the runs it picked: once the push ended and worked, they are in the store. */
export function letGoAfterPush(end: Pick<JobView, 'done' | 'code'> | null): boolean {
  return !!end && end.done && end.code === 0;
}
