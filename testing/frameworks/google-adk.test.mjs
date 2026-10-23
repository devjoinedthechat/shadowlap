// Google ADK in Python: an LlmAgent on Gemini, run by ADK's Runner, with plain functions wrapped by
// shadowlap.tool as its tools. Model calls go through the sidecar (GOOGLE_GEMINI_BASE_URL) to a
// scripted Gemini; tool calls go through the SDK. Record, a clean replay, a fork.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { functionCall, startMockGemini, turn } from '../mock-gemini/dist/index.js';
import { startHarness, toolTrace } from './harness.mjs';
import { findPython, pythonAgent } from './python.mjs';

const PYTHON = findPython('google.adk');

/** The query the user asked about, from the request's first user part. */
const asked = (request) => /Research (\S+)/.exec(JSON.stringify(request.contents[0]))?.[1] ?? 'nothing';
const responses = (request) => request.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse).length;

describe('Google ADK (Python) with shadowlap.tool', { skip: PYTHON ? false : 'no Python with google-adk (set SHADOWLAP_PYTHON)' }, () => {
  let h;
  let mock;
  before(async () => {
    mock = await startMockGemini({
      script: ({ request }) => {
        const done = responses(request);
        if (done === 0) return { turn: turn(null, { functionCalls: [functionCall('search_web', { query: asked(request) })] }) };
        if (done === 1) return { turn: turn(null, { functionCalls: [functionCall('send_email', { to: 'team@example.com', body: `found ${asked(request)} #1` })] }) };
        return { turn: turn(`Emailed the team about ${asked(request)}.`) };
      },
    });
    h = await startHarness({ upstreams: { gemini: mock.url } });
  });
  after(async () => {
    await h.close();
    await mock.close();
  });
  const agent = PYTHON ? (query) => pythonAgent(PYTHON, './adk_agent.py')(query) : null;
  const env = { GOOGLE_API_KEY: 'test-key' };
  const withEnv = (fn) => async () => {
    const saved = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = env.GOOGLE_API_KEY;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = saved;
    }
  };

  let recorded;
  it('records the model calls through the sidecar and both tools through the SDK, ToolContext left out', async () => {
    recorded = await h.record(withEnv(agent('shadowlap')));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.equal(recorded.value.answer, 'Emailed the team about shadowlap.');
    assert.deepEqual(recorded.value.executed, ['search_web', 'send_email']);
    assert.deepEqual(toolTrace(recorded.calls), ['search_web:read:live:ok', 'send_email:write:live:ok']);
    assert.equal(recorded.calls.filter((c) => c.kind === 'api').length, 3);
    assert.equal(mock.requests.length, 3);
    assert.deepEqual(h.store.getJson(recorded.calls.find((c) => c.name === 'search_web').requestRef), { args: { query: 'shadowlap' } });
    assert.equal(recorded.calls.find((c) => c.name === 'search_web').meta.trust, 'untrusted');
  });

  it('replays with no model request and no tool run', async () => {
    const before = mock.requests.length;
    const replay = await h.replay(recorded, withEnv(agent('shadowlap')));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.equal(replay.summary.divergence, null, JSON.stringify(replay.summary.divergence));
    assert.deepEqual(replay.value.executed, []);
    assert.equal(replay.value.answer, recorded.value.answer);
    assert.deepEqual(replay.value.results, recorded.value.results);
    assert.equal(mock.requests.length, before);
  });

  it('forks at the first model call when the request changes; the model reads the blocked email as its answer', async () => {
    const fork = await h.replay(recorded, withEnv(agent('replays')));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.equal(fork.summary.divergence?.callNo, 1);
    assert.deepEqual(fork.value.executed, ['search_web']);
    assert.deepEqual(toolTrace(fork.calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
    assert.match(fork.value.results.find((r) => r.name === 'send_email').response.error, /blocked/);
    assert.equal(fork.value.answer, 'Emailed the team about replays.');
  });
});
