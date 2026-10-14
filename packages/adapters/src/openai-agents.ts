import { wrapFirstArg, type EffectSpec } from './core.js';

/**
 * OpenAI Agents SDK (`@openai/agents`): wrap the definition before handing it to `tool()`.
 *
 *   import { tool } from '@openai/agents';
 *   import { withEffect } from '@shadowlap/adapters/openai-agents';
 *
 *   const searchWeb = tool(withEffect({ name: 'search_web', parameters, execute }, 'read'));
 */

interface OpenAIAgentsToolDefinition {
  name: string;
  execute: (input: unknown, ...rest: unknown[]) => unknown;
}

export function withEffect<T extends OpenAIAgentsToolDefinition>(definition: T, spec: EffectSpec): T {
  return { ...definition, execute: wrapFirstArg(definition.name, spec, definition.execute) };
}
