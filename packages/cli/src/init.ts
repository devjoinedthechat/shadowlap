import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA_URL, configPath as configFile } from './config.js';
import { declaredManager, detectBuild, detectCommand, lockfileManager, nodeWorkspaceManager, pythonManager } from './init-command.js';
import { findModelServer, scanModels } from './init-models.js';
import { type Framework, type InitReport, type Language, type Provider, type UnrecordedModel } from './init-report.js';
import { installedVersion, pythonDependencies, pythonExtras, readJson, readUtf8, rel, sourceFiles } from './init-source.js';
import { declaredEffects, scanBaseUrls, scanFences, scanToolLists, scanTools } from './init-tools.js';

/**
 * `shadowlap init`: reads a project the way a colleague would before helping set shadowlap up, and
 * says exactly what to do next. It detects the language, the package manager, the model SDKs, the
 * agent framework, the command that starts the agent and the tools that need an effect, and warns
 * about the one thing that silently records nothing: a model client with a hardcoded base URL.
 * The only file it writes is an empty shadowlap.config.json, and only when there is none.
 */

const JS_PROVIDERS: Record<string, Provider['id']> = {
  '@anthropic-ai/sdk': 'anthropic',
  '@ai-sdk/anthropic': 'anthropic',
  openai: 'openai',
  '@ai-sdk/openai': 'openai',
  '@ai-sdk/openai-compatible': 'openai',
  '@google/genai': 'gemini',
  '@ai-sdk/google': 'gemini',
  '@langchain/anthropic': 'anthropic',
  '@langchain/openai': 'openai',
  '@langchain/google-genai': 'gemini',
  '@ai-sdk/azure': 'azure',
  '@anthropic-ai/vertex-sdk': 'vertex',
  '@ai-sdk/google-vertex': 'vertex',
  '@langchain/google-vertexai': 'vertex',
  '@anthropic-ai/bedrock-sdk': 'bedrock',
  '@aws-sdk/client-bedrock-runtime': 'bedrock',
  '@ai-sdk/amazon-bedrock': 'bedrock',
  '@langchain/aws': 'bedrock',
  '@ai-sdk/gateway': 'ai-gateway',
  // Claude Code, which the SDK runs, calls Anthropic's API through ANTHROPIC_BASE_URL.
  '@anthropic-ai/claude-agent-sdk': 'anthropic',
};

const PY_PROVIDERS: Record<string, Provider['id']> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'google-genai': 'gemini',
  'langchain-anthropic': 'anthropic',
  'langchain-openai': 'openai',
  'langchain-google-genai': 'gemini',
  'google-cloud-aiplatform': 'vertex',
  'langchain-google-vertexai': 'vertex',
  'langchain-aws': 'bedrock',
  'claude-agent-sdk': 'anthropic',
  'llama-index-llms-openai': 'openai',
  'llama-index-llms-anthropic': 'anthropic',
  'llama-index-llms-google-genai': 'gemini',
  'llama-index-llms-gemini': 'gemini',
  'llama-index-llms-azure-openai': 'azure',
  'llama-index-llms-vertex': 'vertex',
  'llama-index-llms-bedrock-converse': 'bedrock',
  'llama-index-llms-bedrock': 'bedrock',
  'agent-framework-openai': 'openai',
  'agent-framework-anthropic': 'anthropic',
  'agent-framework-claude': 'anthropic',
  'agent-framework-gemini': 'gemini',
  'agent-framework-bedrock': 'bedrock',
  'agent-framework-foundry': 'azure',
  'agent-framework-azure-ai': 'azure',
};

/** Extras that install a provider's SDK, by the provider (Pydantic AI's names). */
const EXTRA_PROVIDERS: Record<string, Provider['id']> = { openai: 'openai', anthropic: 'anthropic', google: 'gemini', gemini: 'gemini', 'google-genai': 'gemini', vertexai: 'vertex', bedrock: 'bedrock' };

/** What a project's own files say, as inspectProject reads them once: its manifests, its dependencies and its source. */
interface ProjectFiles {
  cwd: string;
  pkg: Record<string, unknown> | null;
  /** package.json's dependencies and devDependencies. */
  deps: Record<string, string>;
  /** The Python packages it depends on. */
  py: Set<string>;
  /** Each source file, with its text. */
  texts: Array<[string, string]>;
}

