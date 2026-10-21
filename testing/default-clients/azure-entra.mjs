// An agent that signs in to Azure OpenAI with Microsoft Entra ID, as Microsoft recommends: a token
// provider instead of a key (here one that needs no network, standing in for
// getBearerTokenProvider(new DefaultAzureCredential(), scope)). The client refuses a key beside it.
import { AzureOpenAI } from 'openai';
import { answer } from './answer.mjs';

await answer(async (prompt) => {
  const azureADTokenProvider = async () => 'entra-token-of-the-developer';
  const reply = await new AzureOpenAI({ azureADTokenProvider, deployment: 'gpt-prod', maxRetries: 0 }).chat.completions.create({ model: 'gpt-prod', messages: [{ role: 'user', content: prompt }] });
  return reply.choices[0].message.content;
});
