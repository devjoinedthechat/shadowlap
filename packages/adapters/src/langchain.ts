import { tool } from '@shadowlap/sdk';
import { toOptions, type EffectSpec } from './core.js';

/**
 * LangChain / LangGraph (`@langchain/core` tools): wraps the tool instance's `_call`, the step
 * after LangChain has validated the input against the schema and before it wraps the output in a
 * `ToolMessage`. So the recorded input is the parsed arguments (never LangGraph's ToolCall envelope
 * or its call id), the recorded output is what the tool function returned, and LangChain builds
 * the `ToolMessage` itself on replay exactly as it does live.
 *
 *   import { tool } from '@langchain/core/tools';
 *   import { withEffect } from '@shadowlap/adapters/langchain';
 *
 *   const searchWeb = withEffect(tool(search, { name: 'search_web', schema }), 'read');
 *   const node = new ToolNode([searchWeb]);
 *
 * Outputs must be JSON: strings, objects, or `[content, artifact]` for `responseFormat:
 * "content_and_artifact"`. A tool that returns a LangGraph `Command` or a message instance replays
 * it as a plain object.
 */

interface LangChainToolInternals {
  name: string;
  _call: (input: unknown, ...rest: unknown[]) => Promise<unknown>;
  /** The function a tool made with `tool()` or `DynamicStructuredTool` calls from its `_call`. */
  func?: (...args: never[]) => unknown;
}

export function withEffect<T extends { name: string }>(instance: T, spec: EffectSpec): T {
  const target = instance as unknown as LangChainToolInternals;
  if (typeof target._call !== 'function') {
    throw new TypeError(`withEffect: "${instance.name}" is not a LangChain tool (no _call); wrap the result of tool() or a StructuredTool instance`);
  }
  // Hashed by the person's function: `func` for tool() and DynamicStructuredTool, a subclass's own _call.
  const options = toOptions(spec, instance.name, typeof target.func === 'function' ? target.func : target._call);
  const original = target._call.bind(instance);
  target._call = (input: unknown, ...rest: unknown[]) => tool(instance.name, options, () => original(input, ...rest))(input);
  return instance;
}
