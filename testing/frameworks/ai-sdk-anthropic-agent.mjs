// A support agent on the Vercel AI SDK's Anthropic provider, as a user writes it: the model comes from
// @ai-sdk/anthropic with no options, so its base URL and key come from the environment, and the one
// tool is wrapped by withEffects. It prints what the model said and what the tool returned.
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { withEffects } from '../../packages/adapters/dist/ai-sdk.js';

const tools = withEffects(
  {
    lookup_order: tool({
      description: 'Look up an order',
      inputSchema: z.object({ order_id: z.string() }),
      execute: async ({ order_id }) => ({ order_id, amount: 240 }),
    }),
  },
  { lookup_order: 'read' },
);

const result = await generateText({ model: anthropic('claude-opus-5'), tools, prompt: process.env.TICKET ?? 'Refund order A-1042.', stopWhen: stepCountIs(4) });
const outputs = result.steps.flatMap((s) => s.content.filter((p) => p.type === 'tool-result').map((p) => p.output));
console.log(JSON.stringify({ text: result.text, outputs }));
