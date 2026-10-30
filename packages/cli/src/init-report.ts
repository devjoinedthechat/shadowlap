import type { Effect } from '@shadowlap/engine';

/**
 * What `shadowlap init` finds in a project (inspectProject in init.ts): its languages, model SDKs,
 * agent frameworks and tools, the command that starts the agent, and what would keep a call from
 * being recorded.
 */

export type Language = 'typescript' | 'javascript' | 'python';

export interface Provider {
  id: 'anthropic' | 'openai' | 'gemini' | 'azure' | 'vertex' | 'bedrock' | 'ai-gateway';
  /** The package it was found through. */
  via: string;
}

export interface Framework {
  id: 'ai-sdk' | 'openai-agents' | 'mastra' | 'langchain' | 'anthropic-tool-runner' | 'claude-agent-sdk' | 'pydantic-ai' | 'openai-agents-python' | 'langchain-python' | 'crewai' | 'claude-agent-sdk-python' | 'google-adk' | 'llamaindex' | 'agent-framework' | 'strands' | 'smolagents' | 'agno';
  name: string;
  package: string;
  version: string | null;
  /** The @shadowlap/adapters entry point, for TypeScript frameworks that have one. */
  adapter: string | null;
}

export interface FoundTool {
  name: string;
  file: string;
  line: number;
  /** How it is defined: a framework id, or "shadowlap" for tools already wrapped with the SDK. */
  via: string;
  /** The effect it already declares, if any. */
  effect: Effect | null;
  suggested: Effect;
  why: string;
  /** The framework's decorator as written, where it matters to wrapping: `@agent.tool_plain` (Pydantic AI), `@strands_tool` (Strands). */
  decorator?: string;
  /** The class of a tool defined as one (a LangChain or CrewAI `BaseTool`), whose instance is what gets wrapped: `with_effect(SendEmail(), "write")`. */
  className?: string;
}

/**
 * A Claude Agent SDK the project uses, and where a query of its runs through Shadowlap's fence. Its
 * built-in tools (Bash, Write, Edit and the rest) run inside Claude Code, where no wrapper reaches
 * them: the fence (`withFence`, `with_fence`) records them through the SDK's hooks.
 */
export interface Fence {
  framework: 'claude-agent-sdk' | 'claude-agent-sdk-python';
  /** The language of the code that fences a query, as `wrap` gives it. */
  language: Language;
  /** Where a query runs through the fence, or through its hooks by hand (`fenceHooks`, `fence_hooks`); null when none does. */
  at: { file: string; line: number } | null;
}

export interface BaseUrlWarning {
  file: string;
  line: number;
  url: string;
  /** The client it configures, when the code around it says: anthropic, openai or gemini. */
  client: 'anthropic' | 'openai' | 'gemini' | null;
}

/**
 * A model a framework names and sends to a host Shadowlap doesn't record: `groq/llama-3.3-70b` through
 * Mastra's router, `openrouter/…` through LiteLLM, smolagents' InferenceClientModel (Hugging Face).
 */
export interface UnrecordedModel {
  file: string;
  line: number;
  model: string;
  /** The framework that builds its client: its router, model string or model class. */
  via: Framework['id'];
}

export interface InitReport {
  cwd: string;
  languages: Language[];
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'uv' | 'poetry' | 'pip' | null;
  providers: Provider[];
  frameworks: Framework[];
  /** The command that starts the agent, when one can be read from the project. */
  command: { argv: string[]; from: string } | null;
  tools: FoundTool[];
  /** Each Claude Agent SDK the project uses, and whether its query runs through the fence; empty without one. */
  fence: Fence[];
  /** Model clients whose base URL is a literal: their calls bypass Shadowlap. */
  hardcodedBaseUrls: BaseUrlWarning[];
  /** Models named through a framework's router whose calls go where Shadowlap neither redirects nor captures. */
  unrecordedModels: UnrecordedModel[];
  /** A local or OpenAI-compatible server the project already points at. */
  modelServer: { url: string; upstream: string; from: string } | null;
  scannedFiles: number;
  config: { path: string; existed: boolean };
}
