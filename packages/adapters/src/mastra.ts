import { tool } from '@shadowlap/sdk';
import { toOptions, wrapFirstArg, type EffectSpec } from './core.js';

/**
 * Mastra 1.x: `createTool({ id, inputSchema, execute: async (inputData, context) => ... })`. The
 * recorded input is `inputData`; the execution context (request context, tracing, agent and
 * workflow handles, abort signal) is passed through and not recorded.
 *
 *   import { createTool } from '@mastra/core/tools';
 *   import { withEffect } from '@shadowlap/adapters/mastra';
 *
 *   export const searchWeb = createTool(withEffect({ id: 'search_web', inputSchema, execute }, 'read'));
 *
 * An agent shows the model each tool under its key in `tools` (`tools: { searchWeb }` → `searchWeb`),
 * whatever its `id`, so a call an agent makes is recorded under that key, which its context's writer
 * carries; a call from anywhere else (a workflow step, your own code) under the `id`.
 *
 * Mastra 0.x called `execute({ context, runtimeContext, ... })`; use `withEffectV0` there.
 */

interface MastraToolDefinition {
  id: string;
  execute?: (inputData: never, ...rest: never[]) => unknown;
}

/** The name the model called the tool by: the agent's key for it, on the context of a call an agent made. */
function agentKey(context?: unknown): string | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  const { agent, writer } = context as { agent?: unknown; writer?: { name?: unknown } };
  if (typeof agent !== 'object' || agent === null) return undefined;
  return typeof writer?.name === 'string' && writer.name ? writer.name : undefined;
}

export function withEffect<T extends MastraToolDefinition>(definition: T, spec: EffectSpec): T {
  if (!definition.execute) return definition;
  const execute = wrapFirstArg(definition.id, spec, definition.execute as (inputData: unknown, ...rest: unknown[]) => unknown, agentKey);
  return { ...definition, execute };
}

interface MastraV0ToolDefinition {
  id: string;
  execute?: (params: { context: unknown } & Record<string, unknown>, ...rest: unknown[]) => unknown;
}

/** Mastra 0.x: the input is `params.context`; everything else on the params object passes through. */
export function withEffectV0<T extends MastraV0ToolDefinition>(definition: T, spec: EffectSpec): T {
  const original = definition.execute;
  if (!original) return definition;
  const options = toOptions(spec, definition.id, original);
  const execute: NonNullable<T['execute']> = ((params, ...rest) => tool(definition.id, options, (context: unknown) => original({ ...params, context }, ...rest))(params.context));
  return { ...definition, execute };
}
