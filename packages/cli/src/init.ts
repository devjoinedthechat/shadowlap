import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { Effect } from '@shadowlap/engine';
import { CONFIG_FILE, CONFIG_SCHEMA_URL, configPath as configFile } from './config.js';
import { providers as sidecarProviders } from '@shadowlap/sidecar';
import { quoteArgv } from './ui.js';

/**
 * `shadowlap init`: reads a project the way a colleague would before helping set Shadowlap up, and
 * says exactly what to do next. It detects the language, the package manager, the model SDKs, the
 * agent framework, the command that starts the agent and the tools that need an effect, and warns
 * about the one thing that silently records nothing: a model client with a hardcoded base URL.
 * The only file it writes is an empty shadowlap.config.json, and only when there is none.
 */

export type Language = 'typescript' | 'javascript' | 'python';

export interface Provider {
  id: 'anthropic' | 'openai' | 'gemini' | 'azure' | 'vertex' | 'bedrock';
  /** The package it was found through. */
  via: string;
}

export interface Framework {
  id: 'ai-sdk' | 'openai-agents' | 'mastra' | 'langchain' | 'anthropic-tool-runner' | 'pydantic-ai' | 'openai-agents-python' | 'langchain-python' | 'crewai';
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
}

export interface BaseUrlWarning {
  file: string;
  line: number;
  url: string;
  /** The client it configures, when the code around it says: anthropic, openai or gemini. */
  client: 'anthropic' | 'openai' | 'gemini' | null;
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
  /** Model clients whose base URL is a literal: their calls bypass Shadowlap. */
  hardcodedBaseUrls: BaseUrlWarning[];
  /** A local or OpenAI-compatible server the project already points at. */
  modelServer: { url: string; upstream: string; from: string } | null;
  scannedFiles: number;
  config: { path: string; existed: boolean };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', 'env', '__pycache__', '.shadowlap', 'coverage', '.turbo', '.cache', 'site-packages', '.mypy_cache', '.pytest_cache', 'target']);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 512 * 1024;

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
};
const PY_PROVIDERS: Record<string, Provider['id']> = { anthropic: 'anthropic', openai: 'openai', 'google-genai': 'gemini', 'langchain-anthropic': 'anthropic', 'langchain-openai': 'openai', 'google-cloud-aiplatform': 'vertex', 'langchain-google-vertexai': 'vertex', 'langchain-aws': 'bedrock' };

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function installedVersion(cwd: string, pkg: string): string | null {
  const v = readJson(join(cwd, 'node_modules', pkg, 'package.json'))?.version;
  return typeof v === 'string' ? v : null;
}

