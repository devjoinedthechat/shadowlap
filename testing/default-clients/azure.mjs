// An agent that builds its Azure OpenAI client the default way, `new AzureOpenAI()`: its endpoint,
// API version and key come from AZURE_OPENAI_ENDPOINT, OPENAI_API_VERSION and AZURE_OPENAI_API_KEY.
import { AzureOpenAI } from 'openai';
import { answer } from './answer.mjs';

await answer(async (prompt) => {
  const reply = await new AzureOpenAI({ deployment: 'gpt-prod', maxRetries: 0 }).chat.completions.create({ model: 'gpt-prod', messages: [{ role: 'user', content: prompt }] });
  return reply.choices[0].message.content;
});
