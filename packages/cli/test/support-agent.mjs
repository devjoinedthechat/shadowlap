// A support agent with one decision that matters. It looks the order up, reads the refund policy,
// then either issues the refund or escalates it; policy says a refund above $100 needs a manager.
// Everything after the decision follows from it, so a run that refunds was lost at the model call
// that chose to, not at the end where it visibly went wrong.
//
//   node support-agent.mjs [order] [--simulated-user]
//
//   order              A-1042 ($240, the default) or B-7 ($40, within policy). An argument, not a
//                      variable: a replay re-runs the recorded command in today's environment, so
//                      what makes a run that run goes in argv.
//   --simulated-user   a model plays the customer and writes the opening message, in scope "user";
//                      the agent's own model calls are in scope "agent", as in a benchmark harness
//
//   AGENT_MODEL=…     the model to ask (default small-model)
//   AGENT_SYSTEM=…    replaces the system prompt
//   AGENT_OUTBOX=…    file the write tools append to, so a test can see what really executed
//   AGENT_BASE_URL=…  a base URL fixed in the client, as a local model server often is: its calls
//                     reach Shadowlap only if Shadowlap is told that host is a model server
import { appendFileSync } from 'node:fs';
import { scope, tool } from '@shadowlap/sdk';

const outbox = (entry) => process.env.AGENT_OUTBOX && appendFileSync(process.env.AGENT_OUTBOX, JSON.stringify(entry) + '\n');

const impls = {
  lookup_order: tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ({ order_id, amount: order_id === 'B-7' ? 40 : 240, status: 'delivered' })),
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

// The Messages API with fetch, as the Anthropic SDK sends it with its retries off: the retry count
// tells Shadowlap that no request is the retry of one that failed. Loading the SDK took 40% of the agent's
// CPU, and blame, verify and repair start the agent once for every attempt.
const baseURL = (process.env.AGENT_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const client = {
  messages: {
    async create(request) {
      const res = await fetch(`${baseURL}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'x-stainless-retry-count': '0' },
        body: JSON.stringify(request),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return res.json();
    },
  },
};
const simulated = process.argv.includes('--simulated-user');
const order = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'A-1042';
let opening = `The customer asks for a refund on order ${order}.`;
if (simulated) {
  const customer = await scope('user', () =>
    client.messages.create({ model: 'user-model', max_tokens: 64, system: 'You play a customer who wants a refund.', messages: [{ role: 'user', content: `Your order: ${order}` }] }),
  );
  opening = customer.content.filter((b) => b.type === 'text').map((b) => b.text).join('') || opening;
}
const messages = [{ role: 'user', content: opening }];
const ask = (request) => (simulated ? scope('agent', () => client.messages.create(request)) : client.messages.create(request));
for (let turn = 0; turn < 10; turn++) {
  const reply = await ask({
    model: process.env.AGENT_MODEL ?? 'small-model',
    max_tokens: 256,
    system: process.env.AGENT_SYSTEM ?? 'You are a support agent. Follow the refund policy.',
    tools,
    messages,
  });
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
