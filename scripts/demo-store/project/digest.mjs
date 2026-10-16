// Posts the weekly digest of refund tickets to a team channel, on Gemini.
//
//   node digest.mjs [--channel '#support-leads']
import { GoogleGenAI } from '@google/genai';
import { tool } from '@shadowlap/sdk';

const CHANNELS = new Set(['#support-leads']);
const TICKETS = {
  'T-8812': { order: 'A-1042', amount: 240, outcome: 'refunded', reason: 'damaged on arrival' },
  'T-8820': { order: 'A-1077', amount: 240, outcome: 'refunded', reason: 'never arrived' },
  'T-8830': { order: 'A-1131', amount: 45, outcome: 'refunded', reason: 'arrived late' },
};

const tools = {
  list_tickets: tool('list_tickets', { effect: 'read' }, async ({ tag }) => ({ tag, tickets: Object.keys(TICKETS) })),
  get_ticket: tool('get_ticket', { effect: 'read' }, async ({ ticket }) => ({ ticket, ...TICKETS[ticket] })),
  post_digest: tool('post_digest', { effect: 'write', onFork: () => ({ ok: false, suppressed: true }) }, async ({ channel }) => {
    if (!CHANNELS.has(channel)) throw new Error(`channel_not_found: ${channel}`);
    return { ok: true, channel, ts: '1727690000.000200' };
  }),
};
const declarations = [
  { name: 'list_tickets', description: 'List the tickets with a tag from the last week.', parametersJsonSchema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] } },
  { name: 'get_ticket', description: 'Read a ticket.', parametersJsonSchema: { type: 'object', properties: { ticket: { type: 'string' } }, required: ['ticket'] } },
  { name: 'post_digest', description: 'Post the digest to a channel.', parametersJsonSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } },
];

const channel = process.argv.includes('--channel') ? process.argv[process.argv.indexOf('--channel') + 1] : '#support-leads';
const ai = new GoogleGenAI({ apiKey: 'demo-key' });
const contents = [{ role: 'user', parts: [{ text: `Write this week's refund digest and post it to ${channel}.` }] }];
for (let turn = 0; turn < 8; turn++) {
  const reply = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents, config: { systemInstruction: 'You write short, factual digests for the support leads.', tools: [{ functionDeclarations: declarations }] } });
  const calls = reply.functionCalls ?? [];
  contents.push(reply.candidates[0].content);
  if (!calls.length) {
    console.log(reply.text);
    break;
  }
  // A tool that fails ends the run: this agent has no error handling yet.
  const parts = [];
  for (const c of calls) parts.push({ functionResponse: { name: c.name, response: await tools[c.name](c.args) } });
  contents.push({ role: 'user', parts });
}
