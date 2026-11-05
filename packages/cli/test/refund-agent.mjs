// A small agent for `migrate`'s tests: it reads what it needs, then writes. A refund over the limit
// goes to a person, which is only known from the policy, so a model that skips that read and carries
// on shows what a step asked in the recorded run's state can't: the mock plays it (migrate-evidence.test.ts).
//
//   node refund-agent.mjs [refund|lookup]
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';
import { readFileSync } from 'node:fs';

const task = process.argv[2] ?? 'refund';
const { model } = JSON.parse(readFileSync('agent.config.json', 'utf8'));
const tools = {
  lookup_order: tool('lookup_order', { effect: 'read' }, async () => ({ order: 'A1', amount: 240, found: 'ORDER' })),
  lookup_policy: tool('lookup_policy', { effect: 'read' }, async () => ({ rule: 'refunds over 100 go to a person', found: 'POLICY' })),
  lookup_customer: tool('lookup_customer', { effect: 'read' }, async () => ({ since: 2021, found: 'CUSTOMER' })),
  issue_refund: tool('issue_refund', { effect: 'write' }, async () => ({ refunded: true })),
  escalate: tool('escalate', { effect: 'write' }, async () => ({ escalated: true })),
};
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'mock' });
const definitions = Object.keys(tools).map((name) => ({ name, description: name, input_schema: { type: 'object', properties: {} } }));
const messages = [{ role: 'user', content: task === 'lookup' ? 'Look up order A1.' : 'Refund order A1.' }];
for (let turn = 0; turn < 8; turn++) {
  const answer = await client.messages.create({ model, max_tokens: 1024, tools: definitions, messages });
  messages.push({ role: 'assistant', content: answer.content });
  const uses = answer.content.filter((b) => b.type === 'tool_use');
  if (!uses.length) {
    console.log(answer.content.map((b) => b.text).join(''));
    break;
  }
  const results = [];
  for (const use of uses) results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(await tools[use.name](use.input)) });
  messages.push({ role: 'user', content: results });
}
