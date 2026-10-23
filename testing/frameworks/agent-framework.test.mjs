// Microsoft Agent Framework in Python: an Agent on its Chat Completions client, with functions wrapped by
// shadowlap.tool as its tools. Model calls go through the sidecar (OPENAI_BASE_URL). See scripted-agent.mjs.
import assert from 'node:assert/strict';
import { scriptedAgentTests } from './scripted-agent.mjs';

scriptedAgentTests({
  name: 'Microsoft Agent Framework',
  module: 'agent_framework.openai',
  script: './agent_framework_agent.py',
  api: 'openai',
  // Agent Framework hands its model a failed function without the exception's details, unless asked to.
  refused: (value) => assert.ok(value.results.some((r) => /^Error: Function failed/.test(r.result)), JSON.stringify(value.results)),
});
