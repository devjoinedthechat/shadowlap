/**
 * Framework adapters. Import the one for your framework:
 *
 *   @shadowlap/adapters/ai-sdk         withEffects(tools, effects)   Vercel AI SDK
 *   @shadowlap/adapters/openai-agents  withEffect(definition, effect) OpenAI Agents SDK
 *   @shadowlap/adapters/mastra         withEffect(definition, effect) Mastra
 *   @shadowlap/adapters/anthropic      withEffect(definition, effect) Anthropic tool runner
 *   @shadowlap/adapters/langchain      withEffect(instance, effect)   LangChain / LangGraph
 *   @shadowlap/adapters/claude-agent-sdk  withFence(options)        Claude Agent SDK built-in tools
 *
 * Each declares a tool's effect once and routes execution through `tool()` from `@shadowlap/sdk`.
 * API calls need no adapter: the sidecar records them through the provider base URL.
 */
export { toOptions, wrapFirstArg } from './core.js';
export type { EffectSpec } from './core.js';
export { withEffects as withAiSdkEffects } from './ai-sdk.js';
export { withEffect as withOpenAIAgentsEffect } from './openai-agents.js';
export { withEffect as withMastraEffect } from './mastra.js';
export { withEffect as withAnthropicEffect } from './anthropic.js';
export { withEffect as withLangChainEffect } from './langchain.js';
export { withFence as withClaudeAgentFence, fenceHooks as claudeAgentFenceHooks, withEffects as withClaudeAgentMcpEffects } from './claude-agent-sdk.js';
