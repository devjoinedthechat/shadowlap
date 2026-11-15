// CrewAI's own agent loop: Crew.kickoff with an Agent on CrewAI's LLM, which builds its own OpenAI
// client (Chat Completions), run by the real CLI. See python-loop.mjs.
import assert from 'node:assert/strict';
import { agentLoopTests } from './python-loop.mjs';

agentLoopTests({
  name: "CrewAI's Crew.kickoff on CrewAI's LLM (its own OpenAI client, Chat Completions)",
  module: 'crewai',
  script: 'crewai_loop.py',
  client: 'OpenAICompletion',
  // CrewAI shows the model each tool under a name of its own making: "Search the web" is search_the_web.
  tools: ['search_the_web', 'send_email'],
  // CrewAI reports what it does to its own service unless told not to: a connection outside shadowlap.
  env: { CREWAI_DISABLE_TELEMETRY: 'true', CREWAI_DISABLE_TRACKING: 'true', CREWAI_TRACING_ENABLED: 'false', OTEL_SDK_DISABLED: 'true' },
  // CrewAI hands the model a tool's error as its result.
  refused: (value, read) => assert.match(JSON.stringify(read), /Error executing tool: write tool send_email blocked after divergence/),
});
