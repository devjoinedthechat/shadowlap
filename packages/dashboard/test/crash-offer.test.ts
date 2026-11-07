import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { crashOffer } from '../src/run-offers.js';

describe('a test replay that crashed', () => {
  it('offers the last line its agent printed and where it stopped, and nothing for a replay that failed otherwise', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234' });
    const replay = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, meta: { test: { golden: 'goldens/x', session: s.sessionId } } });
    store.setDivergence(replay.runId, { type: 'ended_early', callNo: 19, kind: 'api', name: 'POST /v1/messages', replayedBefore: 18, recorded: 30 });
    const output = 'Traceback (most recent call last):\n  File "agent.py", line 12\nKeyError: \'total\'\n';
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: replay.runId, data: { output } });
    expect(crashOffer(store, store.getRun(replay.runId)!)).toEqual({ line: "KeyError: 'total'", at: 19, of: 30 });
    const other = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, meta: { test: { golden: 'goldens/y', session: s.sessionId } } });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/y', ok: false, failure: 'diverged', runId: other.runId, data: { output } });
    expect(crashOffer(store, store.getRun(other.runId)!)).toBeNull();
    store.close();
  });
});
