import { wrapFirstArg, type EffectSpec } from './core.js';

/**
 * OpenAI Agents SDK (`@openai/agents`): wrap the definition before handing it to `tool()`.
 *
 *   import { tool } from '@openai/agents';
 *   import { withEffect } from '@shadowlap/adapters/openai-agents';
 *
 *   const searchWeb = tool(withEffect({ name: 'search_web', parameters, execute }, 'read'));
 *
 * A call is recorded under the name the model calls the tool by, which `tool()` makes from `name`
 * (or, without one, from the name of the `execute` function) by turning every character but a letter
 * or a digit into `_`: `name: 'search web'` is `search_web` to the model and in the recording.
 */

interface OpenAIAgentsToolDefinition {
  name?: string;
  execute: (input: never, ...rest: never[]) => unknown;
}

/** The name `tool()` from @openai/agents gives the model for a definition. */
function functionToolName(definition: OpenAIAgentsToolDefinition): string {
  const name = (definition.name || definition.execute.name).replace(/[^a-zA-Z0-9]/g, '_');
  if (!name) throw new TypeError('withEffect: the tool has no name: give the definition a name, or make execute a named function');
  return name;
}

export function withEffect<T extends OpenAIAgentsToolDefinition>(definition: T, spec: EffectSpec): T & { name: string } {
  const name = functionToolName(definition);
  // The name goes with the definition: tool() can't take it from the wrapper, which has none.
  return { ...definition, name, execute: wrapFirstArg(name, spec, definition.execute as (input: unknown, ...rest: unknown[]) => unknown) };
}
