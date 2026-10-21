// An agent that builds its client the default way, `new Anthropic()`: its key, like its base URL,
// comes from the environment (or, with none there, from a profile the developer signed in with).
import Anthropic from '@anthropic-ai/sdk';
import { answer } from './answer.mjs';

await answer(async (prompt) => {
  const reply = await new Anthropic({ maxRetries: 0 }).messages.create({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: prompt }] });
  return reply.content[0].text;
});
