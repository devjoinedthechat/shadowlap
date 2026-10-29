// The Anthropic SDK tool runner, end to end: client.beta.messages.toolRunner with betaZodTool over a
// definition wrapped by withEffect. Model calls go through the sidecar (ANTHROPIC_BASE_URL) to the
// scripted mock API; tool calls go through the adapter. Record, clean replay, fork. Run to the end
// with runUntilDone(), and streamed (`stream: true`), each turn's message stream read event by event.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { message, startMockAnthropic, text, toolUse } from '../mock-anthropic/dist/index.js';
import { withEffect } from '../../packages/adapters/dist/anthropic.js';
import { startHarness, toolTrace } from './harness.mjs';

for (const stream of [false, true]) describe(`Anthropic tool runner (@anthropic-ai/sdk) with @shadowlap/adapters/anthropic${stream ? ', streamed' : ''}`, () => {
  let h;
  let mock;
  const executed = [];
  before(async () => {
    mock = await startMockAnthropic({
      script: (ctx) => ({
        message:
          ctx.assistantTurns === 0
            ? message([text('Looking.'), toolUse('search_web', { query: 'shadowlap' }), toolUse('send_email', { to: 'team@example.com' })])
            : message([text('Done.')], { stop_reason: 'end_turn' }),
      }),
    });
    h = await startHarness({ upstreams: { anthropic: mock.url } });
  });
  after(async () => {
    await h.close();
    await mock.close();
  });

  const tools = () => [
    betaZodTool(
      withEffect(
        {
          name: 'search_web',
          description: 'Search the web',
          inputSchema: z.object({ query: z.string() }),
          run: async ({ query }) => {
            executed.push('search_web');
            return JSON.stringify({ results: [`${query} #1`] });
          },
        },
        'read',
      ),
    ),
    betaZodTool(
      withEffect(
        {
          name: 'send_email',
          description: 'Send an email',
          inputSchema: z.object({ to: z.string() }),
          run: async ({ to }) => {
            executed.push('send_email');
            return `sent to ${to}`;
          },
        },
        'write',
      ),
    ),
  ];

  // The client reads ANTHROPIC_BASE_URL when it is constructed, inside the run.
  const agent = (system) => async () => {
    const client = new Anthropic({ apiKey: 'test-key', maxRetries: 0 });
    const params = { model: 'claude-opus-5', max_tokens: 512, system, messages: [{ role: 'user', content: 'Research and email the team.' }], tools: tools() };
    let final;
    if (stream) {
      // The runner yields each turn's message stream; it runs the tools once a stream has ended.
      for await (const turn of client.beta.messages.toolRunner({ ...params, stream: true })) {
        for await (const event of turn) void event;
        final = await turn.finalMessage();
      }
    } else {
      final = await client.beta.messages.toolRunner(params).runUntilDone(); // done() only waits; runUntilDone() drives the loop
    }
    return final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  };

  let recorded;
  it('records the runner: two model calls and both tools', async () => {
    recorded = await h.record(agent('You are helpful.'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.equal(recorded.value, 'Done.');
    assert.deepEqual(executed.sort(), ['search_web', 'send_email']);
    assert.equal(recorded.summary.byKind.api, 2);
    assert.deepEqual(toolTrace(recorded.calls).sort(), ['search_web:read:live:ok', 'send_email:write:live:ok']);
    assert.equal(mock.requests.length, 2);
    assert.ok(mock.requests.every((r) => (r.body.stream ?? false) === stream));
  });

  it('replays with zero upstream requests and no tool executions', async () => {
    executed.length = 0;
    const before = mock.requests.length;
    const replay = await h.replay(recorded, agent('You are helpful.'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.equal(replay.summary.divergence, null);
    assert.equal(replay.summary.byOrigin.replayed, replay.summary.total);
    assert.equal(mock.requests.length, before);
    assert.deepEqual(executed, []);
    assert.equal(replay.value, 'Done.');
  });

  it('forks on a changed system prompt and blocks the email', async () => {
    executed.length = 0;
    const fork = await h.replay(recorded, agent('You are terse.'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.equal(fork.summary.divergence?.callNo, 1);
    assert.deepEqual(executed, ['search_web']);
    assert.ok(toolTrace(fork.calls).includes('send_email:write:blocked:error'));
    // The runner sends the refusal back to the model as an error tool_result.
    const last = mock.requests.at(-1).body.messages.at(-1);
    const refusal = last.content.find((b) => b.type === 'tool_result' && b.is_error);
    assert.ok(refusal, JSON.stringify(last));
  });
});
