// A support agent on Mastra, as a user writes it: an Agent named by a model router id
// ('openai/gpt-5', 'anthropic/claude-opus-5', 'google/gemini-2.5-flash'), with no base URL or key in
// its code, so both come from the environment, and two tools made by createTool over definitions
// wrapped by withEffect. As in Mastra's own template, the agent knows each tool by its key in `tools`
// (lookupOrder), not by its id (lookup-order). It runs the agent once (MASTRA_RUN=stream to stream),
// or a workflow whose steps are the tools (MASTRA_RUN=workflow), and prints what the model said, what
// each tool returned and which tools ran.
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { withEffect } from '../../packages/adapters/dist/mastra.js';

const executed = [];
const lookupOrder = createTool(
  withEffect(
    {
      id: 'lookup-order',
      description: 'Look up an order',
      inputSchema: z.object({ order_id: z.string() }),
      outputSchema: z.object({ order_id: z.string(), amount: z.number() }),
      execute: async ({ order_id }) => {
        executed.push('lookup-order');
        return { order_id, amount: 240 };
      },
    },
    'read',
  ),
);
const refundOrder = createTool(
  withEffect(
    {
      id: 'refund-order',
      description: 'Refund an order',
      inputSchema: z.object({ order_id: z.string(), amount: z.number() }),
      outputSchema: z.object({ refunded: z.boolean(), order_id: z.string(), amount: z.number() }),
      execute: async ({ order_id, amount }) => {
        executed.push('refund-order');
        return { refunded: true, order_id, amount };
      },
    },
    'write',
  ),
);

const ticket = process.env.TICKET ?? 'Refund order A-1042.';
const mode = process.env.MASTRA_RUN ?? 'generate';

if (mode === 'workflow') {
  const refund = createWorkflow({ id: 'refund', inputSchema: z.object({ order_id: z.string() }), outputSchema: z.object({ refunded: z.boolean(), order_id: z.string(), amount: z.number() }) })
    .then(createStep(lookupOrder))
    .then(createStep(refundOrder))
    .commit();
  const run = await refund.createRun();
  const result = await run.start({ inputData: { order_id: /A-\d+/.exec(ticket)?.[0] ?? 'A-1042' } });
  console.log(JSON.stringify({ status: result.status, result: result.result, executed }));
} else {
  const agent = new Agent({
    id: 'support',
    name: 'Support',
    instructions: 'You resolve refund requests.',
    model: process.env.MASTRA_MODEL ?? 'openai/gpt-5',
    tools: { lookupOrder, refundOrder },
  });
  const result = mode === 'stream' ? await agent.stream(ticket, { maxSteps: 4 }) : await agent.generate(ticket, { maxSteps: 4 });
  const text = await result.text;
  const outputs = (await result.steps).flatMap((s) => (s.toolResults ?? []).map((r) => r.payload?.result ?? r.result ?? r.output));
  console.log(JSON.stringify({ text, outputs, executed }));
}