/** Python dependency names from pyproject.toml, requirements files and Pipfile, lowercased and normalized. */
function pythonDependencies(cwd: string): Set<string> {
  const names = new Set<string>();
  const add = (spec: string) => {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
    if (m) names.add(m[1]!.toLowerCase().replace(/_/g, '-'));
  };
  const pyproject = join(cwd, 'pyproject.toml');
  if (existsSync(pyproject)) {
    const text = readFileSync(pyproject, 'utf8');
    // An array of quoted specs; extras like "pydantic-ai-slim[openai]" put brackets inside the quotes.
    for (const block of text.matchAll(/(?:^|\n)\s*(?:dependencies|requires)\s*=\s*\[((?:\s*(?:#[^\n]*)?\s*["'][^"']*["']\s*,?)*)\s*\]/g)) for (const s of block[1]!.matchAll(/["']([^"']+)["']/g)) add(s[1]!);
    for (const section of text.matchAll(/\[tool\.poetry(?:\.group\.\w+)?\.dependencies\]([\s\S]*?)(?=\n\[|$)/g)) for (const line of section[1]!.split('\n')) if (/^\s*[\w.-]+\s*=/.test(line)) add(line);
  }
  for (const f of ['requirements.txt', 'requirements-dev.txt', 'requirements.in']) {
    const p = join(cwd, f);
    if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split('\n')) if (line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('-')) add(line);
  }
  const pipfile = join(cwd, 'Pipfile');
  if (existsSync(pipfile)) for (const line of readFileSync(pipfile, 'utf8').split('\n')) if (/^\s*[\w.-]+\s*=/.test(line)) add(line);
  return names;
}

function sourceFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= MAX_FILES || depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (out.length >= MAX_FILES) return;
      if (SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.')) continue;
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path, depth + 1);
      else if (SOURCE.test(name) && !name.endsWith('.d.ts') && st.size <= MAX_FILE_BYTES) out.push(path);
    }
  };
  walk(cwd, 0);
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;
/** A project-relative path with forward slashes on every platform, as people type and click them. */
const rel = (cwd: string, file: string) => relative(cwd, file).split(sep).join('/');

const WRITE_WORDS = new Set(['send', 'post', 'create', 'write', 'delete', 'remove', 'update', 'upsert', 'set', 'put', 'insert', 'save', 'submit', 'pay', 'charge', 'refund', 'transfer', 'book', 'order', 'publish', 'deploy', 'notify', 'execute', 'exec', 'run', 'commit', 'push', 'merge', 'approve', 'cancel', 'archive', 'move', 'rename', 'upload', 'add', 'email', 'reply', 'schedule', 'invite', 'assign', 'close', 'apply', 'install', 'kill', 'restart', 'trigger', 'tweet', 'comment']);
const READ_WORDS = new Set(['get', 'read', 'fetch', 'search', 'list', 'find', 'lookup', 'query', 'load', 'browse', 'retrieve', 'check', 'describe', 'view', 'show', 'count', 'download', 'inspect', 'weather', 'scrape', 'crawl', 'grep', 'ls', 'cat', 'tail', 'head', 'watch', 'poll', 'price', 'quote']);
const PURE_WORDS = new Set(['calc', 'calculate', 'compute', 'parse', 'format', 'convert', 'validate', 'math', 'add_numbers', 'sum', 'multiply', 'divide', 'round', 'hash', 'encode', 'decode', 'tokenize', 'sort', 'diff', 'render']);

/** A first guess at a tool's effect from its name. Unknown names get `write`: it never re-runs after a fork. */
export function suggestEffect(name: string): { effect: Effect; why: string } {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // Tool names usually lead with their verb (read_file, send_email), so the first known word decides.
  for (const w of words) {
    if (WRITE_WORDS.has(w)) return { effect: 'write', why: `"${w}" changes something` };
    if (READ_WORDS.has(w)) return { effect: 'read', why: `"${w}" only looks` };
    if (PURE_WORDS.has(w)) return { effect: 'pure', why: `"${w}" depends only on its input` };
  }
  return { effect: 'write', why: 'no hint in the name; write is the safe guess, it never re-runs after a fork' };
}

/** Tool definitions in one file, by the patterns each framework uses. */
function scanTools(text: string, file: string): FoundTool[] {
  const found: FoundTool[] = [];
  const push = (name: string, index: number, via: string, effect: Effect | null) => {
    const s = suggestEffect(name);
    const tool: FoundTool = { name, file, line: lineOf(text, index), via, effect, suggested: effect ?? s.effect, why: effect ? 'declared' : s.why };
    const same = found.findIndex((t) => t.name === name && t.via === via);
    if (same < 0) found.push(tool);
    else if (!found[same]!.effect && effect) found[same] = tool; // a wrapped definition wins over a mention
  };
  /** Inside a line or block comment: `tool(` in prose is not a definition. */
  const inComment = (index: number) => {
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    const before = text.slice(lineStart, index);
    if (/\/\/|^\s*\*|^\s*\/\*/.test(before) || (file.endsWith('.py') && before.includes('#'))) return true;
    const open = text.lastIndexOf('/*', index);
    return open >= 0 && text.lastIndexOf('*/', index) < open;
  };
  const py = file.endsWith('.py');
  if (py) {
    // Decorated functions: collect each function's decorators, then classify.
    for (const m of text.matchAll(/((?:^[ \t]*@[^\n]+\n)+)[ \t]*(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
      const decorators = m[1]!;
      const name = m[2]!;
      const declared = /@tool\(\s*(?:["'][^"']*["']\s*,\s*)?effect\s*=\s*["'](pure|read|write)["']/.exec(decorators);
      const adapted = /@function_tool\([^)]*effect\s*=\s*["'](pure|read|write)["']/.exec(decorators);
      if (declared) push(name, m.index!, 'shadowlap', declared[1] as Effect);
      else if (adapted) push(name, m.index!, 'openai-agents-python', adapted[1] as Effect);
      else if (/@\w+\.tool(?:_plain)?\b/.test(decorators)) push(name, m.index!, 'pydantic-ai', null);
      else if (/@function_tool\b/.test(decorators)) push(name, m.index!, 'openai-agents-python', null);
      else if (/@(?:tool|langchain_core\.tools\.tool)\b/.test(decorators) && /langchain|crewai/.test(text)) push(name, m.index!, /crewai/.test(text) ? 'crewai' : 'langchain-python', null);
    }
    // LangChain and CrewAI tools get their effect where they're used: with_effect(search_web, "read").
    for (const m of text.matchAll(/\bwith_effect\(\s*(\w+)\s*,\s*["'](pure|read|write)["']/g)) {
      const t = found.find((x) => x.name === m[1] && !x.effect);
      if (t) Object.assign(t, { effect: m[2] as Effect, suggested: m[2] as Effect, why: 'declared' });
    }
    return found;
  }
  // @shadowlap/sdk: tool('name', { effect: 'read' }, impl)
  if (text.includes('@shadowlap/sdk')) for (const m of text.matchAll(/\btool\(\s*['"`]([\w.-]+)['"`]\s*,\s*\{[^}]*?effect:\s*['"`](pure|read|write)['"`]/g)) push(m[1]!, m.index!, 'shadowlap', m[2] as Effect);
  const adapted = text.includes('@shadowlap/adapters');
  /**
   * The effect an adapter declares for a tool, if it is wrapped: `tool(withEffect({ … }, 'read'))`,
   * `withEffect(tool(…), 'read')`, or the AI SDK's `withEffects({ … }, { name: 'read' })`.
   * `callStart` is where the framework call begins, `callOpen` just past its parenthesis, `nameEnd`
   * just past the tool's name.
   */
  const wrappedEffect = (callStart: number, callOpen: number, nameEnd: number, name: string): Effect | null => {
    if (!adapted) return null;
    const before = text.slice(Math.max(0, callStart - 40), callStart);
    const inner = text.slice(callOpen, callOpen + 40);
    if (/withEffect(?:V0)?\(\s*$/.test(before) || /^\s*withEffect(?:V0)?\(/.test(inner)) {
      // The effect follows the definition: `}, 'read'` or `}, { effect: 'write', … }`, maybe after a comment.
      const after = /[})]\s*,\s*(?:\/\/[^\n]*\n\s*)*(?:['"`](pure|read|write)['"`]|\{\s*effect:\s*['"`](pure|read|write)['"`])/.exec(text.slice(nameEnd, nameEnd + 4000));
      if (after) return (after[1] ?? after[2]) as Effect;
    }
    // withEffects({ ... }, { name: 'read' }) for the AI SDK
    const map = new RegExp(`['"\`]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]?\\s*:\\s*(?:['"\`](pure|read|write)['"\`]|\\{\\s*effect:\\s*['"\`](pure|read|write)['"\`])`).exec(text.slice(callStart));
    return map ? ((map[1] ?? map[2]) as Effect) : null;
  };
  if (/from\s+['"]ai['"]/.test(text)) {
    for (const m of text.matchAll(/(?:^|[\s,{])['"]?([A-Za-z_][\w-]*)['"]?\s*:\s*tool\(\s*\{/gm)) if (!inComment(m.index! + m[0].indexOf('tool('))) push(m[1]!, m.index! + m[0].indexOf(m[1]!), 'ai-sdk', wrappedEffect(m.index!, m.index! + m[0].length, m.index! + m[0].length, m[1]!));
  }
  const byName = (call: RegExp, key: 'name' | 'id', via: string) => {
    for (const m of text.matchAll(call)) {
      if (inComment(m.index!)) continue;
      const window = text.slice(m.index!, m.index! + 1500);
      const named = new RegExp(`\\b${key}:\\s*['"\`]([\\w.-]+)['"\`]`).exec(window);
      if (named) push(named[1]!, m.index!, via, wrappedEffect(m.index!, m.index! + m[0].length, m.index! + named.index + named[0].length, named[1]!));
    }
  };
  if (text.includes('@openai/agents')) byName(/\btool\(/g, 'name', 'openai-agents');
  if (text.includes('@mastra/core')) byName(/\bcreateTool\(/g, 'id', 'mastra');
  if (text.includes('@langchain/core/tools')) byName(/\btool\(/g, 'name', 'langchain');
  if (/betaZodTool|betaTool/.test(text)) byName(/\bbeta(?:Zod)?Tool\(/g, 'name', 'anthropic-tool-runner');
  return found;
}

/** Model clients constructed with a literal base URL: `shadowlap run` cannot redirect them. */
function scanBaseUrls(text: string, file: string): BaseUrlWarning[] {
  const out: BaseUrlWarning[] = [];
  const re = file.endsWith('.py') ? /\bbase_url\s*=\s*["'](https?:\/\/[^"']+)["']/g : /\bbaseURL\s*:\s*['"`](https?:\/\/[^'"`$]+)['"`]/g;
  for (const m of text.matchAll(re)) {
    // `baseURL: process.env.OPENAI_BASE_URL ?? '…'` is fine; only a bare literal bypasses the environment.
    const lineStart = text.lastIndexOf('\n', m.index!) + 1;
    const line = text.slice(lineStart, text.indexOf('\n', m.index!) === -1 ? undefined : text.indexOf('\n', m.index!));
    if (/process\.env|os\.environ|getenv|BASE_URL/.test(line)) continue;
    const before = text.slice(Math.max(0, m.index! - 300), m.index!);
    const client = /Anthropic/.test(before) ? 'anthropic' : /OpenAI/.test(before) ? 'openai' : /GoogleGenAI|genai/.test(before) ? 'gemini' : null;
    out.push({ file, line: lineOf(text, m.index!), url: m[1]!, client });
  }
  return out;
}

/** An OpenAI-compatible server the project already uses: from the environment, a .env file or a base URL fallback in code. */
function findModelServer(cwd: string, env: NodeJS.ProcessEnv, texts: Array<[string, string]>): InitReport['modelServer'] {
  const toUpstream = (url: string) => url.replace(/\/+$/, '').replace(/\/v1$/, '');
  const local = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/.test(url) && !url.includes('/openai');
  if (env.OPENAI_BASE_URL && !env.SHADOWLAP_URL) return { url: env.OPENAI_BASE_URL, upstream: toUpstream(env.OPENAI_BASE_URL), from: 'OPENAI_BASE_URL in your environment' };
  for (const f of ['.env', '.env.local']) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    const m = /^\s*OPENAI_BASE_URL\s*=\s*["']?([^"'\s#]+)/m.exec(readFileSync(p, 'utf8'));
    if (m) return { url: m[1]!, upstream: toUpstream(m[1]!), from: `OPENAI_BASE_URL in ${f}` };
  }
  for (const [file, text] of texts) {
    const m = /(?:OPENAI_BASE_URL[^\n]{0,40}?(?:\?\?|\|\||or|,)\s*['"`]|base_url\s*=\s*["']|baseURL\s*:\s*['"`])(https?:\/\/[^'"`\s]+)/.exec(text);
    if (m && local(m[1]!)) return { url: m[1]!, upstream: toUpstream(m[1]!), from: `${rel(cwd, file)}:${lineOf(text, m.index)}` };
  }
  return null;
}

function detectCommand(cwd: string, pkg: Record<string, unknown> | null, manager: InitReport['packageManager'], languages: Language[]): InitReport['command'] {
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const runner = manager === 'pnpm' ? ['pnpm'] : manager === 'yarn' ? ['yarn'] : manager === 'bun' ? ['bun', 'run'] : ['npm', 'run'];
  for (const name of ['agent', 'start', 'dev', 'run']) {
    const script = scripts[name];
    // A script that starts a web dev server or a watcher is not the agent itself.
    if (typeof script === 'string' && !/\b(next|vite|nodemon|webpack|--watch|tsc -w)\b/.test(script)) return { argv: name === 'start' && runner[0] === 'npm' ? ['npm', 'start'] : [...runner, name], from: `package.json scripts.${name}: ${script}` };
  }
  if (languages.includes('python')) {
    const uv = existsSync(join(cwd, 'uv.lock'));
    for (const f of ['agent.py', 'main.py', 'app.py', 'run.py', 'src/agent.py', 'src/main.py']) {
      if (existsSync(join(cwd, f))) return { argv: uv ? ['uv', 'run', f] : ['python', f], from: f };
    }
  }
  for (const f of ['agent.ts', 'src/agent.ts', 'index.ts', 'src/index.ts', 'main.ts', 'src/main.ts']) {
    if (existsSync(join(cwd, f))) return { argv: ['npx', 'tsx', f], from: f };
  }
  for (const f of ['agent.mjs', 'agent.js', 'index.mjs', 'index.js', 'main.js', 'src/index.js']) {
    if (existsSync(join(cwd, f))) return { argv: ['node', f], from: f };
  }
  return null;
}

export function inspectProject(cwd: string, env: NodeJS.ProcessEnv = process.env): InitReport {
  const pkg = readJson(join(cwd, 'package.json'));
  const deps = { ...((pkg?.dependencies ?? {}) as Record<string, string>), ...((pkg?.devDependencies ?? {}) as Record<string, string>) };
  const py = pythonDependencies(cwd);
  const files = sourceFiles(cwd);
  const texts: Array<[string, string]> = files.map((f) => [f, readFileSync(f, 'utf8')]);

  const languages: Language[] = [];
  if (pkg || texts.some(([f]) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f))) languages.push(existsSync(join(cwd, 'tsconfig.json')) || texts.some(([f]) => /\.(ts|tsx|mts|cts)$/.test(f)) ? 'typescript' : 'javascript');
  if (py.size || existsSync(join(cwd, 'pyproject.toml')) || texts.some(([f]) => f.endsWith('.py'))) languages.push('python');

  const packageManager: InitReport['packageManager'] = existsSync(join(cwd, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(cwd, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))
        ? 'bun'
        : pkg
          ? 'npm'
          : existsSync(join(cwd, 'uv.lock'))
            ? 'uv'
            : existsSync(join(cwd, 'poetry.lock'))
              ? 'poetry'
              : languages.includes('python')
                ? 'pip'
                : null;

  const providers: Provider[] = [];
  const addProvider = (id: Provider['id'], via: string) => {
    if (!providers.some((p) => p.id === id)) providers.push({ id, via });
  };
  for (const [name, id] of Object.entries(JS_PROVIDERS)) if (deps[name]) addProvider(id, name);
  for (const [name, id] of Object.entries(PY_PROVIDERS)) if (py.has(name)) addProvider(id, name);
  if (deps['@openai/agents']) addProvider('openai', '@openai/agents');
  // Scripts without a dependency file (a requirements.txt nobody wrote): the imports tell.
  const IMPORTS: Array<[RegExp, Provider['id'], string]> = [
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
  for (const [re, id, via] of IMPORTS) if (texts.some(([, t]) => re.test(t))) addProvider(id, `${via}, imported`);
  if (py.has('openai-agents')) addProvider('openai', 'openai-agents');

  const frameworks: Framework[] = [];
  const js = (id: Framework['id'], name: string, pkgName: string, adapter: string | null) => {
    if (deps[pkgName]) frameworks.push({ id, name, package: pkgName, version: installedVersion(cwd, pkgName) ?? deps[pkgName]!, adapter });
  };
  js('ai-sdk', 'Vercel AI SDK', 'ai', 'ai-sdk');
  js('openai-agents', 'OpenAI Agents SDK', '@openai/agents', 'openai-agents');
  js('mastra', 'Mastra', '@mastra/core', 'mastra');
  if (deps['@langchain/langgraph']) js('langchain', 'LangGraph', '@langchain/langgraph', 'langchain');
  else js('langchain', 'LangChain', '@langchain/core', 'langchain');
  if (deps['@anthropic-ai/sdk'] && texts.some(([, t]) => /toolRunner\(/.test(t))) frameworks.push({ id: 'anthropic-tool-runner', name: 'Anthropic tool runner', package: '@anthropic-ai/sdk', version: installedVersion(cwd, '@anthropic-ai/sdk') ?? deps['@anthropic-ai/sdk']!, adapter: 'anthropic' });
  const pyFw = (id: Framework['id'], name: string, names: string[]) => {
    const hit = names.find((n) => py.has(n));
    if (hit) frameworks.push({ id, name, package: hit, version: null, adapter: null });
  };
  pyFw('pydantic-ai', 'Pydantic AI', ['pydantic-ai', 'pydantic-ai-slim']);
  pyFw('openai-agents-python', 'OpenAI Agents SDK (Python)', ['openai-agents']);
  pyFw('langchain-python', 'LangChain / LangGraph (Python)', ['langgraph', 'langchain', 'langchain-core']);
  pyFw('crewai', 'CrewAI', ['crewai']);

  const tools = texts.flatMap(([f, t]) => scanTools(t, rel(cwd, f)));
  const hardcodedBaseUrls = texts.flatMap(([f, t]) => scanBaseUrls(t, rel(cwd, f)));
  // A config from before the rename counts: writing a new one beside it would hide its redaction rules.
  const configPath = configFile(cwd);
  return {
    cwd,
    languages,
    packageManager,
    providers,
    frameworks,
    command: detectCommand(cwd, pkg, packageManager, languages),
    tools,
    hardcodedBaseUrls,
    modelServer: findModelServer(cwd, env, texts),
    scannedFiles: files.length,
    config: { path: configPath, existed: existsSync(configPath) },
  };
}

/** Writes an empty configuration when there is none. Returns whether it wrote one. */
export function writeInitialConfig(report: InitReport): boolean {
  if (report.config.existed) return false;
  writeFileSync(report.config.path, JSON.stringify({ $schema: CONFIG_SCHEMA_URL, normalize: [], redact: [] }, null, 2) + '\n', { flag: 'wx' });
  return true;
}

interface Palette {
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
}

/** Whether in-process capture already knows this URL's host: a provider's own API host. */
function captured(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return sidecarProviders.some((pr) => pr.hosts.test(host));
  } catch {
    return false;
  }
}

const PROVIDER_NAMES: Record<Provider['id'], [string, string]> = {
  anthropic: ['Anthropic', 'ANTHROPIC_BASE_URL'],
  openai: ['OpenAI', 'OPENAI_BASE_URL'],
  gemini: ['Gemini', 'GOOGLE_GEMINI_BASE_URL'],
  azure: ['Azure OpenAI', 'captured in the process'],
  vertex: ['Vertex AI', 'captured in the process'],
  bedrock: ['Amazon Bedrock', 'captured in the process'],
};

const ADAPTER_SNIPPETS: Record<string, (name: string, effect: Effect) => string> = {
  'ai-sdk': (n, e) => `const tools = withEffects({ ${n}: tool({ … }) }, { ${n}: '${e}' });   // import { withEffects } from '@shadowlap/adapters/ai-sdk'`,
  'openai-agents': (n, e) => `tool(withEffect({ name: '${n}', … }, '${e}'))   // import { withEffect } from '@shadowlap/adapters/openai-agents'`,
  mastra: (n, e) => `createTool(withEffect({ id: '${n}', … }, '${e}'))   // import { withEffect } from '@shadowlap/adapters/mastra'`,
  langchain: (n, e) => `withEffect(tool(impl, { name: '${n}', … }), '${e}')   // import { withEffect } from '@shadowlap/adapters/langchain'`,
  'anthropic-tool-runner': (n, e) => `betaZodTool(withEffect({ name: '${n}', … }, '${e}'))   // import { withEffect } from '@shadowlap/adapters/anthropic'`,
  python: (n, e) => `@tool(effect="${e}") above def ${n}   # from shadowlap import tool`,
  'pydantic-ai': (n, e) => `@agent.tool over @tool(effect="${e}") on def ${n}   # from shadowlap import tool`,
  'openai-agents-python': (n, e) => `@function_tool(effect="${e}") on def ${n}   # from shadowlap.adapters.openai_agents import function_tool`,
  'langchain-python': (n, e) => `with_effect(${n}, "${e}")   # from shadowlap.adapters.langchain import with_effect`,
  crewai: (n, e) => `with_effect(${n}, "${e}")   # from shadowlap.adapters.crewai import with_effect`,
};

export function formatInit(r: InitReport, p: Palette, wroteConfig: boolean): string {
  const lines: string[] = [];
  const out = (s = '') => lines.push(s);
  const ts = r.languages.includes('typescript') || r.languages.includes('javascript');
  const python = r.languages.includes('python');
  out(`${p.bold('Shadowlap init')}  ${p.dim(r.cwd)}`);
  out();

  // What was found.
  out(p.bold('Found'));
  if (!r.languages.length) {
    out(`  No package.json, pyproject.toml or source files here. Run ${p.cyan('shadowlap init')} in your agent's project directory.`);
    return lines.join('\n');
  }
  out(`  ${r.languages.map((l) => (l === 'typescript' ? 'TypeScript' : l === 'javascript' ? 'JavaScript' : 'Python')).join(' and ')}${r.packageManager ? ` · ${r.packageManager}` : ''} · ${r.scannedFiles} source file${r.scannedFiles === 1 ? '' : 's'}`);
  out(`  Model SDKs: ${r.providers.length ? r.providers.map((x) => `${PROVIDER_NAMES[x.id][0]} (${x.via})`).join(', ') : p.yellow('none found')}`);
  if (r.frameworks.length) out(`  Framework: ${r.frameworks.map((f) => `${f.name}${f.version ? ` ${f.version}` : ''}`).join(', ')}`);
  if (r.modelServer) out(`  Model server: ${r.modelServer.url} ${p.dim(`(${r.modelServer.from})`)}`);
  if (r.command) out(`  Agent command: ${quoteArgv(r.command.argv)} ${p.dim(`(${r.command.from})`)}`);
  const unwrapped = r.tools.filter((t) => !t.effect);
  out(`  Tools: ${r.tools.length ? `${r.tools.length} found, ${r.tools.length - unwrapped.length} with an effect` : 'none found'}`);
  out();

  // A provider's own host is captured in Node and Python processes; another host needs naming.
  const unknownHosts = r.hardcodedBaseUrls.filter((w) => !captured(w.url));
  for (const w of unknownHosts) {
    const id = w.client ?? '<provider>';
    out(`${p.yellow('!')} ${w.file}:${w.line} sets the model base URL to ${w.url}. Shadowlap doesn't know that host, so calls through that client would not be recorded.`);
    out(`  ${p.dim(`Run with SHADOWLAP_UPSTREAM_${id.toUpperCase()}=${w.url.replace(/\/v1\/?$/, '')}, or read the base URL from ${w.client ? PROVIDER_NAMES[w.client][1] : 'the environment'}.`)}`);
  }
  if (unknownHosts.length) out();
  if (!r.providers.length) {
    out(`${p.yellow('!')} No model SDK found (Anthropic, OpenAI, Gemini, Azure OpenAI, Vertex AI, Bedrock). An HTTP client of your own is recorded when it calls one of those APIs from Node or Python, or when it reads ANTHROPIC_BASE_URL, OPENAI_BASE_URL or GOOGLE_GEMINI_BASE_URL.`);
    out();
  }

  let step = 0;
  const head = (title: string) => {
    out(p.bold(`${++step}. ${title}`));
  };

  // Install.
  head('Install');
  if (ts) {
    const add = r.packageManager === 'pnpm' ? 'pnpm add' : r.packageManager === 'yarn' ? 'yarn add' : r.packageManager === 'bun' ? 'bun add' : 'npm install';
    const adapters = r.frameworks.some((f) => f.adapter);
    out(`     ${p.cyan(`${add} ${r.packageManager === 'npm' || !r.packageManager ? '--save-dev' : '-D'} shadowlap`)}`);
    out(`     ${p.cyan(`${add} @shadowlap/sdk${adapters ? ' @shadowlap/adapters' : ''}`)}   ${p.dim(adapters ? 'tool effects, through your framework' : 'tool effects, clock and randomness')}`);
  }
  if (python) {
    out(`     ${p.cyan(r.packageManager === 'uv' ? 'uv add shadowlap' : r.packageManager === 'poetry' ? 'poetry add shadowlap' : 'pip install shadowlap')}   ${p.dim('the Python SDK')}`);
    if (!ts) out(`     ${p.cyan('npm install --global shadowlap')}   ${p.dim('the CLI (Node 22.13 or later)')}`);
  }
  out();

  // Tools.
  if (r.tools.length) {
    head(unwrapped.length ? 'Declare what each tool does' : 'Tools');
    if (!unwrapped.length) out(`     Every tool found declares an effect.`);
    for (const t of unwrapped.slice(0, 20)) out(`     ${`${t.file}:${t.line}`.padEnd(32)} ${t.name.padEnd(22)} ${p.green(t.suggested.padEnd(5))}  ${p.dim(t.why)}`);
    if (unwrapped.length > 20) out(`     ${p.dim(`… ${unwrapped.length - 20} more`)}`);
    if (unwrapped.length) {
      const example = unwrapped[0]!;
      const snippet = ADAPTER_SNIPPETS[example.via] ?? (example.file.endsWith('.py') ? ADAPTER_SNIPPETS.python : undefined);
      if (snippet) out(`     ${p.dim('for example:')} ${snippet(example.name, example.suggested)}`);
      out(`     ${p.dim('read: may run again after a fork · write: never runs again after a fork · pure: depends only on its input')}`);
    }
    out();
  } else if (r.frameworks.length || r.providers.length) {
    head('Wrap your tools');
    out(`     ${p.dim('No tool definitions found. Wrap each tool with its effect so a fork never repeats a side effect:')}`);
    out(`     ${ts ? "tool('send_email', { effect: 'write' }, impl)   // import { tool } from '@shadowlap/sdk'" : '@tool(effect="write")   # from shadowlap import tool'}`);
    out();
  }

  // Record and replay.
  head('Record a run');
  const upstream = r.modelServer ? `SHADOWLAP_UPSTREAM_OPENAI=${r.modelServer.upstream} ` : '';
  const cli = ts ? 'npx shadowlap' : 'shadowlap';
  out(`     ${p.cyan(`${upstream}${cli} run -- ${r.command ? quoteArgv(r.command.argv) : '<the command that starts your agent>'}`)}`);
  if (r.modelServer) out(`     ${p.dim('SHADOWLAP_UPSTREAM_OPENAI keeps your model server as the upstream; the agent talks to Shadowlap.')}`);
  out();
  head('Replay it, then change something and replay again');
  out(`     ${p.cyan(`${cli} replay <run>`)}   ${p.dim('0 upstream requests when nothing changed')}`);
  out(`     ${p.cyan(`${cli} dashboard`)}   ${p.dim('or: shadowlap ui')}`);
  out();
  out(wroteConfig ? `Created ${CONFIG_FILE} for normalizers and redaction rules.` : `${basename(r.config.path)} already exists; left as it is.`);
  return lines.join('\n');
}
