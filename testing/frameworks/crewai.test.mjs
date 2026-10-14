// CrewAI in Python: a @tool function and a BaseTool subclass wrapped with shadowlap.adapters.crewai.with_effect,
// invoked through BaseTool.run the way a CrewAI agent calls them.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startHarness, toolTrace } from './harness.mjs';
import { findPython, pythonAgent } from './python.mjs';

const PYTHON = findPython('crewai');

describe('CrewAI (Python) with shadowlap.adapters.crewai', { skip: PYTHON ? false : 'no Python with crewai (set SHADOWLAP_PYTHON)' }, () => {
  let h;
  before(async () => (h = await startHarness()));
  after(() => h.close());
  const agent = PYTHON ? pythonAgent(PYTHON, './crewai_agent.py') : null;

  let recorded;
  it('records both tools with their validated arguments', async () => {
    recorded = await h.record(agent('shadowlap'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.deepEqual(recorded.value, { found: 'shadowlap #1', sent: 'sent to team@example.com', executed: ['search_web', 'send_email'], error: null });
    assert.deepEqual(toolTrace(recorded.calls), ['search_web:read:live:ok', 'send_email:write:live:ok']);
    assert.deepEqual(h.store.getJson(recorded.calls[1].requestRef), { args: { to: 'team@example.com' } });
  });

  it('replays without executing', async () => {
    const replay = await h.replay(recorded, agent('shadowlap'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.equal(replay.summary.divergence, null);
    assert.deepEqual(replay.value, { ...recorded.value, executed: [] });
  });

  it('forks on a changed query and blocks the email', async () => {
    const fork = await h.replay(recorded, agent('replay'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.deepEqual(fork.value.executed, ['search_web']);
    assert.match(fork.value.error, /^ShadowlapWriteBlocked/);
    assert.deepEqual(toolTrace(fork.calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
  });
});
