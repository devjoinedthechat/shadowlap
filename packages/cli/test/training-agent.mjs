// The support agent of the training tests: it looks the order up, reads the refund policy, then
// either refunds or escalates; policy says a refund above $100 needs a manager. On the Anthropic SDK.
//
//   node training-agent.mjs [--stream] [--list-models] [--embed] [--count-tokens]
//
//   --stream          read every answer as a stream (the SDK's own event parser), not as one JSON
//   --list-models     list the models first (GET /v1/models), as an agent that checks what it may use
//   --embed           embed the question first (OpenAI's /v1/embeddings), as a retrieval agent does
//   --count-tokens    count the conversation's tokens before every message (/v1/messages/count_tokens)
//   AGENT_MODEL=…     the model to ask (default small-model)
//   AGENT_OUTBOX=…    file the write tools append to, so a test can see what really executed
import { appendFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
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
const object = (properties) => ({ type: 'object', properties });
const tools = [
  { name: 'lookup_order', description: 'Look an order up.', input_schema: object({ order_id: { type: 'string' } }) },
  { name: 'read_policy', description: 'Read the refund policy.', input_schema: object({}) },
  { name: 'issue_refund', description: 'Refund an order.', input_schema: object({ order_id: { type: 'string' }, amount: { type: 'number' } }) },
  { name: 'escalate', description: 'Hand the case to a manager.', input_schema: object({ reason: { type: 'string' } }) },
];

const client = new Anthropic({ apiKey: 'k', maxRetries: 0 });
const stream = process.argv.includes('--stream');
const messages = [{ role: 'user', content: 'The customer asks for a refund on order A-1042.' }];
if (process.argv.includes('--list-models')) await client.models.list();
if (process.argv.includes('--embed')) await new OpenAI({ apiKey: 'k', maxRetries: 0 }).embeddings.create({ model: 'text-embedding-3-small', input: messages[0].content });
for (let turn = 0; turn < 10; turn++) {
  const request = { model: process.env.AGENT_MODEL ?? 'small-model', max_tokens: 256, system: 'You are a support agent. Follow the refund policy.', tools, messages };
  if (process.argv.includes('--count-tokens')) await client.messages.countTokens({ model: request.model, system: request.system, tools, messages });
  const reply = stream ? await client.messages.stream(request).finalMessage() : await client.messages.create(request);
  messages.push({ role: 'assistant', content: reply.content });
  const uses = reply.content.filter((b) => b.type === 'tool_use');
  if (reply.stop_reason !== 'tool_use' || uses.length === 0) {
    console.log(reply.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    break;
  }
  const results = [];
  for (const use of uses) results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(await impls[use.name](use.input)) });
  messages.push({ role: 'user', content: results });
}
