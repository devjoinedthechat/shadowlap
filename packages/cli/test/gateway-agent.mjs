// An agent on the OpenAI SDK whose base URL, set in code, is a gateway's: an OpenRouter-style host
// that serves OpenAI's API under /api/v1. No variable points it at shadowlap; in-process capture
// sends its calls there when the project's config declares the host.
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: 'sk-or-test', baseURL: 'https://openrouter.test/api/v1', maxRetries: 0 });
const stream = await client.chat.completions.create({ model: 'anthropic/claude-sonnet-4.5', messages: [{ role: 'user', content: 'Say hello.' }], stream: true, stream_options: { include_usage: true } });
let text = '';
for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
console.log(JSON.stringify({ text }));
