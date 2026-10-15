// An overnight batch: one support agent works through several tickets in one process, each its own
// conversation, as a nightly job does. Each ticket is fetched before the model is asked about it;
// the model looks the order up, then answers. EXTERNAL=<url> also reaches a host no tool wraps, as
// an integration nobody wrapped would.
//
//   node batch-agent.mjs [tickets]
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';

const client = new Anthropic({ apiKey: 'k', maxRetries: 0 });
const getTicket = tool('get_ticket', { effect: 'read' }, async ({ ticket }) => ({ ticket, order: `A-${2000 + Number(ticket.slice(2))}` }));
const lookupOrder = tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ({ order_id, amount: 240, status: 'delivered' }));
const tools = [{ name: 'lookup_order', description: 'Look an order up.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } } } }];
const system = [{ type: 'text', text: 'You are a support agent. Follow the refund policy.', cache_control: { type: 'ephemeral' } }];

const tickets = Number(process.argv[2] ?? 8);
for (let t = 1; t <= tickets; t++) {
  const { order } = await getTicket({ ticket: `T-${t}` });
  const messages = [{ role: 'user', content: `Ticket T-${t}: order ${order} arrived damaged.` }];
  for (let turn = 0; turn < 4; turn++) {
    const reply = await client.messages.stream({ model: 'small-model', max_tokens: 256, system, tools, messages }).finalMessage();
    messages.push({ role: 'assistant', content: reply.content });
    const uses = reply.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) break;
    const results = [];
    for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await lookupOrder(u.input)) });
    messages.push({ role: 'user', content: results });
  }
}
if (process.env.EXTERNAL) await fetch(process.env.EXTERNAL).then((r) => r.text()).catch(() => '');
console.log(`worked ${tickets} tickets`);
