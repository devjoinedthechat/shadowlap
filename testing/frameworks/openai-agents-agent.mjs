// A support agent on the OpenAI Agents SDK, as a user writes it: an Agent run by run() on the SDK's
// default provider (the Responses API, its base URL and key from OPENAI_BASE_URL and OPENAI_API_KEY),
// with two tools made by tool() over definitions wrapped by withEffect. The refund tool has no name
// of its own: the SDK names it from its function, `refund order`, as `refund_order`. It runs the agent
// once (AGENTS_RUN=stream to stream) and prints what the agent answered, what each tool returned and
// which tools ran.
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { withEffect } from '../../packages/adapters/dist/openai-agents.js';

const executed = [];
const lookupOrder = tool(
  withEffect(
    {
      name: 'lookup order',
      description: 'Look up an order',
      parameters: z.object({ order_id: z.string() }),
      execute: async ({ order_id }) => {
        executed.push('lookup_order');
        return { order_id, amount: 240 };
      },
    },
    'read',
  ),
);
const refundOrder = tool(
  withEffect(
    {
      description: 'Refund an order',
      parameters: z.object({ order_id: z.string(), amount: z.number() }),
      execute: async function refund_order({ order_id, amount }) {
        executed.push('refund_order');
        return { refunded: true, order_id, amount };
      },
    },
    'write',
  ),
);

const agent = new Agent({ name: 'Support', instructions: 'You resolve refund requests.', model: 'gpt-5', tools: [lookupOrder, refundOrder] });
const ticket = process.env.TICKET ?? 'Refund order A-1042.';
const result = process.env.AGENTS_RUN === 'stream' ? await run(agent, ticket, { stream: true, maxTurns: 5 }) : await run(agent, ticket, { maxTurns: 5 });
if (process.env.AGENTS_RUN === 'stream') {
  for await (const event of result.toTextStream()) void event;
  await result.completed;
}
const outputs = result.newItems.filter((i) => i.type === 'tool_call_output_item').map((i) => i.output);
const called = result.newItems.filter((i) => i.type === 'tool_call_item').map((i) => i.rawItem.name);
console.log(JSON.stringify({ text: result.finalOutput, outputs, called, executed }));
