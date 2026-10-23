// Agno in Python: an Agent on Agno's Claude model, with functions wrapped by shadowlap.tool as its
// tools. Model calls go through the sidecar (ANTHROPIC_BASE_URL). See scripted-agent.mjs.
import assert from 'node:assert/strict';
import { scriptedAgentTests } from './scripted-agent.mjs';

scriptedAgentTests({
  name: 'Agno',
  module: 'agno',
  script: './agno_agent.py',
  api: 'anthropic',
  refused: (value) => assert.ok(value.results.some((r) => /blocked/.test(r.result)), JSON.stringify(value.results)),
});
