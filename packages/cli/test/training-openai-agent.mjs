// The same support agent on the OpenAI SDK (Chat Completions), for an OpenAI recording that an
// Anthropic model takes over.
//
//   node training-openai-agent.mjs [--stream]
//
//   --stream          read every answer as streamed chunks, with usage in the last one
//   AGENT_MODEL=…     the model to ask (default gpt-small)
//   AGENT_OUTBOX=…    file the write tools append to
import { appendFileSync } from 'node:fs';
import OpenAI from 'openai';
import { tool } from '@shadowlap/sdk';

const outbox = (entry) => process.env.AGENT_OUTBOX && appendFileSync(process.env.AGENT_OUTBOX, JSON.stringify(entry) + '\n');

const impls = {
  lookup_order: tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ({ order_id, amount: 240, status: 'delivered' })),
  read_policy: tool('read_policy', { effect: 'pure' }, async () => ({ text: 'Refunds above $100 need a manager: escalate them.' })),
  issue_refund: tool('issue_refund', { effect: 'write', onFork: () => ({ refunded: false, suppressed: true }) }, async (args) => {
    outbox({ tool: 'issue_refund', ...args });
    return { refunded: true, ...args };
  }),
  escalate: tool('escalate', { effect: 'write', onFork: () => ({ ticket: null, suppressed: true }) }, async (args) => {
    outbox({ tool: 'escalate', ...args });
    return { ticket: 'T-1', ...args };
  }),
};
const fn = (name, description, properties) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties } } });
const tools = [
  fn('lookup_order', 'Look an order up.', { order_id: { type: 'string' } }),
  fn('read_policy', 'Read the refund policy.', {}),
  fn('issue_refund', 'Refund an order.', { order_id: { type: 'string' }, amount: { type: 'number' } }),
  fn('escalate', 'Hand the case to a manager.', { reason: { type: 'string' } }),
];

const client = new OpenAI({ apiKey: 'k', maxRetries: 0 });
const stream = process.argv.includes('--stream');
const messages = [
  { role: 'system', content: 'You are a support agent. Follow the refund policy.' },
  { role: 'user', content: 'The customer asks for a refund on order A-1042.' },
];

async function ask() {
  const request = { model: process.env.AGENT_MODEL ?? 'gpt-small', messages, tools };
  if (!stream) {
    const r = await client.chat.completions.create(request);
    return { content: r.choices[0].message.content, calls: r.choices[0].message.tool_calls ?? [], finish: r.choices[0].finish_reason };
  }
  let content = '';
  let finish = null;
  const calls = new Map();
  for await (const chunk of await client.chat.completions.create({ ...request, stream: true, stream_options: { include_usage: true } })) {
    const choice = chunk.choices[0];
    if (!choice) continue;
    content += choice.delta.content ?? '';
    for (const tc of choice.delta.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
      calls.set(tc.index, cur);
    }
    finish = choice.finish_reason ?? finish;
  }
  return { content: content || null, calls: [...calls.values()], finish };
}

for (let turn = 0; turn < 10; turn++) {
  const reply = await ask();
  messages.push({ role: 'assistant', content: reply.content, ...(reply.calls.length ? { tool_calls: reply.calls } : {}) });
  if (!reply.calls.length) {
    console.log(reply.content ?? '');
    break;
  }
  for (const call of reply.calls) {
    const result = await impls[call.function.name](JSON.parse(call.function.arguments || '{}'));
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  }
}
