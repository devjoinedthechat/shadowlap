// Mastra 1.x: createTool({ id, inputSchema, execute(inputData, context) }) over a definition
// wrapped by withEffect, executed through the Tool instance Mastra builds (input validation included).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { withEffect } from '../../packages/adapters/dist/mastra.js';
import { startHarness, toolTrace } from './harness.mjs';

describe('Mastra (@mastra/core) with @shadowlap/adapters/mastra', () => {
  let h;
  const executed = [];
  before(async () => (h = await startHarness()));
  after(() => h.close());

  const searchWeb = createTool(
    withEffect(
      {
        id: 'search_web',
        description: 'Search the web',
        inputSchema: z.object({ query: z.string() }),
        execute: async (inputData, context) => {
          executed.push('search_web');
          assert.equal(typeof context, 'object'); // the execution context still reaches the implementation
          return { results: [`${inputData.query} #1`] };
        },
      },
      'read',
    ),
  );
  const sendEmail = createTool(
    withEffect(
      {
        id: 'send_email',
        description: 'Send an email',
        inputSchema: z.object({ to: z.string() }),
        execute: async (inputData) => {
          executed.push('send_email');
          return { sent: true, to: inputData.to };
        },
      },
      'write',
    ),
  );

  const agent = async (query) => {
    const context = { requestContext: new Map() };
    const search = await searchWeb.execute({ query }, context);
    let email;
    try {
      email = await sendEmail.execute({ to: 'team@example.com' }, context);
    } catch (err) {
      email = { error: err.name };
    }
    return { search, email };
  };

  let recorded;
  it('records tool calls made through Tool.execute', async () => {
    recorded = await h.record(() => agent('shadowlap'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.deepEqual(executed, ['search_web', 'send_email']);
    assert.deepEqual(recorded.value, { search: { results: ['shadowlap #1'] }, email: { sent: true, to: 'team@example.com' } });
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

  it('forks and blocks the email', async () => {
    executed.length = 0;
    const fork = await h.replay(recorded, () => agent('replay'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.deepEqual(executed, ['search_web']);
    assert.deepEqual(toolTrace(fork.calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
    assert.deepEqual(fork.value.email, { error: 'ShadowlapWriteBlocked' });
  });
});
