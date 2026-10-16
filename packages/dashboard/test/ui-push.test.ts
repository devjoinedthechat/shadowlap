import { describe, expect, it } from 'vitest';
import { letGoAfterPush, pushable, untilDone } from '../ui/runspage/push.js';
import type { JobView } from '../ui/types.js';

/** Push in the Runs page's bulk bar: what goes, waiting for the job, and letting go of the runs picked once it worked. */

const job = (patch: Partial<JobView> = {}): JobView => ({ id: 'j1', args: ['push'], runId: null, opensRun: false, startedAt: 1, done: false, code: null, newRunId: null, lines: [], total: 0, ...patch });

describe('Push in the bulk bar', () => {
  it('sends the runs only here, the ones not known to be in the store, and runs still recording', () => {
    const picked = [
      { runId: 'a', status: 'completed', local: true },
      { runId: 'b', status: 'completed', local: false },
      { runId: 'c', status: 'failed' },
      { runId: 'd', status: 'running', local: false },
    ];
    expect(pushable(picked)).toEqual(['a', 'c', 'd']);
    expect(pushable([{ runId: 'b', status: 'completed', local: false }])).toEqual([]);
  });

  it('reads the job until it ends, and lets go of the runs picked only once it worked', async () => {
    const seen: number[] = [];
    const views = [job({ total: 2 }), job({ total: 5, done: true, code: 0 })];
    const end = await untilDone(job(), async (id, since) => (seen.push(since), expect(id).toBe('j1'), views.shift()!), { wait: async () => undefined });
    expect(end).toMatchObject({ done: true, code: 0 });
    // Each read asks for the lines after the ones it has.
    expect(seen).toEqual([0, 2]);
    expect(letGoAfterPush(end)).toBe(true);
    // A push that failed keeps them picked, to try again; so does a job the server lost.
    expect(letGoAfterPush(job({ done: true, code: 1 }))).toBe(false);
    expect(await untilDone(job(), async () => Promise.reject(new Error('gone')), { wait: async () => undefined })).toBeNull();
    expect(letGoAfterPush(null)).toBe(false);
    // A job that had ended already is not read again.
    expect(await untilDone(job({ done: true, code: 0 }), async () => Promise.reject(new Error('never read')))).toMatchObject({ code: 0 });
  });
});
