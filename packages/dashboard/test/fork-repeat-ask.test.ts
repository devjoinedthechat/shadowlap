import { describe, expect, it } from 'vitest';
import type { RunRecord } from '@shadowlap/engine';
import { actionsFor } from '../src/api.js';

/**
 * The fork menu's Repeat 5 times, as the server lists it for the page: five attempts, nothing to fill
 * in, and on a fork, whose attempts run live from where it forks, the page asks first; on a
 * recording they replay offline, and it starts at once.
 */

const ID = '01K5CQ4N7G0000000000000000';
const run = (extra: Partial<RunRecord> = {}): RunRecord => ({ runId: ID, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.js'], cwd: '/' }, codeVersion: null, startedAt: 0, endedAt: 1, ...extra });

describe('Repeat 5 times, as the page is sent it', () => {
  it('asks first on a fork, and starts at once on a recording', () => {
    const repeat = (r: RunRecord) => actionsFor(r, undefined).find((a) => a.key === 'e')!;
    expect(repeat(run())).toEqual({ key: 'e', label: 'Repeat 5 times', opensRun: false, prompt: null, disabled: null, flag: '--repeat 5', group: 'run', hint: 'Replays this run five times: what replays is free, and the attempts show whether the path after a fork holds or was luck.' });
    const fork = run({ mode: 'replay', parentRunId: '01K5CQ4N700000000000000000', meta: { interventions: [{ kind: 'diverge', at: 9, flag: '--diverge-at 9', args: ['--diverge-at', '9'] }] } });
    expect(repeat(fork)).toMatchObject({ label: 'Repeat 5 times', prompt: null, asksFirst: true, hint: expect.stringContaining('each attempt runs live from the fork') });
  });
});
