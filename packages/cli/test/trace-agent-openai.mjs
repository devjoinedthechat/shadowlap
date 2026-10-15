// The agent behind fixtures/traces/otel-openinference.json: a refunds agent on the OpenAI SDK, traced
// with OpenInference (Arize Phoenix), that looks an order up and answers. Replaying it against the
// imported trace shows that a call the instrumentation logged whole replays exactly.
//
//   node trace-agent-openai.mjs ["question"]
import OpenAI from 'openai';
import { tool } from '@shadowlap/sdk';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? 'test-key', maxRetries: 0 });
const lookupOrder = tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ({ order_id, amount: 40, status: 'delivered', source: 'ran live' }));
const tools = [{ type: 'function', function: { name: 'lookup_order', description: 'Look an order up by its id.', parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } } }];
const messages = [
  { role: 'system', content: 'You are a refunds agent. Look an order up before you refund it.' },
  { role: 'user', content: process.argv[2] ?? 'Refund order B-7, please.' },
];

for (let turn = 0; turn < 5; turn++) {
  const res = await client.chat.completions.create({ model: 'gpt-4.1-mini', messages, tools, temperature: 0 });
  const message = res.choices[0].message;
  if (!message.tool_calls?.length) {
    console.log(`answer: ${message.content}`);
    break;
  }
  messages.push({ role: 'assistant', content: message.content, tool_calls: message.tool_calls });
  for (const call of message.tool_calls) {
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(await lookupOrder(JSON.parse(call.function.arguments))) });
  }
}
