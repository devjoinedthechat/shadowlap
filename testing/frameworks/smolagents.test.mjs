// smolagents in Python: a ToolCallingAgent on its OpenAI-compatible model, with smolagents' @tool over
// functions wrapped by shadowlap.tool. Model calls go through the sidecar (OPENAI_BASE_URL). See scripted-agent.mjs.
import assert from 'node:assert/strict';
import { scriptedAgentTests } from './scripted-agent.mjs';

scriptedAgentTests({
  name: 'smolagents',
  module: 'smolagents',
  script: './smolagents_agent.py',
  api: 'openai',
  refused: (value) => assert.ok(value.errors.some((e) => /blocked/.test(e)), JSON.stringify(value)),
});
