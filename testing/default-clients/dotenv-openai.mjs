// An agent that loads its key from a .env file in its folder, the usual way, which keeps a variable
// the environment already has, then builds its client the default way.
import OpenAI from 'openai';
import { answer } from './answer.mjs';

process.loadEnvFile();
await answer(async (prompt) => {
  const reply = await new OpenAI({ maxRetries: 0 }).chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: prompt }] });
  return reply.choices[0].message.content;
});
