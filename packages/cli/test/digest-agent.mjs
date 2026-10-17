// A digest agent whose runs turn on its tools rather than on what the model answers. It reads the
// week's refunds, then posts a digest to the channel given on the command line. Posting to a
// channel that doesn't exist fails, and so does reading the refunds while a file named
// refunds.down is in the working folder, as an outage would. The agent handles no tool error: one
// ends the run with exit code 1.
//
//   node digest-agent.mjs [--channel '#support-leads']
//
//   AGENT_OUTBOX=…  file post_digest appends to before it posts, so a test can see what really ran
import { appendFileSync, existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';

const CHANNELS = new Set(['#support-leads']);
const impls = {
  list_refunds: tool('list_refunds', { effect: 'read' }, async () => {
    if (existsSync('refunds.down')) throw new Error('refunds service unavailable');
    return { refunds: [{ order: 'A-1042', amount: 240 }, { order: 'A-1131', amount: 45 }] };
  }),
  post_digest: tool('post_digest', { effect: 'write', onFork: () => ({ ok: false, suppressed: true }) }, async ({ channel, text }) => {
    if (process.env.AGENT_OUTBOX) appendFileSync(process.env.AGENT_OUTBOX, JSON.stringify({ tool: 'post_digest', channel, text }) + '\n');
    if (!CHANNELS.has(channel)) throw new Error(`channel_not_found: ${channel}`);
    return { ok: true, channel };
  }),
};
const object = (properties) => ({ type: 'object', properties });
const tools = [
  { name: 'list_refunds', description: 'List the refunds of the last week.', input_schema: object({}) },
  { name: 'post_digest', description: 'Post the digest to a channel.', input_schema: object({ channel: { type: 'string' }, text: { type: 'string' } }) },
];

const channel = process.argv.includes('--channel') ? process.argv[process.argv.indexOf('--channel') + 1] : '#support-leads';
const client = new Anthropic({ apiKey: 'k', maxRetries: 0 });
const messages = [{ role: 'user', content: `Post this week's refund digest to ${channel}.` }];
for (let turn = 0; turn < 6; turn++) {
  const reply = await client.messages.create({ model: 'small-model', max_tokens: 256, system: 'You write short, factual digests for the support leads.', tools, messages });
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
