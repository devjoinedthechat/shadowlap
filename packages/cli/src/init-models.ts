import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Framework, type InitReport, type Provider } from './init-report.js';
import { callArguments, inCommentAt, kwarg, lineOf, literal, positional, pyCalls, pyImports, readUtf8, rel, type PyImports } from './init-source.js';

/**
 * The models `shadowlap init` finds a project naming, and where their calls go: a framework's model
 * string or class, its router's provider prefix, an OpenAI-compatible server the project points at.
 * Calls to a host Shadowlap neither redirects nor captures are named, so nothing goes unrecorded
 * without a word.
 */

/**
 * The providers of Mastra's model router whose calls Shadowlap records, by the router's name for them:
 * it builds their clients with the base URL in ANTHROPIC_BASE_URL and OPENAI_BASE_URL, and Google's
 * host is captured in the process. Any other (`groq/…`, `openrouter/…`) goes to a host of its own.
 */
const MASTRA_ROUTED: Readonly<Record<string, Provider['id']>> = { anthropic: 'anthropic', openai: 'openai', google: 'gemini', vercel: 'ai-gateway' };

/**
 * Models a Mastra agent names by router id, `model: 'anthropic/claude-sonnet-4-5'` (or behind a
 * fallback, `process.env.MODEL ?? 'openai/gpt-5'`), in a file that imports Mastra: the router builds
 * the model client, so no provider SDK is a dependency.
 */
/**
 * Models an AI SDK agent names by a string (`model: 'openai/gpt-5'`) in a file that imports the AI SDK
 * and not Mastra, whose router reads such strings itself: the AI SDK sends them to Vercel's AI Gateway.
 */
