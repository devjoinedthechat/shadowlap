// The OpenAI Agents SDK for Python: a real Agent run by Runner with a scripted Model, tools defined
// with shadowlap.adapters.openai_agents.function_tool and a RunContextWrapper first parameter.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { untrustedReads } from '../../packages/engine/dist/index.js';
import { startHarness, toolTrace } from './harness.mjs';
import { findPython, pythonAgent } from './python.mjs';

const PYTHON = findPython('agents');

describe('OpenAI Agents SDK (Python) with shadowlap.adapters.openai_agents', { skip: PYTHON ? false : 'no Python with openai-agents (set SHADOWLAP_PYTHON)' }, () => {
  let h;
  before(async () => (h = await startHarness()));
  after(() => h.close());
  const agent = PYTHON ? pythonAgent(PYTHON, './openai_agents_agent.py') : null;

  let recorded;
  it('records both tools through the Runner; the run context is not recorded', async () => {
    recorded = await h.record(agent('shadowlap'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.equal(recorded.value.error, null);
    assert.deepEqual(recorded.value.executed, ['search_web', 'send_email']);
    assert.match(recorded.value.output, /shadowlap #1/);
    assert.match(recorded.value.output, /ops/); // the context still reached the tool
    assert.deepEqual(toolTrace(recorded.calls), ['search_web:read:live:ok', 'send_email:write:live:ok']);
    assert.deepEqual(h.store.getJson(recorded.calls.find((c) => c.name === 'search_web').requestRef), { args: { query: 'shadowlap' } });
  });

  it('passes trust on to shadowlap.tool: the untrusted read is recorded so, where shadowlap injection plants', () => {
    const meta = Object.fromEntries(recorded.calls.filter((c) => c.kind === 'tool').map((c) => [c.name, c.meta]));
    assert.equal(meta.search_web.trust, 'untrusted');
    assert.equal(meta.search_web.trustFrom, 'sdk');
    // A tool that doesn't say is sent no mark, and the agents SDK never sees the keyword.
    assert.equal(meta.send_email.trust, undefined);
    assert.deepEqual(untrustedReads(recorded.calls).reads.map((r) => [r.name, r.effect, r.from]), [['search_web', 'read', 'sdk']]);
  });

  it('replays without executing either tool', async () => {
    const replay = await h.replay(recorded, agent('shadowlap'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.equal(replay.summary.divergence, null);
    assert.deepEqual(replay.value.executed, []);
    assert.equal(replay.value.output, recorded.value.output);
  });

  it('forks on a changed query; the SDK reports the blocked email to the model and the run finishes', async () => {
    const fork = await h.replay(recorded, agent('replay'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.equal(fork.value.error, null);
    assert.deepEqual(fork.value.executed, ['search_web']);
    assert.match(fork.value.output, /ShadowlapWriteBlocked|blocked after divergence/);
    assert.deepEqual(toolTrace(fork.calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
  });
});
