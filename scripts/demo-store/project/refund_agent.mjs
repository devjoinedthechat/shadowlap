// Northwind's ticket agent. For each support ticket it reads the ticket, looks up the order, the
// customer, fraud risk, the refund policy, shipping and the regional limit, then refunds or
// escalates and emails the customer in their language. When the model can't be reached it leaves a
// note and hands the ticket to a person.
//
//   node refund_agent.mjs <ticket>                one ticket
//   node refund_agent.mjs --batch <file.jsonl>    every ticket in the file, one conversation each
//
//   AGENT_PAUSE_MS=…   wait this long before every model call (a slow upstream, for demos)
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { now, tool, uuid } from '@shadowlap/sdk';

const SYSTEM = "You are a support agent for Northwind. Follow the refund policy. Look things up with the tools; never guess an order's state.";

const TICKETS = {
  'T-8812': { customer: 'C-311', order: 'A-1042', amount: 240, reason: 'damaged on arrival', tier: 'gold', locale: 'de-DE' },
  'T-8813': { customer: 'C-312', order: 'A-1044', amount: 120, reason: 'wrong size', tier: 'silver', locale: 'fr-FR' },
  'T-8830': { customer: 'C-318', order: 'A-1131', amount: 45, reason: 'arrived late', tier: 'silver', locale: 'en-GB' },
};
let inbox = {};
const ticketOf = (id) => TICKETS[id] ?? inbox[id] ?? null;
const byOrder = (order) => Object.values({ ...TICKETS, ...inbox }).find((t) => t.order === order) ?? null;
const byCustomer = (customer) => Object.values({ ...TICKETS, ...inbox }).find((t) => t.customer === customer) ?? null;

const SUBJECTS = {
  'refund-issued': { 'de-DE': 'Ihre Erstattung ist unterwegs', 'fr-FR': 'Votre remboursement est en route', 'en-GB': 'Your refund is on its way' },
  'refund-escalated': { 'de-DE': 'Ihre Erstattung wird geprüft', 'fr-FR': 'Votre remboursement est en cours de vérification', 'en-GB': 'Your refund is being reviewed' },
};

const tools = {
  get_ticket: tool('get_ticket', { effect: 'read' }, async ({ ticket }) => {
    const t = ticketOf(ticket);
    if (!t) throw new Error(`no ticket ${ticket}`);
    return { ticket, customer: t.customer, order: t.order, reason: t.reason };
  }),
  lookup_order: tool('lookup_order', { effect: 'read' }, async ({ order_id }) => {
    const t = byOrder(order_id);
    if (!t) throw new Error(`no order ${order_id}`);
    return { order_id, amount: t.amount, currency: 'USD', status: 'delivered', delivered: '2026-09-27' };
  }),
  lookup_customer: tool('lookup_customer', { effect: 'read' }, async ({ customer }) => {
    const t = byCustomer(customer);
    return { customer, tier: t?.tier ?? 'standard', refunds_90d: 1, email: `${customer.toLowerCase()}@example.com` };
  }),
  check_fraud: tool('check_fraud', { effect: 'read' }, async ({ order_id }) => ({ order_id, risk: 'low' })),
  get_policy: tool('get_policy', { effect: 'pure' }, async ({ topic }) => ({ policy: 'refunds-v4', topic, rule: 'refunds above the regional limit need tier-2 approval' })),
  get_shipping: tool('get_shipping', { effect: 'read' }, async () => ({ carrier: 'DHL', damage_claim: 'filed' })),
  lookup_policy: tool('lookup_policy', { effect: 'pure' }, async ({ region }) => ({ region, approval: 'tier2' })),
  issue_refund: tool('issue_refund', { effect: 'write', onFork: () => ({ refund_id: null, suppressed: true }) }, async ({ order_id, amount }) => ({ refund_id: 'R-5521', order_id, amount, status: 'issued' })),
  escalate: tool('escalate', { effect: 'write', onFork: () => ({ ticket: 'ESC-0', stubbed: true }) }, async ({ ticket }) => ({ ticket: 'ESC-4410', for: ticket, status: 'queued' })),
  queue_status: tool('queue_status', { effect: 'read' }, async ({ team }) => ({ team, open: 4, sla_hours: 24 })),
  get_sla: tool('get_sla', { effect: 'read' }, async ({ tier }) => ({ tier, first_response_hours: tier === 'gold' ? 4 : 12 })),
  get_order_history: tool('get_order_history', { effect: 'read' }, async ({ customer }) => ({ customer, orders: 7, refunds: 1, last_refund: '2026-07-02' })),
  get_template: tool('get_template', { effect: 'read' }, async ({ name }) => ({ name, subject: SUBJECTS[name]?.['en-GB'] ?? name, body: 'Hi {name}, about your order {order}…' })),
  lookup_locale: tool('lookup_locale', { effect: 'read' }, async ({ customer }) => ({ customer, locale: byCustomer(customer)?.locale ?? 'en-GB' })),
  get_translation: tool('get_translation', { effect: 'read' }, async ({ template, locale }) => ({ template, locale, subject: SUBJECTS[template]?.[locale] ?? SUBJECTS[template]?.['en-GB'] ?? template })),
  render_email: tool('render_email', { effect: 'pure' }, async ({ template, locale }) => ({ html: `<p>${SUBJECTS[template]?.[locale] ?? template}</p>` })),
  send_email: tool('send_email', { effect: 'write', onFork: () => ({ sent: false, suppressed: true }) }, async ({ to }) => ({ sent: true, to })),
  add_note: tool('add_note', { effect: 'write', onFork: () => ({ ok: true, stubbed: true }) }, async () => ({ ok: true })),
};

