// The Vercel AI SDK: generateText with its own mock model, tools wrapped by withEffects, run through
// the SDK's real tool loop (input parsing, execute(input, options), tool-result parts).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { withEffects } from '../../packages/adapters/dist/ai-sdk.js';
import { startHarness, toolTrace } from './harness.mjs';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

/** Step 1: search. Step 2: email, once the results are in. Step 3: done. The query comes from the scenario. */
function model(query) {
  let step = 0;
  const call = (id, toolName, input) => ({ content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage, warnings: [] });
  return new MockLanguageModelV4({
    doGenerate: async () => {
      step++;
      if (step === 1) return call('call_1', 'search_web', { query });
      if (step === 2) return call('call_2', 'send_email', { to: 'team@example.com' });
      return { content: [{ type: 'text', text: 'Done.' }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] };
    },
  });
}
const toolOutputs = (result) => result.steps.flatMap((s) => s.content.filter((p) => p.type === 'tool-result').map((p) => p.output));

describe('Vercel AI SDK (ai) with @shadowlap/adapters/ai-sdk', () => {
  let h;
  const executed = [];
  before(async () => (h = await startHarness()));
  after(() => h.close());

  const tools = () =>
    withEffects(
      {
        search_web: tool({
          description: 'Search the web',
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }, options) => {
            executed.push('search_web');
            assert.equal(typeof options.toolCallId, 'string'); // the options object still reaches the implementation
            return { results: [`${query} #1`] };
          },
        }),
        send_email: tool({
          description: 'Send an email',
          inputSchema: z.object({ to: z.string() }),
          execute: async ({ to }) => {
            executed.push('send_email');
            return { sent: true, to };
          },
        }),
      },
      { search_web: 'read', send_email: 'write' },
    );

  const agent = (query) => generateText({ model: model(query), tools: tools(), prompt: 'Research and email the team.', stopWhen: stepCountIs(4) });

  let recorded;
  it('records both tool calls through generateText', async () => {
    recorded = await h.record(() => agent('shadowlap'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.deepEqual(executed, ['search_web', 'send_email']);
    assert.deepEqual(toolTrace(recorded.calls), ['search_web:read:live:ok', 'send_email:write:live:ok']);
    assert.equal(recorded.value.text, 'Done.');
    assert.deepEqual(toolOutputs(recorded.value), [{ results: ['shadowlap #1'] }, { sent: true, to: 'team@example.com' }]);
    // Only the input is recorded: the SDK's options object (tool call id, messages, abort signal) is not.
    const req = h.store.getJson(recorded.calls.find((c) => c.name === 'search_web').requestRef);
    assert.deepEqual(req, { args: { query: 'shadowlap' } });
  });

  it('replays both from the recording without executing them', async () => {
    executed.length = 0;
    const replay = await h.replay(recorded, () => agent('shadowlap'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.deepEqual(executed, []);
    assert.equal(replay.summary.divergence, null);
    assert.deepEqual(toolOutputs(replay.value), [{ results: ['shadowlap #1'] }, { sent: true, to: 'team@example.com' }]);
  });

  it('forks on changed input and blocks the email; the SDK surfaces it as a tool error', async () => {
    executed.length = 0;
    const fork = await h.replay(recorded, () => agent('replay'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.deepEqual(executed, ['search_web']);
    assert.equal(fork.summary.divergence?.name, 'search_web');
    assert.deepEqual(toolTrace(fork.calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
    const errors = fork.value.steps.flatMap((s) => s.content.filter((p) => p.type === 'tool-error'));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].toolName, 'send_email');
    assert.match(String(errors[0].error?.message ?? errors[0].error), /blocked/);
  });
});
