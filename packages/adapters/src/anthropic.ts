import { wrapFirstArg, type EffectSpec } from './core.js';

/**
 * Anthropic SDK tool runner (`betaZodTool` / `betaTool`): wrap the definition's `run`.
 *
 *   import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
 *   import { withEffect } from '@shadowlap/adapters/anthropic';
 *
 *   const searchWeb = betaZodTool(withEffect({ name: 'search_web', inputSchema, run }, 'read'));
 *   const runner = client.beta.messages.toolRunner({ tools: [searchWeb], ... });
 *
 * API calls made by the runner need nothing: the sidecar records them through ANTHROPIC_BASE_URL.
 */

interface AnthropicToolDefinition {
  name: string;
  run: (input: unknown, ...rest: unknown[]) => unknown;
}

export function withEffect<T extends AnthropicToolDefinition>(definition: T, spec: EffectSpec): T {
  return { ...definition, run: wrapFirstArg(definition.name, spec, definition.run) };
}
