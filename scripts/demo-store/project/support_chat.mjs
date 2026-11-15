// Northwind's support chat: it waits for the customer. What they type is read with readline, which
// `shadowlap run` records as user_input calls with no code change, so the chat replays, tests and
// blames with no one at the keyboard.
//
//   node support_chat.mjs
import * as readline from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';

const SYSTEM = "You are Northwind's support chat. Help customers with their orders. Look orders up; never guess.";

const tools = {
  lookup_order: tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ({ order_id, amount: 240, status: 'delivered', item: 'blender' })),
  create_replacement: tool('create_replacement', { effect: 'write', onFork: () => ({ ok: false, suppressed: true }) }, async ({ order_id }) => ({ ok: true, order_id, shipment: 'S-5531' })),
  issue_refund: tool('issue_refund', { effect: 'write', onFork: () => ({ refund_id: null, suppressed: true }) }, async ({ order_id, amount }) => ({ refund_id: 'R-5590', order_id, amount, status: 'issued' })),
};
const str = { type: 'string' };
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });
const definitions = [
  { name: 'lookup_order', description: 'Look an order up.', input_schema: object({ order_id: str }) },
  { name: 'create_replacement', description: 'Ship a replacement for an order.', input_schema: object({ order_id: str }) },
  { name: 'issue_refund', description: 'Refund an order.', input_schema: object({ order_id: str, amount: { type: 'number' } }) },
];

const client = new Anthropic({ apiKey: 'demo-key', maxRetries: 0 });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const messages = [];
let prompt = 'How can I help? ';
for (let turn = 0; turn < 6; turn++) {
  const line = (await rl.question(prompt)).trim();
  if (!line) break;
  messages.push({ role: 'user', content: line });
  for (let step = 0; step < 6; step++) {
    const reply = await client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 512, system: SYSTEM, tools: definitions, messages });
    messages.push({ role: 'assistant', content: reply.content });
    const uses = reply.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) {
      console.log(reply.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
      break;
    }
    const results = [];
    for (const use of uses) {
      try {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(await tools[use.name](use.input)) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: `${err.name}: ${err.message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  if (/\b(no,? thanks|bye)\b/i.test(line)) break;
  prompt = '> ';
}
rl.close();
