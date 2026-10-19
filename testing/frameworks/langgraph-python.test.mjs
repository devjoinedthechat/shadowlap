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

  // LangGraph's documented way for a tool to update graph state: return a Command. It is recorded in a
  // tagged form and rebuilt on replay, messages and all, so the state update happens again.
  const commandAgent = PYTHON ? pythonAgent(PYTHON, './langgraph_command_agent.py') : null;

  it('records a tool that returns a Command or a ToolMessage, and replays them so the state updates', async () => {
    const rec = await h.record(commandAgent('jane@example.com'));
    assert.equal(rec.error, undefined, rec.error?.stack);
    assert.deepEqual(toolTrace(rec.calls).sort(), ['find_customer:read:live:ok', 'whoami:pure:live:ok']);
    assert.deepEqual(rec.value.executed.sort(), ['find_customer', 'whoami']);
    assert.equal(rec.value.answer, 'Hello cust-for-jane@example.com');
    const replay = await h.replay(rec, commandAgent('jane@example.com'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.equal(replay.summary.divergence, null);
    assert.deepEqual(replay.value.executed, []);
    assert.deepEqual(
      { answer: replay.value.answer, customer: replay.value.customer, tool_message: replay.value.tool_message, whoami: replay.value.whoami },
      { answer: rec.value.answer, customer: 'cust-for-jane@example.com', tool_message: { type: 'ToolMessage', content: 'found cust-for-jane@example.com', artifact: { source: 'crm' } }, whoami: { type: 'ToolMessage', content: 'an agent', name: 'whoami' } },
    );
    const fork = await h.replay(rec, commandAgent('john@example.com'));
    assert.equal(fork.value.answer, 'Hello cust-for-john@example.com');
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