export function inspectProject(cwd: string, env: NodeJS.ProcessEnv = process.env): InitReport {
  const pkg = readJson(join(cwd, 'package.json'));
  const deps = { ...((pkg?.dependencies ?? {}) as Record<string, string>), ...((pkg?.devDependencies ?? {}) as Record<string, string>) };
  const files = sourceFiles(cwd);
  const project: ProjectFiles = { cwd, pkg, deps, py: pythonDependencies(cwd), texts: files.map((f) => [f, readUtf8(f)]) };
  const { texts } = project;
  const languages = languagesOf(project);
  const python = pythonManager(cwd);
  const packageManager = packageManagerOf(project, languages, python);
  const { providers, unrecordedModels } = providersOf(project);
  const frameworks = frameworksOf(project);
  const scanned = texts.flatMap(([f, t]) => scanTools(t, rel(cwd, f)));
  const tools = [...scanned, ...scanToolLists(texts, cwd, scanned)];
  declaredEffects(tools, texts, cwd);
  const hardcodedBaseUrls = texts.flatMap(([f, t]) => scanBaseUrls(t, rel(cwd, f)));
  // A config from before the rename counts: writing a new one beside it would hide its redaction rules.
  const configPath = configFile(cwd);
  return {
    cwd,
    languages,
    packageManager,
    providers,
    frameworks,
    command: detectCommand(cwd, pkg, packageManager, python, languages, texts),
    build: detectBuild(cwd, pkg, packageManager),
    tools,
    fence: scanFences(frameworks, languages, texts, cwd),
    hardcodedBaseUrls,
    unrecordedModels,
    modelServer: findModelServer(cwd, env, texts, providers, frameworks),
    scannedFiles: files.length,
    config: { path: configPath, existed: existsSync(configPath) },
  };
}

/** TypeScript or JavaScript for a package.json or such source files, and Python for Python's manifests or files. */
function languagesOf({ cwd, pkg, py, texts }: ProjectFiles): Language[] {
  const languages: Language[] = [];
  if (pkg || texts.some(([f]) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f))) languages.push(existsSync(join(cwd, 'tsconfig.json')) || texts.some(([f]) => /\.(ts|tsx|mts|cts)$/.test(f)) ? 'typescript' : 'javascript');
  if (py.size || existsSync(join(cwd, 'pyproject.toml')) || texts.some(([f]) => f.endsWith('.py'))) languages.push('python');
  return languages;
}

/**
 * The folder's own lockfile, then what its package.json declares, then the workspace it is a
 * package of: in a pnpm or Yarn workspace the lockfile is at the root, and npm can't install a
 * member's `workspace:` dependencies. Without a package.json, Python's.
 */
function packageManagerOf({ cwd, pkg }: ProjectFiles, languages: readonly Language[], python: InitReport['packageManager']): InitReport['packageManager'] {
  const lock = lockfileManager(cwd);
  if (lock && lock !== 'npm') return lock;
  if (pkg) return lock ?? declaredManager(pkg) ?? nodeWorkspaceManager(cwd) ?? 'npm';
  if (languages.includes('python')) return python;
  return existsSync(join(cwd, 'uv.lock')) ? 'uv' : existsSync(join(cwd, 'poetry.lock')) ? 'poetry' : null;
}

