// Handles a billing dispute: checks the invoice before crediting anything, then tells the customer.
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';

const run = {
  lookup_invoice: tool('lookup_invoice', { effect: 'read' }, async ({ number }) => ({ number, customer: 'Acme GmbH', total: '€1,240.00', charges: 2 })),
  create_credit_note: tool('create_credit_note', { effect: 'write' }, async ({ invoice }) => ({ credit_note: 'CN-3311', invoice })),
  email_customer: tool('email_customer', { effect: 'write' }, async ({ to }) => ({ sent: true, to })),
};
const tools = Object.keys(run).map((name) => ({ name, description: name.replace(/_/g, ' '), input_schema: { type: 'object', properties: {} } }));
const client = new Anthropic({ apiKey: 'demo-key' });
const messages = [{ role: 'user', content: 'Acme says INV-20931 was charged twice.' }];
for (let turn = 0; turn < 8; turn++) {
  const reply = await client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 512, system: 'You handle billing disputes for Acme. Check the invoice before you credit anything.', tools, messages });
  messages.push({ role: 'assistant', content: reply.content });
  const uses = reply.content.filter((b) => b.type === 'tool_use');
  if (!uses.length) break;
  messages.push({ role: 'user', content: await Promise.all(uses.map(async (u) => ({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await run[u.name](u.input)) }))) });
}
