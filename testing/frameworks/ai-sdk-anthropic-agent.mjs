// A support agent on the Vercel AI SDK's Anthropic provider, as a user writes it: the model comes from
// @ai-sdk/anthropic with no options, so its base URL and key come from the environment, and two tools
// are wrapped by withEffects, a read and a write. It runs generateText, or streamText with
// AI_RUN=stream, and prints what the model said, what each tool returned (or the error it ended in)
// and which tools ran.
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import { withEffects } from '../../packages/adapters/dist/ai-sdk.js';

const executed = [];
const tools = withEffects(
  {
    lookup_order: tool({
      description: 'Look up an order',
      inputSchema: z.object({ order_id: z.string() }),
      execute: async ({ order_id }) => {
        executed.push('lookup_order');
        return { order_id, amount: 240 };
      },
    }),
    refund_order: tool({
      description: 'Refund an order',
      inputSchema: z.object({ order_id: z.string(), amount: z.number() }),
      execute: async ({ order_id, amount }) => {
        executed.push('refund_order');
        return { refunded: true, order_id, amount };
      },
    }),
  },
  { lookup_order: 'read', refund_order: 'write' },
);

const options = { model: anthropic('claude-opus-5'), tools, prompt: process.env.TICKET ?? 'Refund order A-1042.', stopWhen: stepCountIs(4) };
let text;
let steps;
if (process.env.AI_RUN === 'stream') {
  const result = streamText(options);
  for await (const delta of result.textStream) void delta;
  [text, steps] = await Promise.all([result.text, result.steps]);
} else {
  ({ text, steps } = await generateText(options));
}
const outputs = steps.flatMap((s) => s.content.filter((p) => p.type === 'tool-result' || p.type === 'tool-error').map((p) => (p.type === 'tool-result' ? p.output : { error: String(p.error) })));
console.log(JSON.stringify({ text, outputs, executed }));