function scanGatewayModels(text: string, file: string): Array<{ file: string; line: number; model: string }> {
  if (file.endsWith('.py') || text.includes('@mastra/core') || !/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]ai['"]/.test(text)) return [];
  const out: Array<{ file: string; line: number; model: string }> = [];
  for (const m of text.matchAll(/\bmodel\s*:\s*(?:[^'"`\n,}]*?(?:\?\?|\|\|)\s*)?['"`]([a-z][a-z0-9-]*)\/([^'"`\s]+)['"`]/g)) {
    const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
    if (/\/\/|^\s*\*|^\s*\/\*/.test(text.slice(lineStart, m.index))) continue;
    const model = `${m[1]!}/${m[2]!}`;
    if (!out.some((x) => x.model === model)) out.push({ file, line: lineOf(text, m.index), model });
  }
  return out;
}

function scanRouterModels(text: string, file: string): Array<{ file: string; line: number; model: string; provider: Provider['id'] | null }> {
  if (file.endsWith('.py') || !text.includes('@mastra/core')) return [];
  const out: Array<{ file: string; line: number; model: string; provider: Provider['id'] | null }> = [];
  for (const m of text.matchAll(ROUTER_MODEL)) {
    const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
    if (/\/\/|^\s*\*|^\s*\/\*/.test(text.slice(lineStart, m.index))) continue;
    const model = `${m[1]!}/${m[2]!}`;
    if (!out.some((x) => x.model === model)) out.push({ file, line: lineOf(text, m.index), model, provider: MASTRA_ROUTED[m[1]!] ?? null });
  }
  return out;
}

/** A model named by a `provider/model` string, `model: 'anthropic/claude-sonnet-4-5'`, or behind a fallback, `process.env.MODEL ?? 'openai/gpt-5'`. */
const ROUTER_MODEL = /\bmodel\s*:\s*(?:[^'"`\n,}]*?(?:\?\?|\|\|)\s*)?['"`]([a-z][a-z0-9-]*)\/([^'"`\s]+)['"`]/g;

/** Each framework by name, as init's findings and warnings say it. */
export const FRAMEWORK_NAMES: Readonly<Record<Framework['id'], string>> = {
  'ai-sdk': 'the AI SDK',
  'openai-agents': 'the OpenAI Agents SDK',
  mastra: 'Mastra',
  langchain: 'LangChain',
  'anthropic-tool-runner': 'the Anthropic tool runner',
  'claude-agent-sdk': 'the Claude Agent SDK',
  'pydantic-ai': 'Pydantic AI',
  'openai-agents-python': 'the OpenAI Agents SDK',
  'langchain-python': 'LangChain',
  crewai: 'CrewAI',
  'claude-agent-sdk-python': 'the Claude Agent SDK',
  'google-adk': 'Google ADK',
  llamaindex: 'LlamaIndex',
  'agent-framework': 'Microsoft Agent Framework',
  strands: 'Strands Agents',
  smolagents: 'smolagents',
  agno: 'Agno',
};

/** A framework's name at the start of a line: `Pydantic AI model: …`, `The AI SDK sends …`. */
const frameworkName = (id: Framework['id']) => FRAMEWORK_NAMES[id].replace(/^the /, 'The ');

/**
 * A model the code names through a framework, and the provider whose API it calls: null for a host
 * shadowlap doesn't record. `source` says where it came from, as the provider's `via`.
 */
interface NamedModel {
  file: string;
  line: number;
  model: string;
  provider: Provider['id'] | null;
  via: Framework['id'];
  source: string;
}

/** LiteLLM's provider prefixes (`anthropic/claude-sonnet-4-5`) for the APIs Shadowlap records. Any other prefix goes to a host it doesn't. */
const LITELLM_RECORDED: Readonly<Record<string, Provider['id']>> = { openai: 'openai', anthropic: 'anthropic', gemini: 'gemini', vertex_ai: 'vertex', vertex_ai_beta: 'vertex', bedrock: 'bedrock', azure: 'azure' };

/** CrewAI's, which add names of its own to LiteLLM's (`claude/…`, `google/…`, `aws/…`). */
const CREWAI_RECORDED: Readonly<Record<string, Provider['id']>> = { ...LITELLM_RECORDED, claude: 'anthropic', google: 'gemini', aws: 'bedrock', azure_openai: 'azure' };

/** LangChain's `init_chat_model` providers (`anthropic:claude-…`, `model_provider="anthropic"`), with `-` read as `_` as LangChain.js writes them. */
const LANGCHAIN_RECORDED: Readonly<Record<string, Provider['id']>> = { openai: 'openai', anthropic: 'anthropic', azure_openai: 'azure', azure_ai: 'azure', google_genai: 'gemini', google_vertexai: 'vertex', google_vertexai_web: 'vertex', google_anthropic_vertex: 'vertex', bedrock: 'bedrock', bedrock_converse: 'bedrock', anthropic_bedrock: 'bedrock' };

const LANGCHAIN_OTHERS = new Set(['baseten', 'cerebras', 'cohere', 'deepseek', 'fireworks', 'groq', 'huggingface', 'ibm', 'meta', 'mistralai', 'nvidia', 'ollama', 'openrouter', 'perplexity', 'together', 'upstage', 'xai']);

/** Agno's `provider:model` strings (`Agent(model="anthropic:claude-sonnet-4-5")`). */
const AGNO_RECORDED: Readonly<Record<string, Provider['id']>> = { anthropic: 'anthropic', openai: 'openai', 'openai-chat': 'openai', 'openai-responses': 'openai', google: 'gemini', 'google-interactions': 'gemini', 'aws-bedrock': 'bedrock', 'aws-claude': 'bedrock', 'azure-openai': 'azure', 'azure-openai-responses': 'azure', 'azure-ai-foundry': 'azure', 'azure-foundry-claude': 'azure', 'vertexai-claude': 'vertex' };

/** Pydantic AI's model prefixes (PYDANTIC_MODEL) for the APIs Shadowlap records. */
const PYDANTIC_RECORDED: Readonly<Record<string, Provider['id']>> = { openai: 'openai', 'openai-chat': 'openai', 'openai-responses': 'openai', azure: 'azure', anthropic: 'anthropic', bedrock: 'bedrock', gemini: 'gemini', 'google-gla': 'gemini', 'google-vertex': 'vertex' };

/**
 * The provider a model string names, as a framework reads it: a provider id, null for a host
 * shadowlap doesn't record, undefined when the string doesn't say.
 */
function stringProvider(model: string, how: 'litellm' | 'crewai' | 'adk' | 'langchain'): Provider['id'] | null | undefined {
  const lower = model.toLowerCase();
  if (how === 'langchain') {
    const colon = /^([\w-]+):(.+)$/.exec(lower);
    const prefix = colon?.[1]!.replace(/-/g, '_');
    if (prefix && prefix in LANGCHAIN_RECORDED) return LANGCHAIN_RECORDED[prefix];
    if (prefix && LANGCHAIN_OTHERS.has(prefix)) return null;
    // A name alone: init_chat_model infers its provider from how it starts.
    if (/^(gpt-|o1|o3|chatgpt|text-davinci)/.test(lower)) return 'openai';
    if (lower.startsWith('claude')) return 'anthropic';
    if (lower.startsWith('gemini')) return 'vertex';
    if (/^(amazon|anthropic|meta)\./.test(lower)) return 'bedrock';
    if (/^(command|accounts\/fireworks|mistral|mixtral|deepseek|grok)/.test(lower)) return null;
    return undefined;
  }
  if (how === 'adk') {
    // ADK's model registry: Gemini's own, Claude on Vertex AI, OpenAI's, then LiteLLM's prefixes.
    if (/^(gemini-|gemma-4|model-optimizer-|projects\/)/.test(lower)) return 'gemini';
    if (lower.startsWith('claude-')) return 'vertex';
    if (/^(gpt-|o\d+-)/.test(lower)) return 'openai';
  }
  const slash = /^([\w-]+)\/(.+)$/.exec(lower);
  if (slash) return (how === 'crewai' ? CREWAI_RECORDED : LITELLM_RECORDED)[slash[1]!] ?? null;
  if (how === 'crewai') return lower.includes('anthropic.') ? 'bedrock' : lower.startsWith('claude') ? 'anthropic' : lower.startsWith('gemini') ? 'gemini' : 'openai';
  if (how === 'litellm') return /^(gpt-|o\d|chatgpt)/.test(lower) ? 'openai' : lower.startsWith('claude') ? 'anthropic' : undefined;
  return undefined;
}

/**
 * The model classes Python frameworks build their clients with, by the module they come from: the
 * provider whose API each calls, `litellm` or `crewai` for one whose model string names the provider,
 * or null for a module whose model classes all call a host shadowlap doesn't record.
 */
type ModelKind = Provider['id'] | 'litellm' | 'crewai' | null;

const PY_MODEL_CLASSES: ReadonlyArray<[RegExp, Framework['id'], Readonly<Record<string, ModelKind>> | null]> = [
  [/^agno\.models\.anthropic$/, 'agno', { Claude: 'anthropic' }],
  [/^agno\.models\.openai(\.\w+)?$/, 'agno', { OpenAIChat: 'openai', OpenAIResponses: 'openai' }],
  [/^agno\.models\.google(\.\w+)?$/, 'agno', { Gemini: 'gemini' }],
  [/^agno\.models\.aws(\.\w+)?$/, 'agno', { AwsBedrock: 'bedrock', Claude: 'bedrock' }],
  [/^agno\.models\.azure(\.\w+)?$/, 'agno', { AzureOpenAI: 'azure', AzureOpenAIResponses: 'azure', AzureAIFoundry: 'azure', AzureFoundryClaude: 'azure' }],
  [/^agno\.models\.vertexai(\.\w+)?$/, 'agno', { Claude: 'vertex' }],
  [/^agno\.models\.litellm$/, 'agno', { LiteLLM: 'litellm' }],
  [/^agno\.models\.(groq|mistral|ollama|openrouter|together|xai|deepseek|huggingface|cohere|fireworks|cerebras|perplexity|nvidia|lmstudio|vllm|llama_cpp|deepinfra|nebius|sambanova)(\.\w+)?$/, 'agno', null],
  [/^strands\.models(\.bedrock)?$/, 'strands', { BedrockModel: 'bedrock' }],
  [/^strands\.models\.anthropic$/, 'strands', { AnthropicModel: 'anthropic' }],
  [/^strands\.models\.openai(_responses)?$/, 'strands', { OpenAIModel: 'openai', OpenAIResponsesModel: 'openai' }],
  [/^strands\.models\.gemini$/, 'strands', { GeminiModel: 'gemini' }],
  [/^strands\.models\.litellm$/, 'strands', { LiteLLMModel: 'litellm' }],
  [/^strands\.models\.(ollama|mistral|llamaapi|llamacpp|writer|sagemaker)$/, 'strands', null],
  [/^llama_index\.llms\.openai$/, 'llamaindex', { OpenAI: 'openai', OpenAIResponses: 'openai' }],
  [/^llama_index\.llms\.anthropic$/, 'llamaindex', { Anthropic: 'anthropic' }],
  [/^llama_index\.llms\.(google_genai|gemini)$/, 'llamaindex', { GoogleGenAI: 'gemini', Gemini: 'gemini' }],
  [/^llama_index\.llms\.bedrock(_converse)?$/, 'llamaindex', { BedrockConverse: 'bedrock', Bedrock: 'bedrock' }],
  [/^llama_index\.llms\.azure_openai$/, 'llamaindex', { AzureOpenAI: 'azure' }],
  [/^llama_index\.llms\.vertex$/, 'llamaindex', { Vertex: 'vertex' }],
  [/^llama_index\.llms\.litellm$/, 'llamaindex', { LiteLLM: 'litellm' }],
  [/^llama_index\.llms\.(ollama|groq|mistralai|huggingface_api|openrouter|together|fireworks|deepseek|cohere|perplexity|xai)$/, 'llamaindex', null],
  [/^agent_framework(\.openai|_openai)$/, 'agent-framework', { OpenAIChatClient: 'openai', OpenAIChatCompletionClient: 'openai', OpenAIResponsesClient: 'openai', OpenAIAssistantsClient: 'openai' }],
  [/^agent_framework(\.azure|_azure_ai)$/, 'agent-framework', { AzureOpenAIChatClient: 'azure', AzureOpenAIResponsesClient: 'azure', AzureOpenAIAssistantsClient: 'azure', AzureAIAgentClient: 'azure', AzureAIClient: 'azure' }],
  [/^agent_framework(\.(anthropic|amazon|google|foundry)|_anthropic|_bedrock|_foundry|_claude)$/, 'agent-framework', { AnthropicClient: 'anthropic', AnthropicBedrockClient: 'bedrock', AnthropicVertexClient: 'vertex', AnthropicFoundryClient: 'azure', ClaudeAgent: 'anthropic', BedrockChatClient: 'bedrock', FoundryChatClient: 'azure', FoundryAgent: 'azure' }],
  [/^agent_framework(\.gemini|_gemini)$/, 'agent-framework', { GeminiChatClient: 'gemini' }],
  [/^agent_framework(\.(ollama|mistral)|_ollama|_mistral)$/, 'agent-framework', null],
  [/^smolagents(\.models)?$/, 'smolagents', { OpenAIServerModel: 'openai', OpenAIModel: 'openai', AzureOpenAIServerModel: 'azure', AzureOpenAIModel: 'azure', AmazonBedrockServerModel: 'bedrock', AmazonBedrockModel: 'bedrock', LiteLLMModel: 'litellm', InferenceClientModel: null, HfApiModel: null }],
  [/^google\.adk\.models(\.lite_llm|\.anthropic_llm|\.google_llm)?$/, 'google-adk', { LiteLlm: 'litellm', Claude: 'vertex', AnthropicLlm: 'anthropic', Gemini: 'gemini' }],
  [/^pydantic_ai\.models\.anthropic$/, 'pydantic-ai', { AnthropicModel: 'anthropic' }],
  [/^pydantic_ai\.models\.openai$/, 'pydantic-ai', { OpenAIChatModel: 'openai', OpenAIResponsesModel: 'openai', OpenAIModel: 'openai' }],
  [/^pydantic_ai\.models\.(google|gemini)$/, 'pydantic-ai', { GoogleModel: 'gemini', GeminiModel: 'gemini' }],
  [/^pydantic_ai\.models\.bedrock$/, 'pydantic-ai', { BedrockConverseModel: 'bedrock' }],
  [/^pydantic_ai\.models\.(groq|mistral|cohere|huggingface)$/, 'pydantic-ai', null],
  [/^crewai(\.llm)?$/, 'crewai', { LLM: 'crewai' }],
];

/** Names a module of model classes exports beside them: options, settings, messages, embeddings. */
const NOT_A_MODEL = /(Options|Settings|Config|Message|Embedding\w*|Error|Exception|Params|Response|Provider)$/;

/**
 * The models a file names through a framework, and the defaults it falls back on where it names
 * none: Mastra's router ids; the AI SDK's string ids (sent to Vercel's AI Gateway); LangChain's
 * `init_chat_model`; Pydantic AI's, CrewAI's, Google ADK's, Agno's and Strands' model strings; and
 * the model classes of PY_MODEL_CLASSES. An agent built with no model is its framework's default:
 * Strands' Bedrock, Agno's OpenAI, CrewAI's OpenAI. Only what the code says plainly counts: a model
 * read from a variable or the environment names nothing.
 */
export function scanModels(text: string, file: string): { named: NamedModel[]; defaults: Array<{ provider: Provider['id']; source: string }> } {
  const named: NamedModel[] = [];
  const defaults: Array<{ provider: Provider['id']; source: string }> = [];
  const add = (index: number, model: string, provider: Provider['id'] | null | undefined, via: Framework['id'], source: string) => {
    if (provider !== undefined && !named.some((n) => n.model === model && n.via === via)) named.push({ file, line: lineOf(text, index), model, provider, via, source });
  };
  if (!file.endsWith('.py')) {
    jsModels(text, file, named, add);
    return { named, defaults };
  }
  const scan: PyModelScan = { text, imports: pyImports(text), add, defaults };
  for (const models of PY_MODEL_SCANS) models(scan);
  return { named, defaults };
}

type AddModel = (index: number, model: string, provider: Provider['id'] | null | undefined, via: Framework['id'], source: string) => void;

/** The models a JavaScript or TypeScript file names: Mastra's router ids, the AI SDK's string ids, LangChain's `initChatModel`. */
function jsModels(text: string, file: string, named: NamedModel[], add: AddModel): void {
  for (const m of scanRouterModels(text, file)) named.push({ ...m, via: 'mastra', source: `Mastra model router: ${m.model}` });
  // The AI SDK sends a model named by a string to Vercel's AI Gateway, whose calls are captured in the process.
  for (const m of scanGatewayModels(text, file)) named.push({ ...m, provider: 'ai-gateway', via: 'ai-sdk', source: `AI SDK model id: ${m.model}` });
  for (const m of text.matchAll(/\binitChatModel\s*\(/g)) {
    if (inCommentAt(text, m.index, false)) continue;
    const args = callArguments(text, m.index + m[0].length, false) ?? [];
    const model = literal(args[0]?.text);
    const provider = /\bmodelProvider\s*:\s*['"`]([\w-]+)['"`]/.exec(args[1]?.text ?? '')?.[1];
    if (model) add(m.index, provider ? `${provider}:${model}` : model, stringProvider(provider ? `${provider}:${model}` : model, 'langchain'), 'langchain', `LangChain model: ${provider ? `${provider}:${model}` : model}`);
  }
}

/** What each framework's model scan of a Python file reads (its text and imports) and adds to: the models named, and the defaults of agents built with none. */
interface PyModelScan {
  text: string;
  imports: PyImports;
  add: AddModel;
  defaults: Array<{ provider: Provider['id']; source: string }>;
}

/** Whether the file imports from a module `module` matches. */
const usesModule = (s: PyModelScan, module: RegExp) => [...s.imports.values()].some((i) => module.test(i.module));

/** A call's arguments, or none when they can't be read. */
const argsAt = (s: PyModelScan, open: number) => callArguments(s.text, open, true) ?? [];

/** An agent's keyword arguments spread from a dict (`**config`), which may name anything. */
const spread = (args: ReadonlyArray<{ text: string }>) => args.some((a) => a.text.startsWith('**'));

/** Model classes: Claude(id=…) from agno.models.anthropic, LiteLlm(model="openai/gpt-5") from google.adk.models. */
function modelClasses(s: PyModelScan): void {
  const idOf = (args: ReadonlyArray<{ text: string; at: number }>) => literal((kwarg(args, 'model') ?? kwarg(args, 'model_id') ?? kwarg(args, 'id') ?? kwarg(args, 'model_name') ?? positional(args)[0])?.text);
  for (const [local, from] of s.imports) {
    const entry = PY_MODEL_CLASSES.find(([module]) => module.test(from.module));
    if (!entry) continue;
    const [, via, classes] = entry;
    const kind = classes === null ? (/^[A-Z]\w*$/.test(from.name) && !NOT_A_MODEL.test(from.name) ? null : undefined) : classes[from.name];
    if (kind === undefined) continue;
    for (const call of pyCalls(s.text, new Map([[local, from]]), /./, [from.name])) {
      const id = idOf(argsAt(s, call.open));
      if (kind === 'litellm' || kind === 'crewai') {
        if (id) s.add(call.index, id, stringProvider(id, kind), via, `${frameworkName(via)} model: ${id}`);
      } else s.add(call.index, id ?? from.name, kind, via, `${frameworkName(via)} model: ${from.name} (${from.module})`);
    }
  }
}

/** Pydantic AI: Agent("anthropic:claude-sonnet-4-5"). */
function pydanticModels(s: PyModelScan): void {
  if (!usesModule(s, /^pydantic_ai(\.|$)/)) return;
  for (const m of s.text.matchAll(PYDANTIC_MODEL)) if (!inCommentAt(s.text, m.index, true)) s.add(m.index, m[0].slice(1, -1), PYDANTIC_RECORDED[m[2]!] ?? null, 'pydantic-ai', `Pydantic AI model: ${m[0].slice(1, -1)}`);
}

/** LangChain: init_chat_model("anthropic:claude-sonnet-4-5"), or with model_provider="anthropic". */
function langchainModels(s: PyModelScan): void {
  for (const call of pyCalls(s.text, s.imports, /^langchain(\.|$)/, ['init_chat_model'])) {
    const args = argsAt(s, call.open);
    const model = literal((kwarg(args, 'model') ?? positional(args)[0])?.text);
    const provider = literal(kwarg(args, 'model_provider')?.text);
    const full = provider && model ? `${provider}:${model}` : model;
    if (full) s.add(call.index, full, stringProvider(full, 'langchain'), 'langchain-python', `LangChain model: ${full}`);
  }
}

/** CrewAI: an agent's llm="anthropic/claude-sonnet-4-5", or none, its default (OpenAI's) unless a config file may name one. */
function crewaiModels(s: PyModelScan): void {
  if (!usesModule(s, /^crewai(\.|$)/)) return;
  for (const m of s.text.matchAll(/\b(?:llm|manager_llm|function_calling_llm|planning_llm)\s*=\s*(["'])([^"'\n]+)\1/g)) if (!inCommentAt(s.text, m.index, true)) s.add(m.index, m[2]!, stringProvider(m[2]!, 'crewai'), 'crewai', `CrewAI model: ${m[2]!}`);
  for (const call of pyCalls(s.text, s.imports, /^crewai(\.agent)?$/, ['Agent'])) {
    const args = argsAt(s, call.open);
    if (!kwarg(args, 'llm') && !kwarg(args, 'config') && !spread(args)) s.defaults.push({ provider: 'openai', source: 'CrewAI default model: OpenAI' });
  }
}

/** Google ADK: LlmAgent(model="gemini-2.5-flash"), resolved by ADK's registry. */
function adkModels(s: PyModelScan): void {
  for (const call of pyCalls(s.text, s.imports, /^google\.adk(\.|$)/, ['Agent', 'LlmAgent'])) {
    const model = literal(kwarg(argsAt(s, call.open), 'model')?.text);
    if (model) s.add(call.index, model, stringProvider(model, 'adk'), 'google-adk', `Google ADK model: ${model}`);
  }
}

/** Agno: Agent(model="anthropic:claude-sonnet-4-5"), or no model, its default, OpenAI's Responses API. */
function agnoModels(s: PyModelScan): void {
  for (const call of pyCalls(s.text, s.imports, /^agno\.(agent|team)(\.|$)/, ['Agent', 'Team'])) {
    const args = argsAt(s, call.open);
    const model = kwarg(args, 'model');
    const given = literal(model?.text);
    const key = given ? /^([\w-]+):/.exec(given)?.[1] : undefined;
    if (given && key) s.add(call.index, given, AGNO_RECORDED[key] ?? null, 'agno', `Agno model: ${given}`);
    else if (!model && !spread(args)) s.defaults.push({ provider: 'openai', source: 'Agno default model: OpenAIResponses' });
  }
}

/** Strands: a string is a Bedrock model id, and no model is Strands' default, on Bedrock. */
function strandsModels(s: PyModelScan): void {
  for (const call of pyCalls(s.text, s.imports, /^strands(\.agent)?$/, ['Agent'])) {
    const args = argsAt(s, call.open);
    const model = kwarg(args, 'model') ?? positional(args)[0];
    const given = literal(model?.text);
    if (given) s.add(call.index, given, 'bedrock', 'strands', `Strands Agents model: ${given}`);
    else if (!model && !spread(args)) s.defaults.push({ provider: 'bedrock', source: 'Strands Agents default model: Bedrock' });
  }
}

/** The model scans of a Python file, in the order what they find is named. */
const PY_MODEL_SCANS: ReadonlyArray<(s: PyModelScan) => void> = [modelClasses, pydanticModels, langchainModels, crewaiModels, adkModels, agnoModels, strandsModels];

/**
 * Agent frameworks that bring an OpenAI client of their own, which reads OPENAI_BASE_URL: the OpenAI
 * Agents SDK, CrewAI (OpenAI is its default model), Mastra's model router, and Pydantic AI as a whole
 * (`pydantic-ai`, not `pydantic-ai-slim`, which has it only with its `[openai]` extra), unless every
 * model its code names is another provider's (pydanticModelsElsewhere). LangChain and
 * the AI SDK reach OpenAI only through a package of their own for it (`langchain-openai`,
 * `@ai-sdk/openai`), which counts as an OpenAI SDK.
 */
const OPENAI_FRAMEWORKS: ReadonlySet<Framework['id']> = new Set(['openai-agents', 'openai-agents-python', 'crewai', 'mastra']);

/** The largest lockfile read for the packages it installs: a big project's is a few megabytes. */
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;

/**
 * Whether an OpenAI client is installed though no dependency names it: `openai` in a lockfile,
 * which pulls it in for another package. (An `[openai]` extra names it: see pythonExtras.)
 */
function openaiInstalled(cwd: string): boolean {
  const read = (name: string) => {
    try {
      const p = join(cwd, name);
      return statSync(p).size <= MAX_LOCKFILE_BYTES ? readUtf8(p) : '';
    } catch {
      return '';
    }
  };
  const locks: Array<[string, RegExp]> = [
    ['uv.lock', /^name = "openai"$/m],
    ['poetry.lock', /^name = "openai"$/m],
    ['pdm.lock', /^name = "openai"$/m],
    ['Pipfile.lock', /^\s*"openai": \{/m],
    ['package-lock.json', /"node_modules\/openai"\s*:/],
    ['pnpm-lock.yaml', /^\s*\/?openai@/m],
    ['yarn.lock', /^"?openai@/m],
    ['bun.lock', /^\s*"openai": \["openai@/m],
  ];
  return locks.some(([name, re]) => re.test(read(name)));
}

/**
 * Pydantic AI's model names with a provider (`'anthropic:claude-sonnet-4-5'`), and which providers'
 * clients read OPENAI_BASE_URL: OpenAI's (and Azure's, counted with it to be safe). The others read
 * an address of their own, or have a fixed one.
 */
const PYDANTIC_MODEL = /(['"])(openai-chat|openai-responses|openai|azure|anthropic|bedrock|cerebras|cohere|deepseek|fireworks|gemini|google-gla|google-vertex|grok|groq|heroku|huggingface|mistral|ollama|openrouter|together|xai):[^'"\s]+\1/g;

const PYDANTIC_OPENAI = new Set(['openai', 'openai-chat', 'openai-responses', 'azure']);

/** An OpenAI model named without its provider (`'gpt-5'`, `'o3-mini'`), or an OpenAI model or provider built in code. */
const PYDANTIC_OPENAI_CODE = /(['"])(?:gpt-|chatgpt-|o[1-9](?:-|['"]))|\bOpenAI(?:Chat|Responses)?Model\b|\bOpenAIProvider\b|\bAzureProvider\b/;

/**
 * Whether the Python sources name Pydantic AI models, every one of them another provider's than
 * OpenAI's (`Agent("anthropic:claude-sonnet-4-5")`), and build no OpenAI model or provider: Pydantic
 * AI then makes no OpenAI client, though Pydantic AI as a whole installs one. False when they name
 * none (a model read from the environment, say), since nothing can be told then.
 */
function pydanticModelsElsewhere(texts: ReadonlyArray<readonly [string, string]>): boolean {
  let named = 0;
  for (const [file, text] of texts) {
    if (!file.endsWith('.py')) continue;
    if (PYDANTIC_OPENAI_CODE.test(text)) return false;
    for (const m of text.matchAll(PYDANTIC_MODEL)) {
      if (PYDANTIC_OPENAI.has(m[2]!)) return false;
      named++;
    }
  }
  return named > 0;
}

/**
 * An OpenAI-compatible server the project already uses: from the environment, a .env file or a base
 * URL fallback in code. OPENAI_BASE_URL reaches only an OpenAI client, so it is this project's
 * server unless every model client found is another provider's (Anthropic's, Gemini's): an OpenAI
 * SDK, a framework that brings one (OPENAI_FRAMEWORKS, Pydantic AI as a whole), an OpenAI client
 * installed for another package, or SDKs that can't be told all count. Pydantic AI makes a client
 * for the provider of each model the code names, so when every one is another provider's it brings
 * none, and the openai a lockfile lists is the one Pydantic AI as a whole installed.
 */
export function findModelServer(cwd: string, env: NodeJS.ProcessEnv, texts: Array<[string, string]>, providers: readonly Provider[], frameworks: readonly Framework[]): InitReport['modelServer'] {
  const toUpstream = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/, '');
  const local = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/.test(url) && !url.includes('/openai');
  const pydantic = frameworks.find((f) => f.id === 'pydantic-ai') ?? null;
  const elsewhere = pydantic !== null && pydanticModelsElsewhere(texts);
  const framework = frameworks.some((f) => OPENAI_FRAMEWORKS.has(f.id) || (f.id === 'pydantic-ai' && f.package === 'pydantic-ai' && !elsewhere));
  const lockfile = !(elsewhere && pydantic?.package === 'pydantic-ai') && openaiInstalled(cwd);
  const openaiClient = (providers.length === 0 && !elsewhere) || providers.some((p) => p.id === 'openai') || framework || lockfile;
  if (openaiClient && env.OPENAI_BASE_URL && !env.SHADOWLAP_URL) return { url: env.OPENAI_BASE_URL, upstream: toUpstream(env.OPENAI_BASE_URL), from: 'OPENAI_BASE_URL in your environment' };
  for (const f of openaiClient ? ['.env', '.env.local'] : []) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    const m = /^\s*OPENAI_BASE_URL\s*=\s*["']?([^"'\s#]+)/m.exec(readUtf8(p));
    if (m) return { url: m[1]!, upstream: toUpstream(m[1]!), from: `OPENAI_BASE_URL in ${f}` };
  }
  for (const [file, text] of texts) {
    const m = /(?:OPENAI_BASE_URL[^\n]{0,40}?(?:\?\?|\|\||or|,)\s*['"`]|base_url\s*=\s*["']|baseURL\s*:\s*['"`])(https?:\/\/[^'"`\s]+)/.exec(text);
    if (m && local(m[1]!)) return { url: m[1]!, upstream: toUpstream(m[1]!), from: `${rel(cwd, file)}:${lineOf(text, m.index)}` };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Package managers: the folder's own lockfile, or the workspace it belongs to
