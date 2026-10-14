// LangGraph in Python: a compiled StateGraph with ToolNode, and three kinds of LangChain tool wrapped
// with shadowlap.adapters.langchain.with_effect (injected state, a BaseTool subclass, content_and_artifact).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startHarness, toolTrace } from './harness.mjs';
import { findPython, pythonAgent } from './python.mjs';

const PYTHON = findPython('langgraph');

describe('LangGraph (Python) with shadowlap.adapters.langchain', { skip: PYTHON ? false : 'no Python with langgraph (set SHADOWLAP_PYTHON)' }, () => {
  let h;
  before(async () => (h = await startHarness()));
  after(() => h.close());
  const agent = PYTHON ? pythonAgent(PYTHON, './langgraph_agent.py') : null;
  const args = (run, name) => h.store.getJson(run.calls.find((c) => c.name === name).requestRef);

  let recorded;
  it('records the parsed arguments, never the injected state or run manager', async () => {
    recorded = await h.record(agent('shadowlap'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.equal(recorded.value.error, null);
    assert.deepEqual([...recorded.value.executed].sort(), ['read_notes', 'search_web', 'send_email']);
    assert.deepEqual(args(recorded, 'search_web'), { args: { query: 'shadowlap' } });
    assert.deepEqual(args(recorded, 'send_email'), { args: { to: 'team@example.com' } });
    assert.deepEqual(args(recorded, 'read_notes'), { args: { topic: 'replay' } });
    assert.deepEqual(toolTrace(recorded.calls).sort(), ['read_notes:pure:live:ok', 'search_web:read:live:ok', 'send_email:write:live:ok']);
  });

  it('replays without executing; ToolMessages, the artifact and the final answer come back the same', async () => {
    const replay = await h.replay(recorded, agent('shadowlap'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.equal(replay.summary.divergence, null);
    assert.deepEqual(replay.value.executed, []);
    assert.equal(replay.value.output, recorded.value.output);
    assert.deepEqual(replay.value.artifact, { pages: 3 });
    assert.equal(replay.value.email, 'sent to team@example.com');
  });

  it('forks on a changed query and blocks the email', async () => {
    const fork = await h.replay(recorded, agent('replay'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.ok(!fork.value.executed.includes('send_email'));
    assert.ok(fork.calls.some((c) => c.name === 'send_email' && c.origin === 'blocked'));
    // ToolNode either reports the refusal to the model as an error ToolMessage or lets it end the run.
    assert.ok(fork.value.email_status === 'error' || /ShadowlapWriteBlocked/.test(fork.value.error ?? ''), JSON.stringify(fork.value));
  });
});
