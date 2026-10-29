// LangGraph in Python on a real chat model: LangChain's create_agent, which runs LangGraph's ToolNode,
// on ChatOpenAI, run by the real CLI. See python-loop.mjs.
import assert from 'node:assert/strict';
import { agentLoopTests } from './python-loop.mjs';

agentLoopTests({
  name: "LangChain's create_agent (LangGraph's ToolNode) on ChatOpenAI",
  module: 'langchain.agents, langchain_openai, langgraph',
  script: 'langgraph_loop.py',
  client: 'ChatOpenAI',
  tools: ['search_web', 'send_email'],
  // ToolNode hands the model the refusal as an error ToolMessage.
  refused: (value) => assert.ok(value.results.some((r) => r.tool === 'send_email' && r.status === 'error' && /blocked/.test(r.result)), JSON.stringify(value.results)),
});
