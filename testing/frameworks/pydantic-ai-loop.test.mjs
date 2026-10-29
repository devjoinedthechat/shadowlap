// Pydantic AI's own agent loop on a model named by string, Agent("openai:gpt-5"), which calls the
// Responses API through the OpenAI SDK's client, run by the real CLI. See python-loop.mjs.
import assert from 'node:assert/strict';
import { agentLoopTests } from './python-loop.mjs';

agentLoopTests({
  name: 'Pydantic AI on a model named by string (Agent("openai:gpt-5"), the Responses API)',
  module: 'pydantic_ai, openai',
  script: 'pydantic_ai_loop.py',
  client: 'OpenAIResponsesModel',
  tools: ['search_web', 'send_email'],
  // Pydantic AI hands the model the refusal as the tool's failed result.
  refused: (value) => assert.ok(value.results.some((r) => r.tool === 'send_email' && r.failed && /blocked/.test(r.result)), JSON.stringify(value.results)),
});
