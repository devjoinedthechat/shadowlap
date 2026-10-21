// An agent that builds its client the default way, `new OpenAI()`: its key, like its base URL, comes
// from the environment.
import OpenAI from 'openai';
import { answer } from './answer.mjs';

await answer(async (prompt) => {
  const reply = await new OpenAI({ maxRetries: 0 }).chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: prompt }] });
  return reply.choices[0].message.content;
});
