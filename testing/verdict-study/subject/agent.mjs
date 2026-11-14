// The study's subject: a support agent that handles one refund request. It looks the order up, reads
// the refund policy, then refunds the order or hands it to a manager. Its prompt and its tools'
// definitions are files next to it, so a change to either is a change in the working tree.
//
//   node agent.mjs <order>
import { readFileSync } from 'node:fs';
import { tool } from '@shadowlap/sdk';
import { ORDERS, POLICY } from './shop.mjs';

const here = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const system = here('./prompt.txt').trim();
const tools = JSON.parse(here('./tools.json'));
const model = process.env.STUDY_MODEL ?? 'claude-haiku-4-5';

const impls = {
  lookup_order: tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ORDERS[order_id] ?? { error: `no order ${order_id}` }),
  read_policy: tool('read_policy', { effect: 'pure' }, async () => ({ text: POLICY })),
  issue_refund: tool('issue_refund', { effect: 'write', onFork: () => ({ refunded: true }) }, async (args) => ({ refunded: true, ...args })),
  escalate: tool('escalate', { effect: 'write', onFork: () => ({ ticket: 'T-1' }) }, async (args) => ({ ticket: 'T-1', ...args })),
};

const baseURL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One Messages request, sent again while the provider is busy, as its SDK would. */
async function create(request) {
  for (let retry = 0; ; retry++) {
    const res = await fetch(`${baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? 'none', 'anthropic-version': '2023-06-01', 'x-stainless-retry-count': String(retry) },
      body: JSON.stringify(request),
    });
    if (res.ok) return res.json();
    const busy = res.status === 429 || res.status === 529 || res.status >= 500;
    if (!busy || retry === 5) throw new Error(`${res.status} ${await res.text()}`);
    await wait(Number(res.headers.get('retry-after') ?? 0) * 1000 || 1000 * 2 ** retry);
  }
}

const messages = [{ role: 'user', content: `The customer asks for a refund on order ${process.argv[2] ?? 'A-1042'}.` }];
for (let turn = 0; turn < 8; turn++) {
  const reply = await create({ model, max_tokens: 300, system, tools, messages });
  messages.push({ role: 'assistant', content: reply.content });
  const uses = reply.content.filter((b) => b.type === 'tool_use');
  if (reply.stop_reason !== 'tool_use' || uses.length === 0) {
    console.log(reply.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    break;
  }
  const results = [];
  for (const use of uses) {
    const run = impls[use.name];
    results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(run ? await run(use.input) : { error: `no tool ${use.name}` }) });
  }
  messages.push({ role: 'user', content: results });
}
