// Strands Agents in Python: an Agent on Strands' Anthropic model, with Strands' @tool over functions
// wrapped by shadowlap.tool. Model calls go through the sidecar (ANTHROPIC_BASE_URL). See scripted-agent.mjs.
import assert from 'node:assert/strict';
import { scriptedAgentTests } from './scripted-agent.mjs';

scriptedAgentTests({
  name: 'Strands Agents',
  module: 'strands',
  script: './strands_agent.py',
  api: 'anthropic',
  refused: (value) => assert.ok(value.results.some((r) => r.status === 'error' && /blocked/.test(r.content.join(' '))), JSON.stringify(value.results)),
});
