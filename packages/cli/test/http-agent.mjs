// A retrieval agent that calls its services directly, with no wrapped tools: it queries a search
// service, asks the model about the hits, and posts the answer to a webhook.
import Anthropic from '@anthropic-ai/sdk';

const query = process.env.QUERY ?? 'refund policy';
const search = await fetch(`${process.env.SEARCH_URL}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, top_k: 2 }) });
const { hits } = await search.json();
const client = new Anthropic({ apiKey: 'k', maxRetries: 0 });
const reply = await client.messages.create({ model: 'claude-opus-5', max_tokens: 32, messages: [{ role: 'user', content: `${query}: ${hits.map((h) => h.text).join('; ')}` }] });
const notify = await fetch(`${process.env.WEBHOOK_URL}/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: reply.content[0].text }) });
console.log(JSON.stringify({ hits: hits.length, answer: reply.content[0].text, notify: notify.status }));
