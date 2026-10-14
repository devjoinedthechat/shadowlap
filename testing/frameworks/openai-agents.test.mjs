// The OpenAI Agents SDK: tool() from @openai/agents over a definition wrapped by withEffect, invoked
// the way the runner invokes it (JSON arguments string, RunContext, tool call details), so the
// SDK's own parsing, validation and error handling are in the path.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { RunContext, tool } from '@openai/agents';
import { z } from 'zod';
import { withEffect } from '../../packages/adapters/dist/openai-agents.js';
import { startHarness, toolTrace } from './harness.mjs';

describe('OpenAI Agents SDK (@openai/agents) with @shadowlap/adapters/openai-agents', () => {
  let h;
  const executed = [];
  before(async () => (h = await startHarness()));
  after(() => h.close());

  const searchWeb = tool(
    withEffect(
      {
        name: 'search_web',
        description: 'Search the web',
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }, runContext) => {
          executed.push('search_web');
          assert.ok(runContext instanceof RunContext); // the run context still reaches the implementation
          return JSON.stringify({ results: [`${query} #1`] });
        },
      },
      'read',
    ),
  );
  const sendEmail = tool(
    withEffect(
      {
        name: 'send_email',
        description: 'Send an email',
        parameters: z.object({ to: z.string() }),
        execute: async ({ to }) => {
          executed.push('send_email');
          return `sent to ${to}`;
        },
      },
      'write',
    ),
  );

  const agent = async (query) => {
    const ctx = new RunContext({});
    const search = await searchWeb.invoke(ctx, JSON.stringify({ query }), { toolCall: { type: 'function_call', callId: 'call_1', name: 'search_web', arguments: JSON.stringify({ query }) } });
    const email = await sendEmail.invoke(ctx, JSON.stringify({ to: 'team@example.com' }), { toolCall: { type: 'function_call', callId: 'call_2', name: 'send_email', arguments: '{"to":"team@example.com"}' } });
    return { search, email };
  };

  let recorded;
  it('records tool calls made through FunctionTool.invoke', async () => {
    recorded = await h.record(() => agent('shadowlap'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.deepEqual(executed, ['search_web', 'send_email']);
    assert.deepEqual(recorded.value, { search: '{"results":["shadowlap #1"]}', email: 'sent to team@example.com' });
    assert.deepEqual(toolTrace(recorded.calls), ['search_web:read:live:ok', 'send_email:write:live:ok']);
    assert.deepEqual(h.store.getJson(recorded.calls[0].requestRef), { args: { query: 'shadowlap' } });
  });

  it('replays without executing', async () => {
    executed.length = 0;
    const replay = await h.replay(recorded, () => agent('shadowlap'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.deepEqual(executed, []);
    assert.equal(replay.summary.divergence, null);
    assert.deepEqual(replay.value, recorded.value);
  });

  it('forks and blocks the email; the SDK turns the refusal into a message for the model', async () => {
    executed.length = 0;
    const fork = await h.replay(recorded, () => agent('replay'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.deepEqual(executed, ['search_web']);
    assert.deepEqual(toolTrace(fork.calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
    assert.equal(typeof fork.value.email, 'string');
    assert.match(fork.value.email, /error/i);
  });
});
