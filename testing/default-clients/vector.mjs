// An agent that reads a vector store declared under `http`, which embeds with the caller's OpenAI key
// sent with each request (as Weaviate's clients send X-OpenAI-Api-Key), then asks its model.
import OpenAI from 'openai';
import { answer } from './answer.mjs';

await answer(async (prompt) => {
  const found = await fetch(`${process.env.VECTOR_DB}/v1/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-api-key': process.env.OPENAI_API_KEY ?? '' }, body: JSON.stringify({ query: 'orders like A-1042' }) });
  const reply = await new OpenAI({ maxRetries: 0 }).chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: `${prompt} (${found.status})` }] });
  return reply.choices[0].message.content;
});
