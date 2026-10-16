// Triages the support inbox: every unread thread gets a label, billing, bug or other.
//
//   node triage.mjs
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';

const listInbox = tool('list_inbox', { effect: 'read' }, async ({ folder }) => ({ folder, threads: [] }));
const labelThread = tool('label_thread', { effect: 'write' }, async ({ id, label }) => ({ ok: true, id, label }));
const run = { list_inbox: listInbox, label_thread: labelThread };

const client = new Anthropic({ apiKey: 'demo-key' });
const tools = [
  { name: 'list_inbox', description: 'List the unread threads in a folder.', input_schema: { type: 'object', properties: { folder: { type: 'string' } } } },
  { name: 'label_thread', description: 'Label a thread billing, bug or other.', input_schema: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } } },
];
const messages = [{ role: 'user', content: 'Triage the unread support threads.' }];
for (let turn = 0; turn < 8; turn++) {
  const reply = await client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 512, system: 'You triage the support inbox. Label every unread thread billing, bug or other.', tools, messages });
  messages.push({ role: 'assistant', content: reply.content });
  const uses = reply.content.filter((b) => b.type === 'tool_use');
  if (!uses.length) break;
  messages.push({ role: 'user', content: await Promise.all(uses.map(async (u) => ({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await run[u.name](u.input)) }))) });
}
