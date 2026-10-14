// LangChain / LangGraph: tool() from @langchain/core wrapped by withEffect, run by LangGraph's
// prebuilt ToolNode from an AIMessage with tool calls, the way a ReAct graph runs it. The results
// must come back as real ToolMessage instances on replay too.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { withEffect } from '../../packages/adapters/dist/langchain.js';
import { startHarness, toolTrace } from './harness.mjs';

describe('LangChain / LangGraph (@langchain/core, @langchain/langgraph) with @shadowlap/adapters/langchain', () => {
  let h;
  const executed = [];
  before(async () => (h = await startHarness()));
  after(() => h.close());

  const searchWeb = withEffect(
    tool(
      async ({ query }) => {
        executed.push('search_web');
        return JSON.stringify({ results: [`${query} #1`] });
      },
      { name: 'search_web', description: 'Search the web', schema: z.object({ query: z.string() }) },
    ),
    'read',
  );
  const sendEmail = withEffect(
    tool(
      async ({ to }) => {
        executed.push('send_email');
        return `sent to ${to}`;
      },
      { name: 'send_email', description: 'Send an email', schema: z.object({ to: z.string() }) },
    ),
    'write',
  );

  // Two turns, as a ReAct graph runs them: search, then email once the results are back.
  const agent = async (query) => {
    const node = new ToolNode([searchWeb, sendEmail]);
    const turn1 = await node.invoke({ messages: [new AIMessage({ content: '', tool_calls: [{ name: 'search_web', args: { query }, id: 'call_1', type: 'tool_call' }] })] });
    const turn2 = await node.invoke({ messages: [new AIMessage({ content: '', tool_calls: [{ name: 'send_email', args: { to: 'team@example.com' }, id: 'call_2', type: 'tool_call' }] })] });
    return [...turn1.messages, ...turn2.messages];
  };
  const shape = (messages) => messages.map((m) => ({ instance: m instanceof ToolMessage || ToolMessage.isInstance?.(m) === true, name: m.name, id: m.tool_call_id, status: m.status ?? 'success', content: m.content }));

  let recorded;
  it('records tool calls made by ToolNode', async () => {
    recorded = await h.record(() => agent('shadowlap'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.deepEqual(executed, ['search_web', 'send_email']);
    assert.deepEqual(shape(recorded.value), [
      { instance: true, name: 'search_web', id: 'call_1', status: 'success', content: '{"results":["shadowlap #1"]}' },
      { instance: true, name: 'send_email', id: 'call_2', status: 'success', content: 'sent to team@example.com' },
    ]);
    assert.deepEqual(toolTrace(recorded.calls), ['search_web:read:live:ok', 'send_email:write:live:ok']);
    // The recorded input is the tool's arguments, not LangGraph's ToolCall envelope.
    assert.deepEqual(h.store.getJson(recorded.calls.find((c) => c.name === 'search_web').requestRef), { args: { query: 'shadowlap' } });
  });

  it('replays without executing and still returns ToolMessage instances', async () => {
    executed.length = 0;
    const replay = await h.replay(recorded, () => agent('shadowlap'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.deepEqual(executed, []);
    assert.equal(replay.summary.divergence, null);
    assert.deepEqual(shape(replay.value), shape(recorded.value));
  });

  it('forks and blocks the email; ToolNode reports it as an error ToolMessage', async () => {
    executed.length = 0;
    const fork = await h.replay(recorded, () => agent('replay'));
    assert.equal(fork.error, undefined, fork.error?.stack);
    assert.deepEqual(executed, ['search_web']);
    assert.deepEqual(toolTrace(fork.calls), ['search_web:read:live:ok', 'send_email:write:blocked:error']);
    const email = shape(fork.value).find((m) => m.name === 'send_email');
    assert.equal(email.instance, true);
    assert.equal(email.status, 'error');
    assert.match(String(email.content), /blocked/);
  });
});
