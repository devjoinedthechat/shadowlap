// The refund agent the support team started with: it looks an order up, reads the refund policy,
// then refunds or escalates, and emails the customer. What makes a run that run (the order) is an
// argument, so a replay re-runs it as it was.
//
//   node agent.mjs <order>
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';

const SYSTEM = 'You are a support agent. Follow the refund policy.';

const ORDERS = { 'A-1042': 240, 'A-1077': 240, 'A-1103': 240, 'A-1120': 60, 'A-1131': 45, 'A-1150': 80 };

const tools = {
  lookup_order: tool('lookup_order', { effect: 'read' }, async ({ order_id }) => {
    if (!(order_id in ORDERS)) throw new Error(`no order ${order_id}`);
    return { order_id, amount: ORDERS[order_id], currency: 'USD', status: 'delivered' };
  }),
  get_policy: tool('get_policy', { effect: 'pure' }, async () => ({ policy: 'refunds-v3', limit: 100, rule: 'Refunds above the limit need a manager.' })),
  issue_refund: tool('issue_refund', { effect: 'write', onFork: () => ({ refund_id: null, suppressed: true }) }, async ({ order_id, amount }) => ({ refund_id: `R-${5400 + Number(amount)}`, order_id, status: 'issued' })),
  escalate: tool('escalate', { effect: 'write', onFork: () => ({ ticket: null, suppressed: true }) }, async ({ reason }) => ({ ticket: 'ESC-4410', reason, status: 'queued' })),
  send_email: tool('send_email', { effect: 'write', onFork: () => ({ sent: false, suppressed: true }) }, async ({ to }) => ({ sent: true, to })),
};

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const definitions = [
  { name: 'lookup_order', description: 'Look an order up.', input_schema: object({ order_id: { type: 'string' } }) },
  { name: 'get_policy', description: 'Read the refund policy.', input_schema: object({ topic: { type: 'string' } }) },
  { name: 'issue_refund', description: 'Refund an order in full.', input_schema: object({ order_id: { type: 'string' }, amount: { type: 'number' } }) },
  { name: 'escalate', description: 'Hand the case to a manager.', input_schema: object({ reason: { type: 'string' } }) },
  { name: 'send_email', description: 'Email the customer.', input_schema: object({ to: { type: 'string' }, subject: { type: 'string' } }) },
];

const client = new Anthropic({ apiKey: 'demo-key', maxRetries: 0 });
const order = process.argv[2] ?? 'A-1042';
const messages = [{ role: 'user', content: `Order ${order}: the customer asks for a refund.` }];

for (let turn = 0; turn < 12; turn++) {
  const reply = await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 1024, system: SYSTEM, tools: definitions, messages });
  messages.push({ role: 'assistant', content: reply.content });
  const uses = reply.content.filter((b) => b.type === 'tool_use');
  if (reply.stop_reason !== 'tool_use' || uses.length === 0) {
    console.log(reply.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    break;
  }
  const results = [];
  for (const use of uses) {
    const run = tools[use.name];
    // A tool this agent doesn't have is a bug in the agent, not an answer for the model: it crashes.
    if (!run) throw new Error(`the model asked for ${use.name}, which this agent doesn't have`);
    try {
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(await run(use.input)) });
    } catch (err) {
      results.push({ type: 'tool_result', tool_use_id: use.id, content: `${err.name}: ${err.message}`, is_error: true });
    }
  }
  messages.push({ role: 'user', content: results });
}
