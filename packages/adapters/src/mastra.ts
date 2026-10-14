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
 * Mastra 0.x called `execute({ context, runtimeContext, ... })`; use `withEffectV0` there.
 */

interface MastraToolDefinition {
  id: string;
  execute?: (inputData: never, ...rest: never[]) => unknown;
}

export function withEffect<T extends MastraToolDefinition>(definition: T, spec: EffectSpec): T {
  if (!definition.execute) return definition;
  const execute = wrapFirstArg(definition.id, spec, definition.execute as (inputData: unknown, ...rest: unknown[]) => unknown);
  return { ...definition, execute } as T;
}

interface MastraV0ToolDefinition {
  id: string;
  execute?: (params: { context: unknown } & Record<string, unknown>, ...rest: unknown[]) => unknown;
}

/** Mastra 0.x: the input is `params.context`; everything else on the params object passes through. */
export function withEffectV0<T extends MastraV0ToolDefinition>(definition: T, spec: EffectSpec): T {
  const original = definition.execute;
  if (!original) return definition;
  const options = toOptions(spec, definition.id);
  const execute: NonNullable<T['execute']> = ((params, ...rest) => tool(definition.id, options, (context: unknown) => original({ ...params, context }, ...rest))(params.context)) as NonNullable<T['execute']>;
  return { ...definition, execute };
}
