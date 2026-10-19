// The refund agent docs/checks.md shows its samples with. It looks the order up, then refunds it or
// escalates it, as the model decides, and says it is done. lookup_order answers a total of 180 for
// order A-1042 and 40 for B-7, as the page's rules read it: "@lookup_order.result.total".
//
//   node agent.mjs <order>
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';

const impls = {
  lookup_order: tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ({ order_id, total: order_id === 'B-7' ? 40 : 180 })),
  issue_refund: tool('issue_refund', { effect: 'write', onFork: () => ({ refunded: false, suppressed: true }) }, async (args) => ({ refunded: true, ...args })),
  escalate: tool('escalate', { effect: 'write', onFork: () => ({ ticket: null, suppressed: true }) }, async (args) => ({ ticket: 'T-1', ...args })),
};
const object = (properties) => ({ type: 'object', properties });
const tools = [
  { name: 'lookup_order', description: 'Look an order up.', input_schema: object({ order_id: { type: 'string' } }) },
  { name: 'issue_refund', description: 'Refund an order.', input_schema: object({ order_id: { type: 'string' }, amount: { type: 'number' } }) },
  { name: 'escalate', description: 'Hand the case to a manager.', input_schema: object({ reason: { type: 'string' } }) },
];

const client = new Anthropic({ apiKey: 'k', maxRetries: 0 });
const order = process.argv[2] ?? 'A-1042';
const messages = [{ role: 'user', content: `The customer asks for a refund on order ${order}.` }];
for (let turn = 0; turn < 6; turn++) {
  const reply = await client.messages.create({ model: 'small-model', max_tokens: 256, system: 'You are a support agent. Refunds above $100 need a manager.', tools, messages });
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
