// The OpenAI Agents SDK for Python: Runner on an Agent given no model, so on the SDK's default model
// and its default OpenAI client (the Responses API), with tools, run by the real CLI. See python-loop.mjs.
import assert from 'node:assert/strict';
import { agentLoopTests } from './python-loop.mjs';

agentLoopTests({
  name: "OpenAI Agents SDK's Runner on its default model and client (the Responses API)",
  module: 'agents',
  script: 'openai_agents_loop.py',
  client: 'default',
  tools: ['search_web', 'send_email'],
  // The SDK exports traces to api.openai.com as the process exits: a connection outside shadowlap.
  env: { OPENAI_AGENTS_DISABLE_TRACING: '1' },
  // The SDK hands the model a tool's error as its output.
  refused: (value) => assert.ok(value.results.some((r) => r.tool === 'send_email' && /blocked/.test(r.result)), JSON.stringify(value.results)),
});
