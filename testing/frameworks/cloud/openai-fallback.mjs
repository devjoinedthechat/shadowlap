// An agent that falls back to its own server when OPENAI_BASE_URL is unset, the usual way to point the
// OpenAI SDK at a local model. Capture must leave OPENAI_BASE_URL on the sidecar so the fallback never
// runs; the same process then builds an AzureOpenAI client with an endpoint, which must not throw.
import OpenAI, { AzureOpenAI } from 'openai';

const client = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL ?? `${process.env.FALLBACK_SERVER}/v1`, apiKey: 'local', maxRetries: 0 });
const azure = new AzureOpenAI({ endpoint: 'https://shadowlap-test.openai.azure.com', apiKey: 'test-key', apiVersion: '2024-10-21', deployment: 'gpt-4o-prod', maxRetries: 0 });
const one = await client.chat.completions.create({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: process.env.PROMPT }] });
const two = await azure.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: `${process.env.PROMPT} (azure)` }] });
console.log(JSON.stringify({ texts: [one.choices[0].message.content, two.choices[0].message.content] }));