/** Scripts without a dependency file (a requirements.txt nobody wrote): the imports tell. */
const PROVIDER_IMPORTS: ReadonlyArray<[RegExp, Provider['id'], string]> = [
  [/^\s*(?:import\s+anthropic|from\s+anthropic\s+import)\b/m, 'anthropic', 'anthropic'],
  [/^\s*(?:import\s+openai|from\s+openai\s+import)\b/m, 'openai', 'openai'],
  [/^\s*from\s+google\s+import\s+genai\b/m, 'gemini', 'google-genai'],
  [/from\s+['"]@anthropic-ai\/sdk['"]/, 'anthropic', '@anthropic-ai/sdk'],
  [/from\s+['"]openai['"]/, 'openai', 'openai'],
  [/from\s+['"]@google\/genai['"]/, 'gemini', '@google/genai'],
  // Clients for the cloud platforms, whichever package they come in.
  [/\bAzureOpenAI\b/, 'azure', 'AzureOpenAI'],
  [/\bAnthropicVertex\b/, 'vertex', 'AnthropicVertex'],
  [/\bAnthropicBedrock\b/, 'bedrock', 'AnthropicBedrock'],
  [/['"]bedrock-runtime['"]|BedrockRuntimeClient/, 'bedrock', 'bedrock-runtime'],
  [/vertexai\s*[:=]\s*(true|True)/, 'vertex', 'google-genai on Vertex'],
];

/** The model providers a project calls, each once, by the first thing that says so, and the models a framework sends where shadowlap doesn't record. */
function providersOf({ cwd, deps, py, texts }: ProjectFiles): { providers: Provider[]; unrecordedModels: UnrecordedModel[] } {
  const providers: Provider[] = [];
  const addProvider = (id: Provider['id'], via: string) => {
    if (!providers.some((p) => p.id === id)) providers.push({ id, via });
  };
  for (const [name, id] of Object.entries(JS_PROVIDERS)) if (deps[name]) addProvider(id, name);
  for (const [name, id] of Object.entries(PY_PROVIDERS)) if (py.has(name)) addProvider(id, name);
  // An extra that installs a provider's SDK with a framework: `pydantic-ai-slim[openai]`. (A provider's own SDK's extras, as `anthropic[bedrock]`, add a transport, not an SDK.)
  for (const { name, extra } of pythonExtras(cwd)) if (EXTRA_PROVIDERS[extra] && !(name in PY_PROVIDERS)) addProvider(EXTRA_PROVIDERS[extra], `${name}[${extra}]`);
  if (deps['@openai/agents']) addProvider('openai', '@openai/agents');
  for (const [re, id, via] of PROVIDER_IMPORTS) if (texts.some(([, t]) => re.test(t))) addProvider(id, `${via}, imported`);
  if (py.has('openai-agents')) addProvider('openai', 'openai-agents');
  // The models a framework names (Mastra's router, the AI SDK's string ids, LangChain's, Pydantic AI's,
  // CrewAI's, ADK's, Agno's and Strands' strings, model classes), and the default an agent built with
  // none falls back on: the framework builds the client, so no provider SDK need be a dependency.
  const models = texts.map(([f, t]) => scanModels(t, rel(cwd, f)));
  for (const { named, defaults } of models) {
    for (const m of named) if (m.provider) addProvider(m.provider, m.source);
    for (const d of defaults) addProvider(d.provider, d.source);
  }
  const unrecordedModels: UnrecordedModel[] = models.flatMap(({ named }) => named.filter((m) => !m.provider).map((m) => ({ file: m.file, line: m.line, model: m.model, via: m.via })));
  return { providers, unrecordedModels };
}

/** The agent frameworks a project depends on: its npm packages, with their installed version, and its Python packages. */
function frameworksOf({ cwd, deps, py, texts }: ProjectFiles): Framework[] {
  const frameworks: Framework[] = [];
  const js = (id: Framework['id'], name: string, pkgName: string, adapter: string | null) => {
    if (deps[pkgName]) frameworks.push({ id, name, package: pkgName, version: installedVersion(cwd, pkgName) ?? deps[pkgName], adapter });
  };
  js('ai-sdk', 'Vercel AI SDK', 'ai', 'ai-sdk');
  js('openai-agents', 'OpenAI Agents SDK', '@openai/agents', 'openai-agents');
  js('mastra', 'Mastra', '@mastra/core', 'mastra');
  if (deps['@langchain/langgraph']) js('langchain', 'LangGraph', '@langchain/langgraph', 'langchain');
  else js('langchain', 'LangChain', '@langchain/core', 'langchain');
  js('claude-agent-sdk', 'Claude Agent SDK', '@anthropic-ai/claude-agent-sdk', 'claude-agent-sdk');
  if (deps['@anthropic-ai/sdk'] && texts.some(([, t]) => /toolRunner\(/.test(t))) frameworks.push({ id: 'anthropic-tool-runner', name: 'Anthropic tool runner', package: '@anthropic-ai/sdk', version: installedVersion(cwd, '@anthropic-ai/sdk') ?? deps['@anthropic-ai/sdk'], adapter: 'anthropic' });
  const pyFw = (id: Framework['id'], name: string, names: string[]) => {
    const hit = names.find((n) => py.has(n));
    if (hit) frameworks.push({ id, name, package: hit, version: null, adapter: null });
  };
  pyFw('pydantic-ai', 'Pydantic AI', ['pydantic-ai', 'pydantic-ai-slim']);
  pyFw('openai-agents-python', 'OpenAI Agents SDK (Python)', ['openai-agents']);
  pyFw('langchain-python', 'LangChain / LangGraph (Python)', ['langgraph', 'langchain', 'langchain-core']);
  pyFw('crewai', 'CrewAI', ['crewai']);
  pyFw('claude-agent-sdk-python', 'Claude Agent SDK (Python)', ['claude-agent-sdk']);
  pyFw('google-adk', 'Google ADK', ['google-adk']);
  pyFw('llamaindex', 'LlamaIndex', ['llama-index', 'llama-index-core']);
  pyFw('agent-framework', 'Microsoft Agent Framework', ['agent-framework', 'agent-framework-core']);
  pyFw('strands', 'Strands Agents', ['strands-agents']);
  pyFw('smolagents', 'smolagents', ['smolagents']);
  pyFw('agno', 'Agno', ['agno']);
  return frameworks;
}

/** Writes an empty configuration when there is none. Returns whether it wrote one. */
export function writeInitialConfig(report: InitReport): boolean {
  if (report.config.existed) return false;
  writeFileSync(report.config.path, JSON.stringify({ $schema: CONFIG_SCHEMA_URL, normalize: [], redact: [] }, null, 2) + '\n', { flag: 'wx' });
  return true;
}
