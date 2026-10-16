// An eval of the support agent: a model plays the customer, and the agent hands the policy check to
// a sub-agent. Each part runs in a scope of its own (customer, agent, agent/policy-checker), so a
// replay matches each one's calls apart and the dashboard can narrow a run to one of them.
//
//   node eval_conversation.mjs --persona damaged-order
import Anthropic from '@anthropic-ai/sdk';
import { scope, tool } from '@shadowlap/sdk';

const PERSONAS = {
  'damaged-order': 'You are a customer whose order A-1042 arrived damaged. You want the full $240 back today. Stay polite, but push.',
};
const AGENT = "You are a support agent for Northwind. Follow the refund policy. Look things up with the tools; never guess an order's state.";
const CHECKER = 'You check a refund against the regional policy and answer in one line.';

const client = new Anthropic({ apiKey: 'demo-key', maxRetries: 0 });
const textOf = (reply) => reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
const str = { type: 'string' };
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });

const lookupOrder = tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ({ order_id, amount: 240, status: 'delivered', damage: 'reported' }));
const lookupPolicy = tool('lookup_policy', { effect: 'pure' }, async ({ region }) => ({ region, refund_limit: 100, approval: 'tier2' }));
const escalate = tool('escalate', { effect: 'write', onFork: () => ({ ticket: null, suppressed: true }) }, async ({ ticket }) => ({ ticket: 'ESC-4410', for: ticket }));
const addNote = tool('add_note', { effect: 'write', onFork: () => ({ ok: true, stubbed: true }) }, async () => ({ ok: true }));

/** The sub-agent: one question about the policy, answered with its own tool. */
async function checkPolicy({ region, amount }) {
  return scope('policy-checker', async () => {
    const messages = [{ role: 'user', content: `Order A-1042, $${amount}, ${region}. Does the refund need approval?` }];
    for (let turn = 0; turn < 4; turn++) {
      const reply = await client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 256, system: CHECKER, tools: [{ name: 'lookup_policy', description: 'Look up the refund rules for a region.', input_schema: object({ region: str, amount: { type: 'number' } }) }], messages });
      messages.push({ role: 'assistant', content: reply.content });
      const uses = reply.content.filter((b) => b.type === 'tool_use');
      if (!uses.length) return { answer: textOf(reply) };
      messages.push({ role: 'user', content: await Promise.all(uses.map(async (u) => ({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await lookupPolicy(u.input)) }))) });
    }
    return { answer: 'no answer' };
  });
}

const run = { lookup_order: lookupOrder, check_policy: checkPolicy, escalate, add_note: addNote };
const agentTools = [
  { name: 'lookup_order', description: 'Look an order up.', input_schema: object({ order_id: str }) },
  { name: 'check_policy', description: 'Ask the policy checker whether a refund needs approval.', input_schema: object({ region: str, amount: { type: 'number' } }) },
  { name: 'escalate', description: 'Hand a ticket to a person.', input_schema: object({ ticket: str, reason: str }) },
  { name: 'add_note', description: 'Add a note to a ticket.', input_schema: object({ ticket: str, note: str }) },
];

/** The agent's turn: tools until it answers the customer. */
async function agentTurn(messages) {
  for (let step = 0; step < 8; step++) {
    const reply = await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 1024, system: AGENT, tools: agentTools, messages });
    messages.push({ role: 'assistant', content: reply.content });
    const uses = reply.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) return textOf(reply);
    messages.push({ role: 'user', content: await Promise.all(uses.map(async (u) => ({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await run[u.name](u.input)) }))) });
  }
  return '';
}

const persona = process.argv[process.argv.indexOf('--persona') + 1] ?? 'damaged-order';
const customer = [{ role: 'user', content: 'Start the conversation with the support agent.' }];
const agent = [];
for (let round = 0; round < 4; round++) {
  const said = await scope('customer', () => client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 256, system: PERSONAS[persona], messages: customer }));
  const line = textOf(said);
  console.log(`customer: ${line}`);
  customer.push({ role: 'assistant', content: said.content });
  if (round > 0 && /thank/i.test(line)) break;
  agent.push({ role: 'user', content: line });
  const answer = await scope('agent', () => agentTurn(agent));
  console.log(`agent: ${answer}`);
  customer.push({ role: 'user', content: answer });
}
