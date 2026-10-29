// LangChain / LangGraph: tool() from @langchain/core wrapped by withEffect, run by LangGraph's
// prebuilt ToolNode from an AIMessage with tool calls, the way a ReAct graph runs it. The results
// must come back as real ToolMessage instances on replay too. And a tool that updates the graph's
// state with a Command, or answers with a ToolMessage of its own, in a compiled StateGraph: a replay
// must leave the graph in the state the recording did, without running the tool.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Annotation, Command, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
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

describe('LangGraph state updates from a tool (Command) with @shadowlap/adapters/langchain', () => {
  let h;
  const executed = [];
  before(async () => (h = await startHarness()));
  after(() => h.close());

  // A refund tool that updates the graph's state and sends it on to an audit node, as LangGraph's
  // docs have a tool do it; and a receipt tool that answers with its own ToolMessage and artifact.
  const issueRefund = withEffect(
    tool(
      async ({ order_id }, config) => {
        executed.push('issue_refund');
        return new Command({
          update: { refunded: [order_id], messages: [new ToolMessage({ content: `refunded ${order_id}`, tool_call_id: config.toolCall.id, name: 'issue_refund' })] },
          goto: 'audit',
        });
      },
      { name: 'issue_refund', description: 'Refund an order', schema: z.object({ order_id: z.string() }) },
    ),
    'write',
  );
  const receipt = withEffect(
    tool(
      async ({ order_id }, config) => {
        executed.push('receipt');
        return new ToolMessage({ content: `receipt for ${order_id}`, artifact: { pdf: `${order_id}.pdf` }, tool_call_id: config.toolCall.id, name: 'receipt' });
      },
      { name: 'receipt', description: 'Get a receipt', schema: z.object({ order_id: z.string() }) },
    ),
    'read',
  );
  const State = Annotation.Root({
    ...MessagesAnnotation.spec,
    refunded: Annotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
    audited: Annotation({ reducer: (_, b) => b, default: () => false }),
  });
  const graph = new StateGraph(State)
    .addNode('tools', new ToolNode([issueRefund, receipt]), { ends: ['audit'] })
    .addNode('audit', (state) => ({ audited: state.refunded.length > 0 }))
    .addEdge(START, 'tools')
    .addEdge('audit', END)
    .compile();
  const agent = (orderId) =>
    graph.invoke({
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [
            { name: 'receipt', args: { order_id: orderId }, id: 'call_1', type: 'tool_call' },
            { name: 'issue_refund', args: { order_id: orderId }, id: 'call_2', type: 'tool_call' },
          ],
        }),
      ],
    });
  /** The state a run ends in: the tool messages as LangChain classes, and the state the Command set. */
  const shape = (state) => ({
    refunded: state.refunded,
    audited: state.audited,
    tools: state.messages.filter((m) => ToolMessage.isInstance(m)).map((m) => ({ name: m.name, id: m.tool_call_id, content: m.content, artifact: m.artifact })),
  });
  const expected = {
    refunded: ['A-1042'],
    audited: true,
    tools: [
      { name: 'receipt', id: 'call_1', content: 'receipt for A-1042', artifact: { pdf: 'A-1042.pdf' } },
      { name: 'issue_refund', id: 'call_2', content: 'refunded A-1042', artifact: undefined },
    ],
  };

  let recorded;
  it('records a Command and a ToolMessage, and the graph takes them as the tools returned them', async () => {
    recorded = await h.record(() => agent('A-1042'));
    assert.equal(recorded.error, undefined, recorded.error?.stack);
    assert.deepEqual(executed, ['receipt', 'issue_refund']);
    assert.deepEqual(shape(recorded.value), expected);
    assert.deepEqual(toolTrace(recorded.calls), ['receipt:read:live:ok', 'issue_refund:write:live:ok']);
  });

  it('replays the Command as a Command: the state update and the goto happen again, with no tool run', async () => {
    executed.length = 0;
    const replay = await h.replay(recorded, () => agent('A-1042'));
    assert.equal(replay.error, undefined, replay.error?.stack);
    assert.deepEqual(executed, []);
    assert.equal(replay.summary.divergence, null);
    assert.deepEqual(shape(replay.value), expected);
  });
});
