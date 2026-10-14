// Azure OpenAI through the OpenAI SDK's AzureOpenAI, with the endpoint passed in code: a completion,
// then a streamed one. Before in-process capture, shadowlap run's OPENAI_BASE_URL made this constructor throw.
import { AzureOpenAI } from 'openai';

const client = new AzureOpenAI({ endpoint: 'https://shadowlap-test.openai.azure.com', apiKey: 'test-key', apiVersion: '2024-10-21', deployment: 'gpt-4o-prod', maxRetries: 0 });
const one = await client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: process.env.PROMPT }] });
const stream = await client.chat.completions.create({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: `${process.env.PROMPT} (streamed)` }] });
let two = '';
for await (const chunk of stream) two += chunk.choices[0]?.delta?.content ?? '';
console.log(JSON.stringify({ texts: [one.choices[0].message.content, two] }));