const str = { type: 'string' };
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });
const definitions = [
  ['get_ticket', 'Read a support ticket.', { ticket: str }],
  ['lookup_order', 'Look an order up.', { order_id: str }],
  ['lookup_customer', 'Look a customer up.', { customer: str }],
  ['check_fraud', 'Check an order for fraud risk.', { order_id: str }],
  ['get_policy', 'Read a policy.', { topic: str }],
  ['get_shipping', 'Read how an order was shipped.', { order_id: str }],
  ['lookup_policy', "Look up the refund rules for a region and amount.", { region: str, amount: { type: 'number' } }],
  ['issue_refund', 'Refund an order.', { order_id: str, amount: { type: 'number' } }],
  ['escalate', 'Hand a ticket to a person.', { ticket: str, reason: str }],
  ['queue_status', "Read a team's queue.", { team: str }],
  ['get_sla', 'Read the response time a tier is promised.', { tier: str }],
  ['get_order_history', "Read a customer's past orders and refunds.", { customer: str }],
  ['get_template', 'Read an email template.', { name: str }],
  ['lookup_locale', "Read a customer's language.", { customer: str }],
  ['get_translation', "Translate a template's subject.", { template: str, locale: str }],
  ['render_email', 'Render an email.', { template: str, locale: str }],
  ['send_email', 'Email a customer.', { to: str, subject: str }],
  ['add_note', 'Add a note to a ticket.', { ticket: str, note: str }],
].map(([name, description, properties]) => ({ name, description, input_schema: object(properties) }));

const client = new Anthropic({ apiKey: 'demo-key' });
const pause = Number(process.env.AGENT_PAUSE_MS) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(ticket) {
  await now('ticket opened');
  const requestId = await uuid('request');
  const messages = [{ role: 'user', content: `New ticket ${ticket} (request ${requestId}). Handle it end to end.` }];
  try {
    for (let turn = 0; turn < 30; turn++) {
      if (pause) await sleep(pause);
      const reply = await client.messages
        .stream({ model: 'claude-sonnet-5', max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 }, system: SYSTEM, tools: definitions, messages })
        .finalMessage();
      messages.push({ role: 'assistant', content: reply.content });
      const uses = reply.content.filter((b) => b.type === 'tool_use');
      if (reply.stop_reason !== 'tool_use' || uses.length === 0) {
        console.log(`${ticket}: ${reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('')}`);
        return;
      }
      // Tools asked for together run together; their results go back in one message.
      const results = await Promise.all(
        uses.map(async (use) => {
          try {
            return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(await tools[use.name](use.input)) };
          } catch (err) {
            return { type: 'tool_result', tool_use_id: use.id, content: `${err.name}: ${err.message}`, is_error: true };
          }
        }),
      );
      messages.push({ role: 'user', content: results });
    }
  } catch (err) {
    if (!(err instanceof Anthropic.APIError)) throw err;
    // The model is unreachable: a person takes the ticket, with a note saying why.
    const why = `Model unavailable (${err.status ?? 'no response'}).`;
    await tools.add_note({ ticket, note: `${why} Escalated for a person to answer.` });
    await tools.escalate({ ticket, reason: 'model unavailable' });
    console.log(`${ticket}: ${why} Escalated to a person.`);
  }
}

const batch = process.argv.indexOf('--batch');
if (batch >= 0) {
  const lines = readFileSync(process.argv[batch + 1], 'utf8').split('\n').filter((l) => l.trim());
  const tickets = lines.map((l) => JSON.parse(l));
  inbox = Object.fromEntries(tickets.map((t) => [t.ticket, t]));
  for (const t of tickets) await handle(t.ticket);
} else {
  await handle(process.argv[2] ?? 'T-8812');
}
