// An agent that sets environment variables of its own, one of them already set, as npm and npx do
// as they start: in-process capture must leave process.env working as it does without shadowlap.
import Anthropic from '@anthropic-ai/sdk';

process.env.HOME = process.env.HOME ?? '';
process.env.AGENT_STAGE = 'start';
process.env.AGENT_STAGE = 'ask';
const client = new Anthropic({ apiKey: 'k', maxRetries: 0 });
const reply = await client.messages.create({ model: 'claude-opus-5', max_tokens: 32, messages: [{ role: 'user', content: `stage ${process.env.AGENT_STAGE}` }] });
console.log(reply.content[0].text);
