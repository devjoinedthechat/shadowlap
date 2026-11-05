import { describe, expect, it } from 'vitest';
import { noFixKind, type CallRecord, type RunRecord } from '@shadowlap/engine';
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
    expect(repeat(run())).toEqual({ key: 'e', label: 'Repeat 5 times', opensRun: false, prompt: null, disabled: null, flag: '--repeat 5', group: 'run', command: `shadowlap replay ${ID} --repeat 5`, hint: 'Replays this run five times: what replays is free, and the attempts show whether the path after a fork holds or was luck.' });
    const fork = run({ mode: 'replay', parentRunId: '01K5CQ4N700000000000000000', meta: { interventions: [{ kind: 'diverge', at: 9, flag: '--diverge-at 9', args: ['--diverge-at', '9'] }] } });
    expect(repeat(fork)).toMatchObject({ label: 'Repeat 5 times', prompt: null, asksFirst: true, hint: expect.stringContaining('each attempt runs live from the fork') });
  });
});

describe('what a call’s actions tell the dialog that asks', () => {
  const call = (over: Partial<CallRecord>): CallRecord => ({ runId: ID, callNo: 3, kind: 'tool', name: 'send_email', effect: 'read', meta: {}, ...over }) as unknown as CallRecord;
  const action = (key: string, over: Partial<CallRecord>) => actionsFor(run(), call(over), {}).find((a) => a.key === key)!;

  it('asks before a write is forced live, in red, and starts any other tool at once', () => {
    expect(action('l', { effect: 'write' })).toMatchObject({ asksFirst: true, warns: 'send_email acts on your systems', prompt: null, command: `shadowlap replay ${ID} --live-tool send_email` });
    const read = action('l', { effect: 'read' });
    expect(read.asksFirst).toBeUndefined();
    expect(read.warns).toBeUndefined();
  });

  it('names the model that takes no system message mid-conversation, for an instruction’s row', () => {
    const inject = (model: string) => actionsFor(run(), call({ kind: 'api', name: 'POST /v1/messages', effect: null, meta: { model } }), {}).find((a) => a.key === 'i')!;
    expect(inject('claude-sonnet-5').noSystemMessage).toBe('claude-sonnet-5');
    expect(inject('claude-haiku-4-5').noSystemMessage).toBeUndefined();
  });
});

describe('why a repair would end with no fix to try', () => {
  it('tells the estimate’s two cases apart by the engine’s own sentence', () => {
    expect(noFixKind(null)).toBeNull();
    expect(noFixKind('Blame couldn\'t settle where the run was lost, so a rewrite of the prompt has nothing to aim at yet: the repair ends “No fix to try”. Settle the blame first.')).toBe('unsettled');
    expect(noFixKind('No failing run was rescued, so there is no passing path to learn from: the repair ends “No fix to try”.')).toBe('unrescued');
    expect(noFixKind('Blame found that no answer of the model\'s lost this run, so a rewrite of the prompt can\'t fix it: the repair ends “No fix to try”.')).toBe('unrescued');
  });
});
