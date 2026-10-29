// A support agent on the Vercel AI SDK as its docs write one: the model named by a string
// ('openai/gpt-5'), which the AI SDK sends to Vercel's AI Gateway with the key in AI_GATEWAY_API_KEY,
// and two tools wrapped by withEffects (UNWRAPPED=1 leaves the refund unwrapped). STREAM=1 streams.
// It prints what the model said, what each tool returned and which tools ran.
import { generateText, stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import { withEffects } from '../../packages/adapters/dist/ai-sdk.js';

const executed = [];
const lookupOrder = tool({
  description: 'Look up an order',
  inputSchema: z.object({ order_id: z.string() }),
  execute: async ({ order_id }) => (executed.push('lookup_order'), { order_id, amount: 240 }),
});
const refundOrder = tool({
  description: 'Refund an order',
  inputSchema: z.object({ order_id: z.string(), amount: z.number() }),
  execute: async ({ order_id, amount }) => (executed.push('refund_order'), { refunded: true, order_id, amount }),
});
const tools = process.env.UNWRAPPED ? { ...withEffects({ lookup_order: lookupOrder }, { lookup_order: 'read' }), refund_order: refundOrder } : withEffects({ lookup_order: lookupOrder, refund_order: refundOrder }, { lookup_order: 'read', refund_order: 'write' });

const options = { model: process.env.MODEL ?? 'openai/gpt-5', tools, prompt: process.env.TICKET ?? 'Refund order A-1042.', stopWhen: stepCountIs(4) };
const result = process.env.STREAM ? streamText(options) : await generateText(options);
const text = await result.text;
const outputs = (await result.steps).flatMap((s) => s.content.filter((p) => p.type === 'tool-result' || p.type === 'tool-error').map((p) => (p.type === 'tool-result' ? p.output : { error: String(p.error) })));
console.log(JSON.stringify({ text, outputs, executed }));
