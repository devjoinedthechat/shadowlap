// Claude on Vertex AI through Anthropic's Vertex client, region in code: a message, then a streamed one.
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

const authClient = { projectId: 'shadowlap-test', getRequestHeaders: async () => new Headers({ Authorization: 'Bearer test-token' }) };
const client = new AnthropicVertex({ region: 'us-east5', projectId: 'shadowlap-test', authClient, maxRetries: 0 });
const model = 'claude-sonnet-4@20250514';
const one = await client.messages.create({ model, max_tokens: 64, messages: [{ role: 'user', content: process.env.PROMPT }] });
const two = await client.messages.stream({ model, max_tokens: 64, messages: [{ role: 'user', content: `${process.env.PROMPT} (streamed)` }] }).finalMessage();
console.log(JSON.stringify({ texts: [one.content[0].text, two.content[0].text] }));
