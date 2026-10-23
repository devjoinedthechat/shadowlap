// Shared by the Python framework tests whose agent asks a scripted model API through the sidecar:
// the user asks to research QUERY and email the team, and the scripted model searches, emails, and
// answers. Each framework's test records it (model calls through the sidecar, tools through the SDK),
// replays it with no model request and no tool run, and forks it at the first model call with
// another QUERY, where the email is blocked and the framework hands the refusal to its model.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { message, startMockAnthropic, text, toolUse } from '../mock-anthropic/dist/index.js';
import { startMockOpenAI, toolCall, turn } from '../mock-openai/dist/index.js';
import { startHarness, toolTrace } from './harness.mjs';
import { findPython, pythonAgent } from './python.mjs';

/** What the user asked to research, from the request. */
const asked = (request) => /Research (\S+?) and email/.exec(JSON.stringify(request.messages))?.[1] ?? 'nothing';

/** The scripted model, by the API the framework's client speaks. */
async function scriptedModel(api) {
  if (api === 'anthropic') {
    const mock = await startMockAnthropic({
      script: ({ request, assistantTurns }) => ({
        message:
          assistantTurns === 0
            ? message([toolUse('search_web', { query: asked(request) })], { stop_reason: 'tool_use' })
            : assistantTurns === 1
              ? message([toolUse('send_email', { to: 'team@example.com', body: `found ${asked(request)} #1` })], { stop_reason: 'tool_use' })
              : message([text(`Emailed the team about ${asked(request)}.`)], { stop_reason: 'end_turn' }),
      }),
    });
    return { mock, upstreams: { anthropic: mock.url }, count: () => mock.requests.length };
  }
  // A framework that ends a run only through a tool of its own (smolagents' final_answer) gets its answer that way.
  const finalAnswer = (request) => request.tools?.some((t) => t.function?.name === 'final_answer');
  // By what the conversation holds, not by its turns: a framework may write a failed step without one.
  const searched = (request) => /#1/.test(JSON.stringify(request.messages));
  const emailed = (request) => /sent to|blocked|failed/i.test(JSON.stringify(request.messages));
  const mock = await startMockOpenAI({
    script: ({ request }) => ({
      turn:
        !searched(request)
          ? turn(null, { tool_calls: [toolCall('search_web', { query: asked(request) })] })
          : !emailed(request)
            ? turn(null, { tool_calls: [toolCall('send_email', { to: 'team@example.com', body: `found ${asked(request)} #1` })] })
            : finalAnswer(request)
              ? turn(null, { tool_calls: [toolCall('final_answer', { answer: `Emailed the team about ${asked(request)}.` })] })
              : turn(`Emailed the team about ${asked(request)}.`),
    }),
  });
  return { mock, upstreams: { openai: mock.url }, count: () => mock.requests.length + mock.otherRequests.length };
}

/**
 * The three tests for one framework. `module` is what the Python must import; `api` the model API its
 * client speaks; `refused(value)` checks the blocked email reached the framework's model.
 */
export function scriptedAgentTests({ name, module, script, api, refused }) {
  const PYTHON = findPython(module);
  describe(`${name} (Python) with shadowlap.tool`, { skip: PYTHON ? false : `no Python with ${module} (set SHADOWLAP_PYTHON)` }, () => {
    let h;
    let model;
    before(async () => {
      model = await scriptedModel(api);
      h = await startHarness({ upstreams: model.upstreams });
    });
    after(async () => {
      await h.close();
      await model.mock.close();
    });
    const agent = PYTHON ? pythonAgent(PYTHON, script) : null;

    let recorded;
    it('records the model calls through the sidecar and both tools through the SDK', async () => {
      recorded = await h.record(agent('shadowlap'));
      assert.equal(recorded.error, undefined, recorded.error?.stack);
      assert.match(recorded.value.answer, /Emailed the team about shadowlap\./);
      assert.deepEqual(recorded.value.executed, ['search_web', 'send_email']);
      assert.deepEqual(toolTrace(recorded.calls), ['search_web:read:live:ok', 'send_email:write:live:ok']);
      assert.equal(recorded.calls.filter((c) => c.kind === 'api').length, 3);
      assert.deepEqual(h.store.getJson(recorded.calls.find((c) => c.name === 'search_web').requestRef), { args: { query: 'shadowlap' } });
    });

    it('replays with no model request and no tool run', async () => {
      const before = model.count();
      const replay = await h.replay(recorded, agent('shadowlap'));
      assert.equal(replay.error, undefined, replay.error?.stack);
      assert.equal(replay.summary.divergence, null, JSON.stringify(replay.summary.divergence));
      assert.deepEqual(replay.value.executed, []);
      assert.equal(replay.value.answer, recorded.value.answer);
      assert.equal(model.count(), before);
    });

    it('forks at the first model call when the request changes, and blocks the email', async () => {
      const fork = await h.replay(recorded, agent('replays'));
      assert.equal(fork.error, undefined, fork.error?.stack);
      assert.equal(fork.summary.divergence?.callNo, 1);
      assert.deepEqual(fork.value.executed, ['search_web']);
      assert.deepEqual(toolTrace(fork.calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
      refused(fork.value);
    });
  });
}
