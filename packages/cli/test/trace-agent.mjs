// The agent behind the traces in fixtures/traces/otel-genai.json: a support agent on the Anthropic SDK
// that looks an order up and answers. Replaying it against the imported trace shows which of its
// calls the trace could serve. API_VERSION names another API version than this SDK's release does,
// as a later release of the SDKs names 2026-10-21.
//
// AGENT_SYSTEM replaces the system prompt, as a fix to it would.
//
//   [API_VERSION=2026-10-21] [AGENT_SYSTEM=…] node trace-agent.mjs ["question"]
import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@shadowlap/sdk';

const version = process.env.API_VERSION;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'test-key', maxRetries: 0, ...(version ? { defaultHeaders: { 'anthropic-version': version } } : {}) });
const lookupOrder = tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ({ order_id, amount: 240, status: 'delivered', source: 'ran live' }));
const tools = [{ name: 'lookup_order', description: 'Look an order up by its id.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } }];
const system = process.env.AGENT_SYSTEM || 'You are a support agent. Look the order up before you answer.';
const messages = [{ role: 'user', content: process.argv[2] ?? 'Where is my order A-1042?' }];

for (let turn = 0; turn < 5; turn++) {
  const res = await client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 512, temperature: 0, system, tools, messages });
  messages.push({ role: 'assistant', content: res.content });
  const uses = res.content.filter((b) => b.type === 'tool_use');
  if (!uses.length) {
    console.log(`answer: ${res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')}`);
    break;
  }
  const results = [];
  for (const use of uses) results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(await lookupOrder(use.input)) });
  messages.push({ role: 'user', content: results });
}
