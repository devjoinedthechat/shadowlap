import { wrapFirstArg, type EffectSpec } from './core.js';

/**
 * Vercel AI SDK (`ai`): tools are a record keyed by name, each with `execute(input, options)`.
 *
 *   import { tool } from 'ai';
 *   import { withEffects } from '@shadowlap/adapters/ai-sdk';
 *
 *   const tools = withEffects(
 *     { search_web: tool({ inputSchema, execute }), send_email: tool({ inputSchema, execute }) },
 *     { search_web: 'read', send_email: { effect: 'write', onFork: () => ({ sent: false }) } },
 *   );
 *   await generateText({ model, tools, ... });
 */

interface AiSdkToolLike {
  execute?: (input: unknown, options: unknown) => unknown;
}

export function withEffects<T extends Record<string, AiSdkToolLike>>(tools: T, effects: { [K in keyof T]: EffectSpec }): T {
  const out: Record<string, AiSdkToolLike> = {};
  const missing: string[] = [];
  for (const [name, def] of Object.entries(tools)) {
    const spec = effects[name as keyof T];
    if (!def.execute) {
      out[name] = def; // a client-side tool: nothing to record here
      continue;
    }
    if (spec === undefined) {
      missing.push(name);
      continue;
    }
    out[name] = { ...def, execute: wrapFirstArg(name, spec, def.execute) };
  }
  if (missing.length) throw new TypeError(`withEffects: every tool needs an effect; missing for ${missing.join(', ')}`);
  return out as T;
}
