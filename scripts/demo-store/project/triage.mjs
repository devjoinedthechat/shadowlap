// Triages the support inbox on OpenAI: every unread thread gets a label, billing, bug or other.
//
//   node triage.mjs [--folder support]
import OpenAI from 'openai';
import { tool } from '@shadowlap/sdk';

const THREADS = {
  support: [
    { id: 'th_812', subject: 'Refund not received' },
    { id: 'th_813', subject: 'Login loop on iOS' },
    { id: 'th_814', subject: 'Invoice copy, please' },
  ],
};

const tools = {
  list_inbox: tool('list_inbox', { effect: 'read' }, async ({ folder }) => ({ folder, threads: THREADS[folder] ?? [] })),
  label_thread: tool('label_thread', { effect: 'write', onFork: () => ({ ok: false, suppressed: true }) }, async ({ id, label }) => ({ ok: true, id, label })),
};
const fn = (name, description, properties) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required: Object.keys(properties) } } });
const definitions = [
  fn('list_inbox', 'List the unread threads in a folder.', { folder: { type: 'string' } }),
  fn('label_thread', 'Label a thread billing, bug or other.', { id: { type: 'string' }, label: { type: 'string', enum: ['billing', 'bug', 'other'] } }),
];

const folder = process.argv.includes('--folder') ? process.argv[process.argv.indexOf('--folder') + 1] : 'support';
const client = new OpenAI({ apiKey: 'demo-key', maxRetries: 0 });
const messages = [
  { role: 'system', content: 'You triage the support inbox. Label every unread thread billing, bug or other.' },
  { role: 'user', content: `Triage the unread threads in ${String(folder)}.` },
];
for (let turn = 0; turn < 8; turn++) {
  const reply = await client.chat.completions.create({ model: 'gpt-5-mini', messages, tools: definitions });
  const m = reply.choices[0].message;
  messages.push(m);
  if (!m.tool_calls?.length) {
    console.log(m.content);
    break;
  }
  // Every call of a turn at once, as most OpenAI agents run them.
  const results = await Promise.all(m.tool_calls.map(async (c) => ({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(await tools[c.function.name](JSON.parse(c.function.arguments))) })));
  messages.push(...results);
}
