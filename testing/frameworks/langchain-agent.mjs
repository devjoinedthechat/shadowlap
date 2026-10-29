// A support agent on LangChain / LangGraph, as a user writes it: a chat model class (ChatOpenAI or
// ChatAnthropic) with no base URL or key in its code, so both come from the environment, and two tools
// made by tool() from @langchain/core and wrapped by withEffect, in LangChain's agent loop: createAgent
// from langchain (LC_AGENT=create) or LangGraph's prebuilt createReactAgent (LC_AGENT=react). It runs
// the agent once (LC_RUN=stream to stream the model's tokens) and prints what the model said, what
// each tool returned and which tools ran.
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { withEffect } from '../../packages/adapters/dist/langchain.js';

const executed = [];
const lookupOrder = withEffect(
  tool(
    async ({ order_id }) => {
      executed.push('lookup_order');
      return JSON.stringify({ order_id, amount: 240 });
    },
    { name: 'lookup_order', description: 'Look up an order', schema: z.object({ order_id: z.string() }) },
  ),
  'read',
);
const refundOrder = withEffect(
  tool(
    async ({ order_id, amount }) => {
      executed.push('refund_order');
      return JSON.stringify({ refunded: true, order_id, amount });
    },
    { name: 'refund_order', description: 'Refund an order', schema: z.object({ order_id: z.string(), amount: z.number() }) },
  ),
  'write',
);

const model = process.env.LC_MODEL === 'anthropic' ? new ChatAnthropic({ model: 'claude-sonnet-5' }) : new ChatOpenAI({ model: 'gpt-5' });
const tools = [lookupOrder, refundOrder];
const prompt = 'You resolve refund requests.';
// createReactAgent is LangGraph's older entry point, which agents written before createAgent still use.
// eslint-disable-next-line @typescript-eslint/no-deprecated
const agent = process.env.LC_AGENT === 'react' ? createReactAgent({ llm: model, tools, prompt }) : createAgent({ model, tools, systemPrompt: prompt });
const input = { messages: [new HumanMessage(process.env.TICKET ?? 'Refund order A-1042.')] };

let state;
if (process.env.LC_RUN === 'stream') {
  for await (const [mode, chunk] of await agent.stream(input, { streamMode: ['messages', 'values'] })) if (mode === 'values') state = chunk;
} else {
  state = await agent.invoke(input);
}
const outputs = state.messages.filter((m) => m.type === 'tool').map((m) => ({ name: m.name, status: m.status, content: m.content }));
const last = state.messages.at(-1);
console.log(JSON.stringify({ text: typeof last.content === 'string' ? last.content : last.text, outputs, executed }));
