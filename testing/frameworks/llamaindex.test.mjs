// LlamaIndex in Python: a FunctionAgent on LlamaIndex's Anthropic LLM, with FunctionTools over
// functions wrapped by shadowlap.tool. Model calls go through the sidecar (ANTHROPIC_BASE_URL) to a
// scripted Anthropic API; tool calls go through the SDK. Record, a clean replay, a fork.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { message, startMockAnthropic, text, toolUse } from '../mock-anthropic/dist/index.js';
import { startHarness, toolTrace } from './harness.mjs';
import { findPython, pythonAgent } from './python.mjs';

const PYTHON = findPython('llama_index.core');

/** What the user asked to research, from the request's first user message. */
const asked = (request) => /Research (\S+)/.exec(JSON.stringify(request.messages[0]))?.[1] ?? 'nothing';

describe('LlamaIndex (Python) with shadowlap.tool', { skip: PYTHON ? false : 'no Python with llama-index-core and llama-index-llms-anthropic (set SHADOWLAP_PYTHON)' }, () => {
  let h;
  let mock;
  before(async () => {
    mock = await startMockAnthropic({
      script: ({ request, assistantTurns }) => ({
        message:
          assistantTurns === 0
            ? message([toolUse('search_web', { query: asked(request) })], { stop_reason: 'tool_use' })
            : assistantTurns === 1
              ? message([toolUse('send_email', { to: 'team@example.com', body: `found ${asked(request)} #1` })], { stop_reason: 'tool_use' })
              : message([text(`Emailed the team about ${asked(request)}.`)], { stop_reason: 'end_turn' }),
      }),
    });
    h = await startHarness({ upstreams: { anthropic: mock.url } });
  });
  after(async () => {
    await h.close();
    await mock.close();
  });
  const agent = PYTHON ? pythonAgent(PYTHON, './llamaindex_agent.py') : null;

  let recorded;
  it('records the model calls through the sidecar and both tools through the SDK, the workflow Context left out', async () => {
    recorded = await h.record(agent('shadowlap'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.equal(recorded.value.answer, 'Emailed the team about shadowlap.');
    assert.deepEqual(recorded.value.executed, ['search_web', 'send_email']);
    assert.deepEqual(toolTrace(recorded.calls), ['search_web:read:live:ok', 'send_email:write:live:ok']);
    assert.equal(recorded.calls.filter((c) => c.kind === 'api').length, 3);
    assert.deepEqual(h.store.getJson(recorded.calls.find((c) => c.name === 'search_web').requestRef), { args: { query: 'shadowlap' } });
  });

  it('replays with no model request and no tool run', async () => {
    const before = mock.requests.length;
    const replay = await h.replay(recorded, agent('shadowlap'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.equal(replay.summary.divergence, null, JSON.stringify(replay.summary.divergence));
    assert.deepEqual(replay.value.executed, []);
    assert.equal(replay.value.answer, recorded.value.answer);
    assert.deepEqual(replay.value.results, recorded.value.results);
    assert.equal(mock.requests.length, before);
  });

  it('forks at the first model call when the request changes; the agent reports the blocked email to the model', async () => {
    const fork = await h.replay(recorded, agent('replays'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.equal(fork.summary.divergence?.callNo, 1);
    assert.deepEqual(fork.value.executed, ['search_web']);
    assert.deepEqual(toolTrace(fork.calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
    const email = fork.value.results.find((r) => r.name === 'send_email');
    assert.equal(email.is_error, true);
    assert.match(email.output, /blocked/);
  });
});
