import { describe, expect, it } from 'vitest';
import type { CallRecord, RunRecord } from '@shadowlap/engine';
import { buildActions, splitCommand } from '../src/actions.js';

const run = (meta?: RunRecord['meta']): RunRecord => ({
  runId: '01K5CQ4N7G0000000000000000',
  parentRunId: null,
  mode: 'record',
  status: 'completed',
  divergence: null,
  command: { argv: ['node', 'agent.js'], cwd: '/' },
  codeVersion: null,
  startedAt: 0,
  endedAt: 1,
  ...(meta ? { meta } : {}),
});
const call: CallRecord = { runId: '01K5CQ4N7G0000000000000000', callNo: 3, kind: 'api', name: 'POST /v1/messages', fingerprint: 'f', occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: {}, at: 0, end: null, attempts: [] };

describe('actions on a run imported from a pack', () => {
  it('run straight away on a local run', () => {
    const r = buildActions(run(), call).find((a) => a.key === 'r')!;
    expect(r.args).toEqual(['replay', '01K5CQ4N7G0000000000000000']);
    expect(r.prompt).toBeUndefined();
  });

  it('ask for an explicit yes, show the command, and pass --yes only then', () => {
    const actions = buildActions(run({ imported: { at: 1, from: 'pack' } }), call);
    const replay = actions.find((a) => a.key === 'r')!;
    expect(replay.args).toBeUndefined();
    expect(replay.prompt!.label).toContain('node agent.js');
    expect(replay.prompt!.build('no')).toEqual([]);
    expect(replay.prompt!.build('')).toEqual([]);
    expect(replay.prompt!.build('yes')).toEqual(['replay', '01K5CQ4N7G0000000000000000', '--yes']);
    // A fork that already asks for input carries the warning and consents by being submitted.
    const inject = actions.find((a) => a.key === 'i')!;
    expect(inject.prompt!.label).toContain('imported pack');
    expect(inject.prompt!.build('Be brief.')).toEqual(['replay', '01K5CQ4N7G0000000000000000', '--inject', '3=Be brief.', '--yes']);
    // Actions that do not replay are unchanged.
    expect(actions.find((a) => a.key === 'p')!.prompt!.build('./out')).toEqual(['pack', '01K5CQ4N7G0000000000000000', './out']);
  });
});

describe('actions on a run built from a capture', () => {
  const capture = (): RunRecord => ({ ...run({ imported: { at: 1, from: '/tmp/session.har' }, covers: ['api'] }), command: { argv: ['<no-recorded-command>'], cwd: '/' } });

  it('ask for the agent command and place it after --, never before', () => {
    const actions = buildActions(capture(), call);
    const replay = actions.find((a) => a.key === 'r')!;
    expect(replay.args).toBeUndefined();
    expect(replay.label).toBe("Replay with your agent's command");
    expect(replay.prompt!.label).toContain('came from a capture');
    expect(replay.prompt!.build('python agent.py --task "fix the bug"')).toEqual(['replay', '01K5CQ4N7G0000000000000000', '--', 'python', 'agent.py', '--task', 'fix the bug']);
    expect(replay.prompt!.build('   ')).toEqual([]);
    // Someone else's command is not being run, so no --yes is added.
    expect(actions.find((a) => a.key === 'g')!.prompt!.build('node a.js')).toEqual(['replay', '01K5CQ4N7G0000000000000000', '--prompt-from', '3', '--', 'node', 'a.js']);
  });

  it('disable the forks that already ask for something, with the way forward', () => {
    const actions = buildActions(capture(), call);
    for (const key of ['e', 'i', 'f', 'm']) {
      const a = actions.find((x) => x.key === key)!;
      expect(a.disabled, key).toContain('Replay it with your command first');
    }
    // Packing does not run anything and stays available.
    expect(actions.find((a) => a.key === 'p')!.disabled).toBeUndefined();
  });
});

describe('fork actions', () => {
  it('answer an api call with an HTTP failure, and repeat a replay', () => {
    const actions = buildActions(run(), call);
    const fail = actions.find((a) => a.key === 'f')!;
    expect(fail.prompt!.initial).toBe('429');
    expect(fail.prompt!.build(' 529 ')).toEqual(['replay', '01K5CQ4N7G0000000000000000', '--fail-at', '3=529']);
    const repeat = actions.find((a) => a.key === 'e')!;
    expect(repeat.opensRun).toBe(false);
    expect(repeat.prompt!.build('5')).toEqual(['replay', '01K5CQ4N7G0000000000000000', '--repeat', '5']);
    // Neither is offered where it cannot apply: --fail-at answers model calls only.
    expect(buildActions(run(), { ...call, kind: 'tool', name: 'search' }).some((a) => a.key === 'f')).toBe(false);
  });
});

describe('splitCommand', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitCommand('python agent.py')).toEqual(['python', 'agent.py']);
    expect(splitCommand(`  node  a.js --q "two words" 'single quoted' ""  `)).toEqual(['node', 'a.js', '--q', 'two words', 'single quoted', '']);
    expect(splitCommand('a"b c"d')).toEqual(['ab cd']);
    expect(splitCommand('')).toEqual([]);
  });
});
