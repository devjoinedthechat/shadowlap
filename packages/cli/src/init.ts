import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Effect } from '@shadowlap/engine';
import { AGENT_NODE_MIN, ProjectRegistry, describeFolder, modelServerFinding, nodePinTooOld, toolNameEffect, type FolderKind, type ModelServer, type RegistryOptions, type SetupFindings, type WrapSnippet } from '@shadowlap/engine';
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
  /** Model clients whose base URL is a literal: their calls bypass Shadowlap. */
  hardcodedBaseUrls: BaseUrlWarning[];
  /** Models named through a framework's router whose calls go where Shadowlap neither redirects nor captures. */
  unrecordedModels: UnrecordedModel[];
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

/**
 * A text file as Node and npm read it: a leading byte order mark, which Windows editors write, is
 * no part of the text (`require('./package.json')` drops it, and JSON.parse would refuse it).
 */
function readUtf8(path: string): string {
  const text = readFileSync(path, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readUtf8(path)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function installedVersion(cwd: string, pkg: string): string | null {
  const v = readJson(join(cwd, 'node_modules', pkg, 'package.json'))?.version;
  return typeof v === 'string' ? v : null;
}

/**
 * The quoted requirements in pyproject.toml's arrays with these keys (`dependencies = [...]`), read
 * a string at a time: extras (`"pydantic-ai-slim[openai]"`) put brackets inside the quotes, and a
 * marker (`; python_version >= '3.9'`) the other kind of quote.
 */
function tomlRequirements(text: string, keys: readonly string[]): string[] {
  const specs: string[] = [];
  const array = new RegExp(`(?:^|\\n)\\s*(?:${keys.join('|')})\\s*=\\s*\\[((?:"[^"\\n]*"|'[^'\\n]*'|#[^\\n]*|[^\\]"'#])*)\\]`, 'g');
  // A comment in the array is passed over, quotes and all.
  for (const block of text.matchAll(array)) for (const s of block[1]!.matchAll(/"([^"\n]*)"|'([^'\n]*)'|#[^\n]*/g)) if (s[1] !== undefined || s[2] !== undefined) specs.push(s[1] ?? s[2]!);
  return specs;
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
    const text = readUtf8(pyproject);
    for (const spec of tomlRequirements(text, ['dependencies', 'requires'])) add(spec);
    for (const section of text.matchAll(/\[tool\.poetry(?:\.group\.\w+)?\.dependencies\]([\s\S]*?)(?=\n\[|$)/g)) for (const line of section[1]!.split('\n')) if (/^\s*[\w.-]+\s*=/.test(line)) add(line);
  }
  for (const f of ['requirements.txt', 'requirements-dev.txt', 'requirements.in']) {
    const p = join(cwd, f);
    if (existsSync(p)) for (const line of readUtf8(p).split('\n')) if (line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('-')) add(line);
  }
  const pipfile = join(cwd, 'Pipfile');
  if (existsSync(pipfile)) for (const line of readUtf8(pipfile).split('\n')) if (/^\s*[\w.-]+\s*=/.test(line)) add(line);
  return names;
}

/**
 * The extras Python dependencies are asked for with (`pydantic-ai-slim[openai,anthropic]`), from
 * pyproject.toml (its dependency arrays, and Poetry's `extras = [...]`), requirements files and
 * Pipfile: an extra named after a provider installs that provider's SDK.
 */
function pythonExtras(cwd: string): Array<{ name: string; extra: string }> {
  const out: Array<{ name: string; extra: string }> = [];
  const add = (name: string, list: string) => {
    for (const e of list.split(',')) {
      const extra = e.trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (extra) out.push({ name: name.toLowerCase().replace(/_/g, '-'), extra });
    }
  };
  const spec = (text: string) => {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*\[([^\]\n]*)\]/.exec(text);
    if (m) add(m[1]!, m[2]!);
  };
  const table = (line: string) => {
    const m = /^\s*([\w.-]+)\s*=\s*\{[^}]*\bextras\s*=\s*\[([^\]]*)\]/.exec(line);
    if (m) add(m[1]!, m[2]!);
  };
  const read = (f: string) => (existsSync(join(cwd, f)) ? readUtf8(join(cwd, f)) : '');
  const pyproject = read('pyproject.toml');
  for (const s of tomlRequirements(pyproject, ['dependencies', 'requires'])) spec(s);
  for (const line of pyproject.split('\n')) table(line);
  for (const f of ['requirements.txt', 'requirements-dev.txt', 'requirements.in']) for (const line of read(f).split('\n')) if (!line.trim().startsWith('#')) spec(line);
  for (const line of read('Pipfile').split('\n')) table(line);
  return out;
}

/** Extras that install a provider's SDK, by the provider (Pydantic AI's names). */
const EXTRA_PROVIDERS: Record<string, Provider['id']> = { openai: 'openai', anthropic: 'anthropic', google: 'gemini', gemini: 'gemini', 'google-genai': 'gemini', vertexai: 'vertex', bedrock: 'bedrock' };

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

/** Inside a line or block comment: `tool(` in prose is not a definition, nor `model: '…'` a model. */
function inCommentAt(text: string, index: number, py: boolean): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const before = text.slice(lineStart, index);
  if (py) return before.includes('#');
  if (/\/\/|^\s*\*|^\s*\/\*/.test(before)) return true;
  const open = text.lastIndexOf('/*', index);
  return open >= 0 && text.lastIndexOf('*/', index) < open;
}

/** What a Python file imports by name (`from strands import tool as strands_tool`): each local name, with the module and the name it has there. */
type PyImports = Map<string, { module: string; name: string }>;
function pyImports(text: string): PyImports {
  const out: PyImports = new Map();
  for (const m of text.matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(?:\(([^)]*)\)|([^\n]*))/gm)) {
    for (const part of (m[2] ?? m[3]!).replace(/#[^\n]*/g, '').replace(/\\\n/g, ' ').split(',')) {
      const p = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (p) out.set(p[2] ?? p[1]!, { module: m[1]!, name: p[1]! });
    }
  }
  return out;
}

/** Where the string literal that starts at `i` ends (its closing quote), Python's triple quotes included. */
function stringEnd(text: string, i: number, py: boolean): number {
  const q = text[i]!;
  if (py && text.startsWith(q.repeat(3), i)) {
    const end = text.indexOf(q.repeat(3), i + 3);
    return end < 0 ? text.length : end + 2;
  }
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === q) return j;
    else if (text[j] === '\n' && q !== '`') return j;
  }
  return text.length;
}

/**
 * The arguments of a call (or the items of a list) whose bracket opens just before `open`, split at
 * its own commas, each with where it starts: null when it doesn't close within reach. Strings and
 * comments are passed over, so a comma or bracket in them splits nothing.
 */
function callArguments(text: string, open: number, py: boolean): Array<{ text: string; at: number }> | null {
  return scanCall(text, open, py)?.args ?? null;
}

/** {@link callArguments}, with where the bracket that closes the call is. */
function scanCall(text: string, open: number, py: boolean): { args: Array<{ text: string; at: number }>; end: number } | null {
  const out: Array<{ text: string; at: number }> = [];
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    if (raw.trim()) out.push({ text: raw.trim(), at: from + raw.length - raw.trimStart().length });
  };
  let depth = 1;
  let start = open;
  const limit = Math.min(text.length, open + 20_000);
  for (let i = open; i < limit; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || (c === '`' && !py)) i = stringEnd(text, i, py);
    else if (py ? c === '#' : c === '/' && text[i + 1] === '/') i = text.indexOf('\n', i) < 0 ? limit : text.indexOf('\n', i);
    else if (!py && c === '/' && text[i + 1] === '*') i = text.indexOf('*/', i + 2) < 0 ? limit : text.indexOf('*/', i + 2) + 1;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) {
        push(start, i);
        return { args: out, end: i };
      }
    } else if (c === ',' && depth === 1) {
      push(start, i);
      start = i + 1;
    }
  }
  return null;
}

/** A Python keyword argument's value (`model="gpt-5"`), with where it starts; undefined when the call doesn't give it. */
function kwarg(args: ReadonlyArray<{ text: string; at: number }>, key: string): { text: string; at: number } | undefined {
  for (const a of args) {
    const m = new RegExp(`^${key}\\s*=(?!=)\\s*`).exec(a.text);
    if (m) return { text: a.text.slice(m[0].length), at: a.at + m[0].length };
  }
  return undefined;
}

/** The arguments given by position, before any keyword or unpacked one. */
const positional = (args: ReadonlyArray<{ text: string; at: number }>) => args.filter((a) => !/^(\*|\w+\s*=(?!=))/.test(a.text));

/** A plain string literal's text (`"gpt-5"`, `'anthropic:claude-sonnet-4-5'`); null for anything else, an f-string or a variable. */
const literal = (raw: string | undefined): string | null => (raw === undefined ? null : (/^[rRuU]?(["'`])([^"'`\\\n${}]*)\1$/.exec(raw)?.[2] ?? null));

/** The calls in a Python file of the names it imports from a module (`Agent(` for `from strands import Agent`), with where each call's parenthesis opens. */
function pyCalls(text: string, imports: PyImports, module: RegExp, names: readonly string[]): Array<{ index: number; open: number; name: string; local: string; module: string }> {
  const out: Array<{ index: number; open: number; name: string; local: string; module: string }> = [];
  for (const [local, from] of imports) {
    if (!module.test(from.module) || !names.includes(from.name)) continue;
    for (const m of text.matchAll(new RegExp(`(?<![\\w.])${local}\\s*\\(`, 'g'))) {
      if (!inCommentAt(text, m.index, true) && !/\b(?:def|class)\s+$/.test(text.slice(Math.max(0, m.index - 10), m.index))) out.push({ index: m.index, open: m.index + m[0].length, name: from.name, local, module: from.module });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Where a Python name comes from: imported (`strands_tool` from strands' `tool`), or dotted (`langchain_core.tools.tool`); null for neither. */
function pyOrigin(imports: PyImports, name: string): { module: string; name: string } | null {
  const imported = imports.get(name);
  if (imported) return imported;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { module: name.slice(0, dot), name: name.slice(dot + 1) } : null;
}

/**
 * Python functions with their decorators, each decorator whole though it spans lines
 * (`@tool(\n    "lookup_order", …)`), and where the first one starts.
 */
function pyDecoratedDefs(text: string): Array<{ index: number; name: string; decorators: string[] }> {
  const out: Array<{ index: number; name: string; decorators: string[] }> = [];
  let i = 0;
  while (i < text.length) {
    const next = text.indexOf('\n', i);
    const lineEnd = next < 0 ? text.length : next;
    if (!/^[ \t]*@[\w.]+/.test(text.slice(i, lineEnd))) {
      i = lineEnd + 1;
      continue;
    }
    const decorators: string[] = [];
    let j = i;
    for (;;) {
      const d = /^[ \t]*@[\w.]+[ \t]*/.exec(text.slice(j, j + 400));
      if (!d) break;
      let end = j + d[0].length;
      if (text[end] === '(') {
        const call = scanCall(text, end + 1, true);
        if (!call) break;
        end = call.end + 1;
      }
      decorators.push(text.slice(j, end).trim());
      const nl = text.indexOf('\n', end);
      if (nl < 0) break;
      j = nl + 1;
    }
    const def = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/.exec(text.slice(j, j + 300));
    if (def && decorators.length) out.push({ index: i, name: def[1]!, decorators });
    i = j > i ? j : lineEnd + 1;
  }
  return out;
}

/** The decorators each Python framework makes a tool with, by the module they come from. */
const PY_TOOL_DECORATORS: ReadonlyArray<[RegExp, readonly string[], Framework['id']]> = [
  [/^claude_agent_sdk(\.|$)/, ['tool'], 'claude-agent-sdk-python'],
  [/^strands(\.|$)/, ['tool'], 'strands'],
  [/^smolagents(\.|$)/, ['tool'], 'smolagents'],
  [/^agno\.tools(\.|$)/, ['tool'], 'agno'],
  [/^agent_framework(\.|$)/, ['tool', 'ai_function'], 'agent-framework'],
  [/^langchain(_core)?\.(tools|agents)(\.|$)/, ['tool'], 'langchain-python'],
  [/^crewai(\.tools)?$|^crewai_tools$/, ['tool'], 'crewai'],
];

/** The classes a Python tool is a subclass of, by the module they come from: LangChain's and CrewAI's `BaseTool`. */
const PY_TOOL_CLASSES: ReadonlyArray<[RegExp, readonly string[], Framework['id']]> = [
  [/^langchain(_core)?\.tools(\.|$)/, ['BaseTool', 'StructuredTool'], 'langchain-python'],
  [/^crewai(\.tools)?(\.|$)|^crewai_tools$/, ['BaseTool'], 'crewai'],
];

/** A first guess at a tool's effect from its name (toolNameEffect). Unknown names get `write`: it never re-runs after a fork. */
export function suggestEffect(name: string): { effect: Effect; why: string } {
  const said = toolNameEffect(name);
  if (said) return { effect: said.effect, why: said.effect === 'write' ? `"${said.word}" changes something` : said.effect === 'read' ? `"${said.word}" only looks` : `"${said.word}" depends only on its input` };
  return { effect: 'write', why: 'no hint in the name; write is the safe guess, it never re-runs after a fork' };
}

/** Keys that hold an AI SDK tool without naming it: `tools: weather` is no tool called "tools". */
const NOT_TOOL_KEYS = new Set(['tools', 'tool', 'execute', 'description', 'inputSchema', 'parameters', 'outputSchema']);

/** Tool definitions in one file, by the patterns each framework uses. */
function scanTools(text: string, file: string): FoundTool[] {
  const found: FoundTool[] = [];
  const push = (name: string, index: number, via: string, effect: Effect | null, extra: { decorator?: string; className?: string } = {}) => {
    const s = suggestEffect(name);
    const tool: FoundTool = { name, file, line: lineOf(text, index), via, effect, suggested: effect ?? s.effect, why: effect ? 'declared' : s.why, ...(extra.decorator ? { decorator: extra.decorator } : {}), ...(extra.className ? { className: extra.className } : {}) };
    const same = found.findIndex((t) => t.name === name && t.via === via);
    if (same < 0) found.push(tool);
    else if (!found[same]!.effect && effect) found[same] = tool; // a wrapped definition wins over a mention
  };
  const py = file.endsWith('.py');
  const inComment = (index: number) => inCommentAt(text, index, py);
  if (py) {
    const imports = pyImports(text);
    const framework = (decorator: string, table: typeof PY_TOOL_DECORATORS) => {
      const head = /^@?([\w.]+)/.exec(decorator)?.[1];
      const o = head ? pyOrigin(imports, head) : null;
      return o ? (table.find(([module, names]) => module.test(o.module) && names.includes(o.name))?.[2] ?? null) : null;
    };
    // Decorated functions: each decorator by where it comes from.
    for (const d of pyDecoratedDefs(text)) {
      const all = d.decorators.join('\n');
      // Shadowlap's own: `@tool(effect="read")`, imported from shadowlap or (in a snippet) from nowhere.
      const declared = d.decorators
        .map((x) => {
          const o = pyOrigin(imports, /^@([\w.]+)/.exec(x)![1]!);
          return (o ? o.module === 'shadowlap' && o.name === 'tool' : /^@tool\(/.test(x)) ? /\beffect\s*=\s*["'](pure|read|write)["']/.exec(x)?.[1] : undefined;
        })
        .find(Boolean);
      const adapted = /@function_tool\([^)]*effect\s*=\s*["'](pure|read|write)["']/.exec(all);
      const own = d.decorators.map((x) => ({ x, via: framework(x, PY_TOOL_DECORATORS) })).find((h) => h.via);
      if (declared) push(d.name, d.index, 'shadowlap', declared as Effect);
      else if (adapted) push(d.name, d.index, 'openai-agents-python', adapted[1] as Effect);
      else if (own?.via === 'claude-agent-sdk-python') {
        // The model knows it by the decorator's first argument: @tool("lookup_order", "Look an order up", {...}).
        const named = /^@[\w.]+\(\s*["']([\w.-]+)["']/.exec(own.x);
        if (named) push(named[1]!, d.index, own.via, null);
      }
      // Strands and smolagents keep their own @tool over Shadowlap's: the wrap names the one found.
      else if (own) push(d.name, d.index, own.via!, null, own.via === 'strands' || own.via === 'smolagents' ? { decorator: own.x.split('(')[0] ?? own.x } : {});
      // Pydantic AI: `@agent.tool` passes a RunContext first, `@agent.tool_plain` doesn't; the wrap keeps the one found.
      else if (text.includes('pydantic_ai') && /@\w+\.tool(?:_plain)?\b/.test(all)) {
        const decorator = d.decorators.find((x) => /^@\w+\.tool(?:_plain)?\b/.test(x))?.split('\n')[0]?.trim();
        push(d.name, d.index, 'pydantic-ai', null, decorator ? { decorator } : {});
      }
      else if (/@function_tool\b/.test(all)) push(d.name, d.index, 'openai-agents-python', null);
      else if (/@(?:tool|langchain_core\.tools\.tool)\b/.test(all) && /langchain|crewai/.test(text)) push(d.name, d.index, /crewai/.test(text) ? 'crewai' : 'langchain-python', null);
    }
    // Tools defined as classes, LangChain's and CrewAI's BaseTool: named by their `name` attribute.
    for (const m of text.matchAll(/^class[ \t]+(\w+)[ \t]*\(([^)]*)\)[ \t]*:/gm)) {
      const via = m[2]!
        .split(',')
        .map((b) => framework(b.trim().replace(/\[[\s\S]*$/, ''), PY_TOOL_CLASSES))
        .find(Boolean);
      if (!via) continue;
      const after = text.slice(m.index + m[0].length);
      const body = /^[^\n]*\n((?:[ \t]+[^\n]*\n|[ \t]*\n)*)/.exec(after)?.[1] ?? '';
      const indent = /^([ \t]+)\S/m.exec(body)?.[1] ?? '    ';
      const named = new RegExp(`^${indent}name[ \\t]*(?::[^=\\n]+)?=[ \\t]*["']([^"'\\n]+)["']`, 'm').exec(body);
      if (named) push(named[1]!, m.index, via, null, { className: m[1]! });
    }
    // Their effects, given where they're used (with_effect(search_web, "read")), are read for the whole project: see declaredEffects.
    return found;
  }
  // @shadowlap/sdk: tool('name', { effect: 'read' }, impl)
  if (text.includes('@shadowlap/sdk')) for (const m of text.matchAll(/\btool\(\s*['"`]([\w.-]+)['"`]\s*,\s*\{[^}]*?effect:\s*['"`](pure|read|write)['"`]/g)) push(m[1]!, m.index, 'shadowlap', m[2] as Effect);
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
    for (const m of text.matchAll(/(?:^|[\s,{])['"]?([A-Za-z_][\w-]*)['"]?\s*:\s*tool\(\s*\{/gm)) if (!inComment(m.index + m[0].indexOf('tool('))) push(m[1]!, m.index + m[0].indexOf(m[1]!), 'ai-sdk', wrappedEffect(m.index, m.index + m[0].length, m.index + m[0].length, m[1]!));
    // A tool kept in a constant, `const searchDocs = tool({ … })`, then given as `tools: { searchDocs }`
    // or `tools: { search_docs: searchDocs }`: the model knows it by the key that names it there.
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*tool\(\s*\{/g)) {
      if (inComment(m.index + m[0].lastIndexOf('tool('))) continue;
      const variable = m[1]!;
      const keys = [...text.matchAll(new RegExp(`(?:^|[\\s,{])['"]?([A-Za-z_][\\w-]*)['"]?\\s*:\\s*${variable.replace(/\$/g, '\\$')}(?![\\w$(])`, 'gm'))].map((k) => k[1]!);
      const name = keys.find((k) => k !== variable && !NOT_TOOL_KEYS.has(k)) ?? variable;
      push(name, m.index + m[0].indexOf(variable), 'ai-sdk', wrappedEffect(m.index, m.index + m[0].length, m.index + m[0].length, name));
    }
  }
  const byName = (call: RegExp, key: 'name' | 'id', via: string) => {
    for (const m of text.matchAll(call)) {
      if (inComment(m.index)) continue;
      const window = text.slice(m.index, m.index + 1500);
      const named = new RegExp(`\\b${key}:\\s*['"\`]([\\w.-]+)['"\`]`).exec(window);
      if (named) push(named[1]!, m.index, via, wrappedEffect(m.index, m.index + m[0].length, m.index + named.index + named[0].length, named[1]!));
    }
  };
  if (text.includes('@openai/agents')) byName(/\btool\(/g, 'name', 'openai-agents');
  if (text.includes('@mastra/core')) byName(/\bcreateTool\(/g, 'id', 'mastra');
  if (text.includes('@langchain/core/tools')) byName(/\btool\(/g, 'name', 'langchain');
  if (/betaZodTool|betaTool/.test(text)) byName(/\bbeta(?:Zod)?Tool\(/g, 'name', 'anthropic-tool-runner');
  // The Claude Agent SDK's tools for an in-process MCP server: tool('lookup_order', 'Look an order up', schema, handler).
  // Their effects are given where the server is made, withEffects('orders', [...], { lookup_order: 'read' }): see declaredEffects.
  if (text.includes('@anthropic-ai/claude-agent-sdk')) for (const m of text.matchAll(/\btool\(\s*(['"`])([\w.-]+)\1\s*,\s*['"`]/g)) if (!inComment(m.index)) push(m[2]!, m.index, 'claude-agent-sdk', null);
  return found;
}

/**
 * Effects given where tools are used rather than where they're defined, read across the project:
 * `with_effect(search_web, "read")` and `with_effect(SendEmail(), "write")` (LangChain, CrewAI) in the
 * tool's own file or one that imports it, and the Claude Agent SDK's `withEffects('orders', [...],
 * { lookup_order: 'read' })` (`with_effects` in Python), whose map names each tool.
 */
function declaredEffects(tools: FoundTool[], texts: ReadonlyArray<readonly [string, string]>, cwd: string): void {
  const declare = (t: FoundTool, effect: Effect) => Object.assign(t, { effect, suggested: effect, why: 'declared' });
  for (const [path, text] of texts) {
    const file = rel(cwd, path);
    const py = file.endsWith('.py');
    if (py && text.includes('with_effect(')) {
      const imports = pyImports(text);
      for (const m of text.matchAll(/\bwith_effect\(\s*(\w+)\s*(?:\(\s*\))?\s*,\s*["'](pure|read|write)["']/g)) {
        if (inCommentAt(text, m.index, true)) continue;
        const t = tools.find((x) => !x.effect && x.file.endsWith('.py') && (x.className ?? x.name) === m[1] && (x.file === file || imports.has(m[1])));
        if (t) declare(t, m[2] as Effect);
      }
    }
    const map = py ? /\bwith_effects\(\s*["'][\w.-]+["']\s*,[\s\S]{0,2000}?\{([^}]*)\}\s*\)/g : /\bwithEffects\(\s*['"`][\w.-]+['"`]\s*,[\s\S]{0,2000}?\{([^}]*)\}\s*\)/g;
    if (!(py ? text.includes('shadowlap.adapters.claude_agent_sdk') : text.includes('@shadowlap/adapters/claude-agent-sdk'))) continue;
    for (const m of text.matchAll(map)) {
      for (const pair of m[1]!.matchAll(/['"`]?([\w.-]+)['"`]?\s*:\s*(?:['"`](pure|read|write)['"`]|\{\s*['"`]?effect['"`]?\s*:\s*['"`](pure|read|write)['"`])/g)) {
        const t = tools.find((x) => !x.effect && x.name === pair[1] && x.via === (py ? 'claude-agent-sdk-python' : 'claude-agent-sdk'));
        if (t) declare(t, (pair[2] ?? pair[3]) as Effect);
      }
    }
  }
}

/** The Python agents that take plain functions as tools, by the module they come from, and the framework each is. */
const PY_TOOL_LISTS: ReadonlyArray<[RegExp, readonly string[], Framework['id']]> = [
  [/^pydantic_ai(\.|$)/, ['Agent'], 'pydantic-ai'],
  [/^google\.adk(\.|$)/, ['Agent', 'LlmAgent'], 'google-adk'],
  [/^agent_framework(\.|$)/, ['Agent', 'ChatAgent'], 'agent-framework'],
  [/^agno\.(agent|team)(\.|$)/, ['Agent', 'Team'], 'agno'],
  [/^llama_index\.core\.agent(\.|$)/, ['FunctionAgent', 'ReActAgent', 'CodeActAgent'], 'llamaindex'],
];

/**
 * Plain functions given to an agent as its tools, `Agent(tools=[search_web, send_email])` (Pydantic
 * AI, Google ADK, Microsoft Agent Framework, Agno, LlamaIndex's agents, and a MAF client's
 * `as_agent(tools=[…])`), and LlamaIndex's `FunctionTool.from_defaults(fn=send_email)`: each is
 * found where its function is defined, in the same file or the one it is imported from, and only
 * then; a name that resolves to no `def` (another agent, a tool object) is passed over.
 */
function scanToolLists(texts: ReadonlyArray<readonly [string, string]>, cwd: string, found: readonly FoundTool[]): FoundTool[] {
  const py = texts.filter(([f]) => f.endsWith('.py'));
  const defs = new Map<string, Array<{ file: string; text: string; index: number }>>();
  for (const [path, text] of py) for (const m of text.matchAll(/^(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm)) defs.set(m[1]!, [...(defs.get(m[1]!) ?? []), { file: rel(cwd, path), text, index: m.index }]);
  const out: FoundTool[] = [];
  for (const [path, text] of py) {
    const file = rel(cwd, path);
    const imports = pyImports(text);
    const given: Array<[string, Framework['id']]> = [];
    const fromList = (value: { text: string; at: number } | undefined, via: Framework['id']) => {
      if (!value?.text.startsWith('[')) return;
      for (const item of callArguments(text, value.at + 1, true) ?? []) {
        const fn = /^(\w+)$/.exec(item.text) ?? /^(?:Tool|FunctionTool)\(\s*(?:func(?:tion)?\s*=\s*)?(\w+)\s*[,)]/.exec(item.text) ?? /^FunctionTool\.from_defaults\(\s*(?:(?:async_)?fn\s*=\s*)?(\w+)\s*[,)]/.exec(item.text);
        if (fn) given.push([fn[1]!, via]);
      }
    };
    for (const [module, names, via] of PY_TOOL_LISTS) for (const call of pyCalls(text, imports, module, names)) fromList(kwarg(callArguments(text, call.open, true) ?? [], 'tools'), via);
    if ([...imports.values()].some((i) => /^agent_framework(\.|$)/.test(i.module))) {
      for (const m of text.matchAll(/\.(?:as_agent|create_agent)\s*\(/g)) if (!inCommentAt(text, m.index, true)) fromList(kwarg(callArguments(text, m.index + m[0].length, true) ?? [], 'tools'), 'agent-framework');
    }
    if ([...imports.values()].some((i) => /^llama_index(\.|$)/.test(i.module))) {
      for (const m of text.matchAll(/\bFunctionTool\.from_defaults\s*\(/g)) {
        if (inCommentAt(text, m.index, true)) continue;
        const args = callArguments(text, m.index + m[0].length, true) ?? [];
        const fn = kwarg(args, 'fn') ?? kwarg(args, 'async_fn') ?? positional(args)[0];
        if (fn && /^\w+$/.test(fn.text)) given.push([fn.text, 'llamaindex']);
      }
    }
    for (const [name, via] of given) {
      // Defined here, or imported from the one other file that defines it.
      const candidates = defs.get(name) ?? [];
      const def = candidates.find((d) => d.file === file) ?? (imports.has(name) && candidates.length === 1 ? candidates[0] : undefined);
      if (!def || [...found, ...out].some((t) => t.name === name && t.file === def.file)) continue;
      const s = suggestEffect(name);
      out.push({ name, file: def.file, line: lineOf(def.text, def.index), via, effect: null, suggested: s.effect, why: s.why });
    }
  }
  return out;
}

/** Model clients constructed with a literal base URL: `shadowlap run` cannot redirect them. */
function scanBaseUrls(text: string, file: string): BaseUrlWarning[] {
  const out: BaseUrlWarning[] = [];
  const re = file.endsWith('.py') ? /\bbase_url\s*=\s*["'](https?:\/\/[^"']+)["']/g : /\bbaseURL\s*:\s*['"`](https?:\/\/[^'"`$]+)['"`]/g;
  for (const m of text.matchAll(re)) {
    // `baseURL: process.env.OPENAI_BASE_URL ?? '…'` is fine; only a bare literal bypasses the environment.
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const line = text.slice(lineStart, text.indexOf('\n', m.index) === -1 ? undefined : text.indexOf('\n', m.index));
    if (/process\.env|os\.environ|getenv|BASE_URL/.test(line)) continue;
    const before = text.slice(Math.max(0, m.index - 300), m.index);
    const client = /Anthropic/.test(before) ? 'anthropic' : /OpenAI/.test(before) ? 'openai' : /GoogleGenAI|genai/.test(before) ? 'gemini' : null;
    out.push({ file, line: lineOf(text, m.index), url: m[1]!, client });
  }
  return out;
}

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
const FRAMEWORK_NAMES: Readonly<Record<Framework['id'], string>> = {
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
 * Shadowlap doesn't record. `source` says where it came from, as the provider's `via`.
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
 * Shadowlap doesn't record, undefined when the string doesn't say.
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
 * or null for a module whose model classes all call a host Shadowlap doesn't record.
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
function scanModels(text: string, file: string): { named: NamedModel[]; defaults: Array<{ provider: Provider['id']; source: string }> } {
  const named: NamedModel[] = [];
  const defaults: Array<{ provider: Provider['id']; source: string }> = [];
  const add = (index: number, model: string, provider: Provider['id'] | null | undefined, via: Framework['id'], source: string) => {
    if (provider !== undefined && !named.some((n) => n.model === model && n.via === via)) named.push({ file, line: lineOf(text, index), model, provider, via, source });
  };
  const py = file.endsWith('.py');
  if (!py) {
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
    return { named, defaults };
  }
  const imports = pyImports(text);
  const uses = (module: RegExp) => [...imports.values()].some((i) => module.test(i.module));
  const idOf = (args: ReadonlyArray<{ text: string; at: number }>) => literal((kwarg(args, 'model') ?? kwarg(args, 'model_id') ?? kwarg(args, 'id') ?? kwarg(args, 'model_name') ?? positional(args)[0])?.text);
  // Model classes: Claude(id=…) from agno.models.anthropic, LiteLlm(model="openai/gpt-5") from google.adk.models.
  for (const [local, from] of imports) {
    const entry = PY_MODEL_CLASSES.find(([module]) => module.test(from.module));
    if (!entry) continue;
    const [, via, classes] = entry;
    const kind = classes === null ? (/^[A-Z]\w*$/.test(from.name) && !NOT_A_MODEL.test(from.name) ? null : undefined) : classes[from.name];
    if (kind === undefined) continue;
    for (const call of pyCalls(text, new Map([[local, from]]), /./, [from.name])) {
      const id = idOf(callArguments(text, call.open, true) ?? []);
      if (kind === 'litellm' || kind === 'crewai') {
        if (id) add(call.index, id, stringProvider(id, kind), via, `${frameworkName(via)} model: ${id}`);
      } else add(call.index, id ?? from.name, kind, via, `${frameworkName(via)} model: ${from.name} (${from.module})`);
    }
  }
  // Pydantic AI: Agent("anthropic:claude-sonnet-4-5").
  if (uses(/^pydantic_ai(\.|$)/)) for (const m of text.matchAll(PYDANTIC_MODEL)) if (!inCommentAt(text, m.index, true)) add(m.index, m[0].slice(1, -1), PYDANTIC_RECORDED[m[2]!] ?? null, 'pydantic-ai', `Pydantic AI model: ${m[0].slice(1, -1)}`);
  // LangChain: init_chat_model("anthropic:claude-sonnet-4-5"), or with model_provider="anthropic".
  for (const call of pyCalls(text, imports, /^langchain(\.|$)/, ['init_chat_model'])) {
    const args = callArguments(text, call.open, true) ?? [];
    const model = literal((kwarg(args, 'model') ?? positional(args)[0])?.text);
    const provider = literal(kwarg(args, 'model_provider')?.text);
    const full = provider && model ? `${provider}:${model}` : model;
    if (full) add(call.index, full, stringProvider(full, 'langchain'), 'langchain-python', `LangChain model: ${full}`);
  }
  // CrewAI: an agent's llm="anthropic/claude-sonnet-4-5", or none, its default (OpenAI's) unless a config file may name one.
  if (uses(/^crewai(\.|$)/)) {
    for (const m of text.matchAll(/\b(?:llm|manager_llm|function_calling_llm|planning_llm)\s*=\s*(["'])([^"'\n]+)\1/g)) if (!inCommentAt(text, m.index, true)) add(m.index, m[2]!, stringProvider(m[2]!, 'crewai'), 'crewai', `CrewAI model: ${m[2]!}`);
    for (const call of pyCalls(text, imports, /^crewai(\.agent)?$/, ['Agent'])) {
      const args = callArguments(text, call.open, true) ?? [];
      if (!kwarg(args, 'llm') && !kwarg(args, 'config') && !args.some((a) => a.text.startsWith('**'))) defaults.push({ provider: 'openai', source: 'CrewAI default model: OpenAI' });
    }
  }
  // Google ADK: LlmAgent(model="gemini-2.5-flash"), resolved by ADK's registry.
  for (const call of pyCalls(text, imports, /^google\.adk(\.|$)/, ['Agent', 'LlmAgent'])) {
    const model = literal(kwarg(callArguments(text, call.open, true) ?? [], 'model')?.text);
    if (model) add(call.index, model, stringProvider(model, 'adk'), 'google-adk', `Google ADK model: ${model}`);
  }
  // Agno: Agent(model="anthropic:claude-sonnet-4-5"), or no model, its default, OpenAI's Responses API.
  for (const call of pyCalls(text, imports, /^agno\.(agent|team)(\.|$)/, ['Agent', 'Team'])) {
    const args = callArguments(text, call.open, true) ?? [];
    const model = kwarg(args, 'model');
    const given = literal(model?.text);
    const key = given ? /^([\w-]+):/.exec(given)?.[1] : undefined;
    if (given && key) add(call.index, given, AGNO_RECORDED[key] ?? null, 'agno', `Agno model: ${given}`);
    else if (!model && !args.some((a) => a.text.startsWith('**'))) defaults.push({ provider: 'openai', source: 'Agno default model: OpenAIResponses' });
  }
  // Strands: a string is a Bedrock model id, and no model is Strands' default, on Bedrock.
  for (const call of pyCalls(text, imports, /^strands(\.agent)?$/, ['Agent'])) {
    const args = callArguments(text, call.open, true) ?? [];
    const model = kwarg(args, 'model') ?? positional(args)[0];
    const given = literal(model?.text);
    if (given) add(call.index, given, 'bedrock', 'strands', `Strands Agents model: ${given}`);
    else if (!model && !args.some((a) => a.text.startsWith('**'))) defaults.push({ provider: 'bedrock', source: 'Strands Agents default model: Bedrock' });
  }
  return { named, defaults };
}

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
function findModelServer(cwd: string, env: NodeJS.ProcessEnv, texts: Array<[string, string]>, providers: readonly Provider[], frameworks: readonly Framework[]): InitReport['modelServer'] {
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

type NodeManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
type PythonManager = 'uv' | 'poetry' | 'pip';

/** The Node package manager a folder's lockfile belongs to, if it has one. */
function lockfileManager(dir: string): NodeManager | null {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  if (existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, 'npm-shrinkwrap.json'))) return 'npm';
  return null;
}

/** The package manager package.json declares for Corepack: `"packageManager": "pnpm@9.12.0"`. */
function declaredManager(pkg: Record<string, unknown> | null): NodeManager | null {
  const m = typeof pkg?.packageManager === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager) : null;
  return m ? (m[1] as NodeManager) : null;
}

/**
 * The folders above `cwd` a workspace holding it could be declared in, nearest first: up to the
 * repository's root (the first one with `.git`), and, outside a repository, never the home folder
 * or above it, where a stray lockfile says nothing about the project.
 */
function workspaceFolders(cwd: string, home: string = homedir()): string[] {
  const out: string[] = [];
  let dir = resolve(cwd);
  if (existsSync(join(dir, '.git'))) return out;
  const top = resolve(home);
  for (let up = dirname(dir); up !== dir; dir = up, up = dirname(up)) {
    const holdsHome = relative(up, top);
    if (!holdsHome || (!holdsHome.startsWith('..') && !isAbsolute(holdsHome))) break;
    out.push(up);
    if (existsSync(join(up, '.git'))) break;
  }
  return out;
}

/**
 * Whether a workspace's patterns (`apps/*`, `packages/**`, `!apps/legacy`) take in the folder at
 * `rel` from its root.
 */
function inWorkspace(rel: string, patterns: readonly string[]): boolean {
  const path = rel.split(sep).join('/');
  const matches = (pattern: string) => {
    const glob = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');
    return new RegExp(`^${re}$`).test(path);
  };
  const include = patterns.filter((p) => !p.startsWith('!'));
  return include.some(matches) && !patterns.filter((p) => p.startsWith('!')).some((p) => matches(p.slice(1)));
}

/** The `packages` pnpm-workspace.yaml lists, as a block (`- 'apps/*'`) or a flow sequence (`["apps/*"]`). */
function pnpmPackages(text: string): string[] {
  const head = /^packages\s*:[ \t]*([^\n]*)$/m.exec(text);
  if (!head) return [];
  const inline = head[1]!.replace(/\s+#.*$/, '').trim();
  if (inline.startsWith('[')) return [...inline.slice(1, inline.lastIndexOf(']')).matchAll(/"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g)].map((m) => (m[1] ?? m[2] ?? m[3]!).trim());
  const out: string[] = [];
  for (const line of text.slice(head.index + head[0].length).split('\n').slice(1)) {
    const item = /^\s*-\s*(?:"([^"]*)"|'([^']*)'|([^#\s][^#]*?))\s*(?:#.*)?$/.exec(line);
    if (item) out.push(item[1] ?? item[2] ?? item[3]!);
    else if (line.trim() && !line.trim().startsWith('#')) break;
  }
  return out;
}

/**
 * The Node package manager of the workspace `cwd` is a package of, from its root up the tree:
 * pnpm's pnpm-workspace.yaml, or `workspaces` in package.json (Yarn, npm, Bun), whose manager the
 * root's packageManager field or lockfile names. Null when no workspace takes the folder in.
 */
function nodeWorkspaceManager(cwd: string): NodeManager | null {
  for (const dir of workspaceFolders(cwd)) {
    const rel = relative(dir, resolve(cwd));
    const pnpm = join(dir, 'pnpm-workspace.yaml');
    if (existsSync(pnpm)) {
      // A pnpm-workspace.yaml that lists no packages still makes pnpm the manager below it.
      const listed = pnpmPackages(readText(pnpm));
      if (!listed.length || inWorkspace(rel, listed)) return 'pnpm';
    }
    const root = readJson(join(dir, 'package.json'));
    const ws = root?.workspaces;
    const patterns = Array.isArray(ws) ? ws : ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages) ? (ws as { packages: unknown[] }).packages : [];
    if (inWorkspace(rel, patterns.filter((p): p is string => typeof p === 'string'))) return declaredManager(root) ?? lockfileManager(dir) ?? 'npm';
  }
  return null;
}

/** The `[tool.uv.workspace]` table of a pyproject.toml, without its header; null when it has none. */
function uvWorkspaceTable(text: string): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() === '[tool.uv.workspace]');
  if (at < 0) return null;
  const end = lines.findIndex((line, i) => i > at && line.trim().startsWith('['));
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
}

/** Whether a uv workspace above `cwd` lists it among its `members` (and doesn't `exclude` it). */
function inUvWorkspace(cwd: string): boolean {
  for (const dir of workspaceFolders(cwd)) {
    const table = uvWorkspaceTable(readText(join(dir, 'pyproject.toml')));
    if (table === null) continue;
    const rel = relative(dir, resolve(cwd));
    if (inWorkspace(rel, [...tomlRequirements(table, ['members']), ...tomlRequirements(table, ['exclude']).map((e) => `!${e}`)])) return true;
  }
  return false;
}

/**
 * How the Python side is installed and run: uv with a uv.lock here or as a member of a uv workspace,
 * Poetry with a poetry.lock or a `[tool.poetry]` table here, pip otherwise.
 */
function pythonManager(cwd: string): PythonManager {
  if (existsSync(join(cwd, 'uv.lock'))) return 'uv';
  if (existsSync(join(cwd, 'poetry.lock')) || /^\[tool\.poetry\]\s*$/m.test(readText(join(cwd, 'pyproject.toml')))) return 'poetry';
  return inUvWorkspace(cwd) ? 'uv' : 'pip';
}

/** A Python file run the way its project runs Python: `uv run agent.py`, `poetry run python agent.py`. */
function runPython(manager: PythonManager, file: string): string[] {
  return manager === 'uv' ? ['uv', 'run', file] : manager === 'poetry' ? ['poetry', 'run', 'python', file] : ['python', file];
}

/** The first script `pyproject.toml` declares (`[project.scripts]`, or Poetry's `[tool.poetry.scripts]`), by name. */
function pythonScript(cwd: string): { name: string; table: string } | null {
  let text: string;
  try {
    text = readUtf8(join(cwd, 'pyproject.toml'));
  } catch {
    return null;
  }
  for (const table of ['[project.scripts]', '[tool.poetry.scripts]']) {
    const at = text.split('\n').findIndex((line) => line.trim() === table);
    if (at < 0) continue;
    for (const line of text.split('\n').slice(at + 1)) {
      const t = line.trim();
      if (t.startsWith('[')) break;
      const m = /^["']?([A-Za-z0-9][\w.-]*)["']?\s*=\s*["'][^"']+["']/.exec(t);
      if (m) return { name: m[1]!, table };
    }
  }
  return null;
}

/**
 * The file package.json says the project runs from: its `bin` (the only one, or the first), then
 * its `main`. A path inside the folder that is there, as Node would find it (`lib/cli` is
 * `lib/cli.js`); null otherwise.
 */
function nodeEntry(cwd: string, pkg: Record<string, unknown> | null): { file: string; from: string } | null {
  const bin = pkg?.bin;
  const named: Array<[string, unknown]> = typeof bin === 'string' ? [['bin', bin]] : bin && typeof bin === 'object' ? Object.entries(bin as Record<string, unknown>).slice(0, 1).map(([name, file]) => [`bin.${name}`, file]) : [];
  named.push(['main', pkg?.main]);
  for (const [key, value] of named) {
    if (typeof value !== 'string' || !value.trim() || isAbsolute(value)) continue;
    const given = value.trim().replace(/^\.\//, '');
    if (given.split(/[\\/]/).includes('..')) continue;
    const file = [given, `${given}.js`, `${given}.mjs`, `${given}.cjs`].find((f) => existsSync(join(cwd, f)) && statSync(join(cwd, f)).isFile());
    if (file) return { file, from: `package.json ${key}: ${value.trim()}` };
  }
  return null;
}

/**
 * The model client a file imports, by the name it is imported as (`@anthropic-ai/sdk`, `openai`): a
 * provider's SDK, or an agent framework's model or runner. Not a framework's tools alone (`ai`'s
 * `tool`, `langchain_core`), which a module of tools imports too. Null for none.
 */
function modelImport(file: string, text: string): string | null {
  if (file.endsWith('.py')) {
    const m = /^[ \t]*(?:from[ \t]+(anthropic|openai|pydantic_ai|crewai|langgraph|langchain_(?:openai|anthropic|google_genai|google_vertexai|aws))(?:\.[\w.]+)?[ \t]+import\b|import[ \t]+(anthropic|openai)\b|from[ \t]+google[ \t]+import[ \t]+(genai)\b)/m.exec(text);
    return m ? (m[3] ? 'google-genai' : (m[1] ?? m[2])!) : null;
  }
  const m = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](@anthropic-ai\/[\w.-]+|openai|@google\/genai|@ai-sdk\/[\w.-]+|@openai\/agents|@mastra\/core|@langchain\/(?:openai|anthropic|google-genai|google-vertexai|aws|langgraph))['"]/.exec(text);
  return m ? m[1]! : null;
}

/** Where a command found by its file came from, as the setup words it: `the entry file agent.py`. */
const entryFile = (file: string) => `the entry file ${file}`;

/** Files that aren't how an agent starts, whatever they import: tests, fixtures and tool configs. */
const NOT_AN_ENTRY = /^(test_.*|.*_test\.py|.*\.(test|spec)\.[cm]?[jt]sx?|conftest\.py|setup\.py|.*\.config\.[cm]?[jt]s|.*\.d\.[cm]?ts)$/;

/**
 * The agent's file when nothing names how it starts: the one file at the top of the folder that
 * imports a model SDK or an agent framework (`triage.mjs`), and that no other file there imports.
 * Null when there are none or several, since a guess between them would only be a guess.
 */
function modelEntry(cwd: string, texts: ReadonlyArray<readonly [string, string]>, python: PythonManager): InitReport['command'] {
  const top = texts.filter(([f]) => relative(cwd, f) === basename(f) && /\.(py|[cm]?js|[cm]?ts|tsx)$/.test(f) && !NOT_AN_ENTRY.test(basename(f)));
  const calling = top.filter(([f, t]) => modelImport(f, t) !== null).map(([f]) => basename(f));
  if (calling.length !== 1) return null;
  const file = calling[0]!;
  const stem = file.replace(/\.[^.]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A module another file imports is part of the agent, not where it starts.
  const imported = file.endsWith('.py') ? new RegExp(`^[ \\t]*(?:from[ \\t]+\\.?${stem}[ \\t]+import|import[ \\t]+${stem}\\b)`, 'm') : new RegExp(`['"]\\.\\/${stem}(?:\\.[cm]?[jt]sx?)?['"]`);
  if (top.some(([f, t]) => basename(f) !== file && imported.test(t))) return null;
  const argv = file.endsWith('.py') ? runPython(python, file) : /\.([cm]?ts|tsx)$/.test(file) ? ['npx', 'tsx', file] : ['node', file];
  return { argv, from: entryFile(file) };
}

function detectCommand(cwd: string, pkg: Record<string, unknown> | null, manager: InitReport['packageManager'], python: PythonManager, languages: Language[], texts: ReadonlyArray<readonly [string, string]> = []): InitReport['command'] {
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const runner = manager === 'pnpm' ? ['pnpm'] : manager === 'yarn' ? ['yarn'] : manager === 'bun' ? ['bun', 'run'] : ['npm', 'run'];
  for (const name of ['agent', 'start', 'dev', 'run']) {
    const script = scripts[name];
    // A script that starts a web dev server or a watcher is not the agent itself, nor one that serves
    // agents and waits for requests (`mastra dev`, `mastra start`).
    if (typeof script === 'string' && !/\b(next|vite|nodemon|webpack|--watch|tsc -w|mastra\s+(?:dev|start|build))\b/.test(script)) return { argv: name === 'start' && runner[0] === 'npm' ? ['npm', 'start'] : [...runner, name], from: `package.json scripts.${name}: ${script}` };
  }
  // The file the package says it runs from, before guessing one by its name: a bin, then main.
  const entry = nodeEntry(cwd, pkg);
  if (entry) return { argv: /\.(ts|mts|cts|tsx)$/.test(entry.file) ? ['npx', 'tsx', entry.file] : ['node', entry.file], from: entry.from };
  if (languages.includes('python')) {
    // A script the project declares is how it is meant to start: `uv run research-agent`.
    const script = pythonScript(cwd);
    if (script) return { argv: python === 'pip' ? [script.name] : [python, 'run', script.name], from: `${script.table} in pyproject.toml` };
    for (const f of ['agent.py', 'main.py', 'app.py', 'run.py', 'src/agent.py', 'src/main.py']) {
      if (existsSync(join(cwd, f))) return { argv: runPython(python, f), from: entryFile(f) };
    }
  }
  for (const f of ['agent.ts', 'src/agent.ts', 'index.ts', 'src/index.ts', 'main.ts', 'src/main.ts']) {
    if (existsSync(join(cwd, f))) return { argv: ['npx', 'tsx', f], from: entryFile(f) };
  }
  for (const f of ['agent.mjs', 'agent.js', 'index.mjs', 'index.js', 'main.js', 'src/index.js']) {
    if (existsSync(join(cwd, f))) return { argv: ['node', f], from: entryFile(f) };
  }
  // Named after what it does (`triage.mjs`): the one file at the top that calls a model.
  return modelEntry(cwd, texts, python);
}

export function inspectProject(cwd: string, env: NodeJS.ProcessEnv = process.env): InitReport {
  const pkg = readJson(join(cwd, 'package.json'));
  const deps = { ...((pkg?.dependencies ?? {}) as Record<string, string>), ...((pkg?.devDependencies ?? {}) as Record<string, string>) };
  const py = pythonDependencies(cwd);
  const files = sourceFiles(cwd);
  const texts: Array<[string, string]> = files.map((f) => [f, readUtf8(f)]);

  const languages: Language[] = [];
  if (pkg || texts.some(([f]) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f))) languages.push(existsSync(join(cwd, 'tsconfig.json')) || texts.some(([f]) => /\.(ts|tsx|mts|cts)$/.test(f)) ? 'typescript' : 'javascript');
  if (py.size || existsSync(join(cwd, 'pyproject.toml')) || texts.some(([f]) => f.endsWith('.py'))) languages.push('python');

  // The folder's own lockfile, then what its package.json declares, then the workspace it is a
  // package of: in a pnpm or Yarn workspace the lockfile is at the root, and npm can't install a
  // member's `workspace:` dependencies.
  const lock = lockfileManager(cwd);
  const python = pythonManager(cwd);
  const packageManager: InitReport['packageManager'] =
    lock && lock !== 'npm'
      ? lock
      : pkg
        ? (lock ?? declaredManager(pkg) ?? nodeWorkspaceManager(cwd) ?? 'npm')
        : languages.includes('python')
          ? python
          : existsSync(join(cwd, 'uv.lock'))
            ? 'uv'
            : existsSync(join(cwd, 'poetry.lock'))
              ? 'poetry'
              : null;

  const providers: Provider[] = [];
  const addProvider = (id: Provider['id'], via: string) => {
    if (!providers.some((p) => p.id === id)) providers.push({ id, via });
  };
  for (const [name, id] of Object.entries(JS_PROVIDERS)) if (deps[name]) addProvider(id, name);
  for (const [name, id] of Object.entries(PY_PROVIDERS)) if (py.has(name)) addProvider(id, name);
  // An extra that installs a provider's SDK with a framework: `pydantic-ai-slim[openai]`. (A provider's own SDK's extras, as `anthropic[bedrock]`, add a transport, not an SDK.)
  for (const { name, extra } of pythonExtras(cwd)) if (EXTRA_PROVIDERS[extra] && !(name in PY_PROVIDERS)) addProvider(EXTRA_PROVIDERS[extra], `${name}[${extra}]`);
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
  // The models a framework names (Mastra's router, the AI SDK's string ids, LangChain's, Pydantic AI's,
  // CrewAI's, ADK's, Agno's and Strands' strings, model classes), and the default an agent built with
  // none falls back on: the framework builds the client, so no provider SDK need be a dependency.
  const models = texts.map(([f, t]) => scanModels(t, rel(cwd, f)));
  for (const { named, defaults } of models) {
    for (const m of named) if (m.provider) addProvider(m.provider, m.source);
    for (const d of defaults) addProvider(d.provider, d.source);
  }
  const unrecordedModels: UnrecordedModel[] = models.flatMap(({ named }) => named.filter((m) => !m.provider).map((m) => ({ file: m.file, line: m.line, model: m.model, via: m.via })));

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
    tools,
    hardcodedBaseUrls,
    unrecordedModels,
    modelServer: findModelServer(cwd, env, texts, providers, frameworks),
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
  'ai-gateway': ["Vercel's AI Gateway", 'captured in the process'],
};

const ADAPTER_SNIPPETS: Record<string, (name: string, effect: Effect, tool?: FoundTool) => string> = {
  'ai-sdk': (n, e) => `const tools = withEffects({ ${n}: tool({ … }) }, { ${n}: '${e}' });   // import { withEffects } from '@shadowlap/adapters/ai-sdk'`,
  'openai-agents': (n, e) => `tool(withEffect({ name: '${n}', … }, '${e}'))   // import { withEffect } from '@shadowlap/adapters/openai-agents'`,
  mastra: (n, e) => `createTool(withEffect({ id: '${n}', … }, '${e}'))   // import { withEffect } from '@shadowlap/adapters/mastra'`,
  langchain: (n, e) => `withEffect(tool(impl, { name: '${n}', … }), '${e}')   // import { withEffect } from '@shadowlap/adapters/langchain'`,
  'anthropic-tool-runner': (n, e) => `betaZodTool(withEffect({ name: '${n}', … }, '${e}'))   // import { withEffect } from '@shadowlap/adapters/anthropic'`,
  python: (n, e) => `@tool(effect="${e}") above def ${n}   # from shadowlap import tool`,
  'pydantic-ai': (n, e, t) => `${t?.decorator ?? '@agent.tool'} over @tool(effect="${e}") on def ${n}   # from shadowlap import tool`,
  'openai-agents-python': (n, e) => `@function_tool(effect="${e}") on def ${n}   # from shadowlap.adapters.openai_agents import function_tool`,
  'langchain-python': (n, e, t) => `with_effect(${t?.className ? `${t.className}()` : n}, "${e}")   # from shadowlap.adapters.langchain import with_effect`,
  crewai: (n, e, t) => `with_effect(${t?.className ? `${t.className}()` : n}, "${e}")   # from shadowlap.adapters.crewai import with_effect`,
  'claude-agent-sdk': (n, e) => `createSdkMcpServer({ …, tools: withEffects('<server>', [ … ], { ${jsKey(n)}: '${e}' }) })   // import { withEffects } from '@shadowlap/adapters/claude-agent-sdk'`,
  'claude-agent-sdk-python': (n, e) => `create_sdk_mcp_server(…, tools=with_effects("<server>", [ … ], {"${n}": "${e}"}))   # from shadowlap.adapters.claude_agent_sdk import with_effects`,
  strands: (n, e, t) => `${t?.decorator ?? '@tool'} over @tool(effect="${e}") on def ${n}   # from shadowlap import tool`,
  smolagents: (n, e, t) => `${t?.decorator ?? '@tool'} over @tool(effect="${e}") on def ${n}   # from shadowlap import tool`,
};

/**
 * What `shadowlap init` prints: what it found, then the steps to a first recording. Run by a global
 * `shadowlap` (`globalCli`), the steps use it as it is: they add only the SDKs to the project, and
 * run `shadowlap`, not `npx shadowlap`.
 */
export function formatInit(r: InitReport, p: Palette, wroteConfig: boolean, { globalCli = false }: { globalCli?: boolean } = {}): string {
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
  // Output gets pasted into issues and chats: an address with credentials is shown without them.
  const shown = r.modelServer ? modelServerFinding(r.modelServer) : null;
  const secret = !!r.modelServer && !!shown && shown.url !== r.modelServer.url;
  if (r.modelServer) out(`  Model server: ${shown?.url ?? r.modelServer.url} ${p.dim(`(${r.modelServer.from}${secret ? '; its credentials aren’t shown' : ''})`)}`);
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
  for (const m of r.unrecordedModels) {
    out(`${p.yellow('!')} ${m.file}:${m.line} names the model ${m.model} through ${m.via === 'mastra' ? "Mastra's model router" : FRAMEWORK_NAMES[m.via]}, which sends it to a host Shadowlap doesn't know, so its calls would not be recorded.`);
    out(`  ${p.dim(m.via === 'mastra' ? "Shadowlap records the router's anthropic/…, openai/…, google/… and vercel/… models." : "Declare its host in shadowlap.config.json (\"providers\") when it speaks OpenAI's, Anthropic's or Gemini's API, and its calls are recorded.")}`);
  }
  if (r.unrecordedModels.length) out();
  if (!r.providers.length) {
    out(`${p.yellow('!')} No model SDK found (Anthropic, OpenAI, Gemini, Azure OpenAI, Vertex AI, Bedrock, Vercel's AI Gateway). An HTTP client of your own is recorded when it calls one of those APIs from Node or Python, or when it reads ANTHROPIC_BASE_URL, OPENAI_BASE_URL or GOOGLE_GEMINI_BASE_URL.`);
    out();
  }
  const oldNode = tooOldNode(r);
  if (oldNode) {
    out(`${p.yellow('!')} ${nodePinWords(oldNode)}`);
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
    if (!globalCli) out(`     ${p.cyan(`${add} ${r.packageManager === 'npm' || !r.packageManager ? '--save-dev' : '-D'} shadowlap`)}`);
    out(`     ${p.cyan(`${add} @shadowlap/sdk${adapters ? ' @shadowlap/adapters' : ''}`)}   ${p.dim(adapters ? 'tool effects, through your framework' : 'tool effects, clock and randomness')}`);
  }
  if (python) {
    out(`     ${p.cyan(r.packageManager === 'uv' ? 'uv add shadowlap' : r.packageManager === 'poetry' ? 'poetry add shadowlap' : 'pip install shadowlap')}   ${p.dim('the Python SDK')}`);
    if (!ts && !globalCli) out(`     ${p.cyan('npm install --global shadowlap')}   ${p.dim('the CLI (Node 22.16 or later, not 23)')}`);
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
      if (snippet) out(`     ${p.dim('for example:')} ${snippet(example.name, example.suggested, example)}`);
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
  const upstream = r.modelServer ? `SHADOWLAP_UPSTREAM_OPENAI=${secret ? '<your model server>' : r.modelServer.upstream} ` : '';
  const cli = ts && !globalCli ? 'npx shadowlap' : 'shadowlap';
  out(`     ${p.cyan(`${upstream}${cli} run -- ${r.command ? quoteArgv(r.command.argv) : '<the command that starts your agent>'}`)}`);
  // `mastra dev` and `mastra start` serve agents and wait for requests: a run is a script that asks one.
  if (!r.command && r.frameworks.some((f) => f.id === 'mastra')) out(`     ${p.dim("Mastra's dev server waits for requests: record a script that calls an agent, await mastra.getAgent('…').generate('…'), or a test with @shadowlap/test.")}`);
  if (r.modelServer) out(`     ${p.dim(secret ? 'SHADOWLAP_UPSTREAM_OPENAI is the model server’s address without /v1, credentials included; init doesn’t print them.' : 'SHADOWLAP_UPSTREAM_OPENAI keeps your model server as the upstream; the agent talks to Shadowlap.')}`);
  out();
  head('Replay it, then change something and replay again');
  out(`     ${p.cyan(`${cli} replay <run>`)}   ${p.dim('0 upstream requests when nothing changed')}`);
  out(`     ${p.cyan(`${cli} dashboard`)}   ${p.dim('or: shadowlap ui')}`);
  out();
  out(wroteConfig ? `Created ${CONFIG_FILE} for normalizers and redaction rules.` : `${basename(r.config.path)} already exists; left as it is.`);
  return lines.join('\n');
}

/**
 * What `init` prints as a dashboard job, whose drawer sits beside the setup's own steps: only what it
 * found, a line each, as the design's drawer has it, ending on what it did with shadowlap.config.json.
 * The next steps a terminal gets are the setup's own buttons there, so they are left out.
 */
export function formatInitJob(json: InitJson, p: Palette): string {
  const lines: string[] = [];
  const s = json.summary;
  const row = (label: string, value: string, warn = false) => lines.push(`${warn ? p.yellow('!') : ' '} ${label.padEnd(13)}${value}`);
  lines.push(`▸ reading ${json.cwd} · runs nothing`);
  if (!json.languages.length) {
    lines.push(`${p.yellow('!')} No package.json, pyproject.toml or source files here: no project to inspect.`);
    return lines.join('\n');
  }
  row('language', `${s.language ?? 'not recognised'}${json.folder.files.length ? ` (${json.folder.files.join(', ')})` : ''}`);
  if (s.node?.tooOld) row('node', nodePinWords(s.node), true);
  row('model SDK', s.sdk ?? 'none found', !s.sdk);
  if (json.modelServer) row('model server', `${json.modelServer.url}   from ${json.modelServer.from}`);
  row('framework', s.framework ?? 'none detected');
  row('command', s.command ? `${s.command}   from ${s.commandFrom ?? 'the project'}` : 'none found');
  for (const t of json.tools) row('tool', t.wrapped ? `${t.name}  ${t.effect!}` : `${t.name}  not wrapped · suggest ${t.suggested} (${t.why})`, !t.wrapped);
  for (const w of json.hardcodedBaseUrls.filter((x) => !captured(x.url))) row('base URL', `${w.file}:${w.line} sets ${w.url}, a host Shadowlap doesn't know: calls through it aren't recorded`, true);
  for (const m of json.unrecordedModels) row('model', `${m.file}:${m.line} names ${m.model}: ${m.via === 'mastra' ? 'Mastra' : FRAMEWORK_NAMES[m.via]} sends it to a host Shadowlap doesn't know, so its calls aren't recorded`, true);
  lines.push(json.config.created ? `${p.green('✓')} wrote ${basename(json.config.path)} (empty)` : `  ${s.config}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// `init --json`: the findings as the dashboard's setup shows them

/** A found tool, with whether its calls are recorded. */
export type InitJsonTool = FoundTool & {
  /** Wrapped with the SDK or an adapter, its effect declared: its calls are recorded, and a fork never repeats a write. */
  wrapped: boolean;
};

/**
 * What `shadowlap init --json` prints: everything {@link inspectProject} found, plus the lines the
 * dashboard's setup shows (language, model SDK, framework, command, config), each tool flagged when
 * it isn't wrapped, and the code that wraps those, per language. Running it again re-checks: the
 * config is left as it is, and the tools are scanned afresh.
 */
export interface InitJson extends Omit<InitReport, 'tools' | 'config' | 'modelServer'> {
  config: InitReport['config'] & { created: boolean };
  /**
   * The model server the project points at, never with the credentials its address holds: those
   * are removed, and such a server has no `upstream` (record it in a terminal). This output reaches
   * the dashboard's job drawer.
   */
  modelServer: ModelServer | null;
  /** The folder as Add a project describes it. */
  folder: FolderKind;
  summary: {
    /** `Python 3.12 · uv`, `Node 22 · TypeScript · pnpm`; null when nothing was recognised. */
    language: string | null;
    /** Model SDKs with their versions: `anthropic 0.69.0`. */
    sdk: string | null;
    framework: string | null;
    command: string | null;
    commandFrom: string | null;
    /** What happened to shadowlap.config.json. */
    config: string;
    /**
     * The Node the project pins (`.nvmrc`, `.node-version`), its minor kept, and whether it is older
     * than Shadowlap's guard takes (18.18): an agent on it wouldn't start. Null without a pin.
     */
    node: { version: string; from: string; tooOld: boolean } | null;
  };
  tools: InitJsonTool[];
  /** Names of the tools that aren't wrapped: a replay runs them for real, since their calls aren't recorded. */
  unwrapped: string[];
  /** Code that wraps them, per language; empty when every tool is wrapped. */
  wrap: WrapSnippet[];
  /** What the command did for the folder's setup in the dashboard ({@link noteInspected}); `shadowlap init` always says. */
  project?: InspectedNote;
}

function readText(path: string, limit = 2 * 1024 * 1024): string {
  try {
    if (statSync(path).size > limit) return '';
    return readUtf8(path);
  } catch {
    return '';
  }
}

/** The runtime version a project pins, its minor kept: `.python-version` (3.12), `.nvmrc` or `.node-version` (18.17, or 22 for a major alone). */
function pinnedVersion(cwd: string, files: string[]): { version: string; from: string } | null {
  for (const f of files) {
    const m = /^\s*v?(\d+)(?:\.(\d+))?/.exec(readText(join(cwd, f), 4096));
    if (m) return { version: m[2] ? `${m[1]!}.${m[2]}` : m[1]!, from: f };
  }
  return null;
}

/** The Node a JavaScript or TypeScript project pins (`.nvmrc`, `.node-version`), or null. */
function nodePinOf(cwd: string, languages: readonly Language[]): { version: string; from: string } | null {
  return languages.includes('typescript') || languages.includes('javascript') ? pinnedVersion(cwd, ['.nvmrc', '.node-version']) : null;
}

/** The project's Node pin when it is older than the guard takes (AGENT_NODE_MIN), or null. */
function tooOldNode(r: Pick<InitReport, 'cwd' | 'languages'>): { version: string; from: string } | null {
  const pin = nodePinOf(r.cwd, r.languages);
  return pin && nodePinTooOld(pin.version) ? pin : null;
}

/** What `init` says of a Node pin the guard can't go into: the agent wouldn't start under Shadowlap. */
export function nodePinWords(pin: { version: string; from: string }): string {
  return `${pin.from} pins Node ${pin.version}, too old for Shadowlap's guard, which needs Node ${AGENT_NODE_MIN} or later: the agent wouldn't start. Pin ${AGENT_NODE_MIN} or later before you record.`;
}

const cleanVersion = (v: string) => v.replace(/^[\^~>=<v\s]+/, '').split(/[\s,|]/)[0]!;

/** A Python package's name as a pattern: `-`, `_` and `.` are the same to pip, in any run (PEP 503). */
const pythonName = (name: string) => name.split(/[-_.]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-_.]+');

/**
 * The version a Python requirement's specifiers name with one of `ops`: an exact pin (`==0.69.0`),
 * or the release a compatible (`~=0.69.0`) or lower bound (`>=0.69`) names. Wildcards, upper bounds
 * and exclusions name none; an environment marker after `;` is left out.
 */
function specifiedVersion(specifiers: string, ops: readonly string[]): string | null {
  const found = [...specifiers.split(';')[0]!.matchAll(/(===|==|~=|>=)\s*([0-9][\w.+!-]*)/g)];
  for (const op of ops) {
    const hit = found.find((m) => m[1] === op && !m[2]!.endsWith('*'));
    if (hit) return hit[2]!;
  }
  return null;
}

/**
 * Where a Python project declares a package, as specifier text: PEP 508 lines in requirements files
 * and `[project]` dependencies in pyproject.toml (`anthropic>=0.69`), and the value Poetry and
 * Pipfile give it (`anthropic = "^0.69.0"`, or `{ version = "^0.69.0" }`).
 */
function pythonDeclarations(cwd: string, name: string): { pep508: string[]; values: string[] } {
  // The name whole: `anthropic` is not `anthropic-bedrock`.
  const escaped = `${pythonName(name)}(?![A-Za-z0-9._-])`;
  const requirement = new RegExp(`^\\s*${escaped}\\s*(?:\\[[^\\]]*\\])?\\s*([^#]*)`, 'i');
  const pep508: string[] = [];
  for (const req of ['requirements.txt', 'requirements.in', 'requirements-dev.txt']) {
    for (const line of readText(join(cwd, req)).split('\n')) {
      const m = requirement.exec(line);
      if (m) pep508.push(m[1]!);
    }
  }
  const pyproject = readText(join(cwd, 'pyproject.toml'));
  for (const spec of tomlRequirements(pyproject, ['dependencies'])) {
    const m = requirement.exec(spec);
    if (m) pep508.push(m[1]!);
  }
  const values: string[] = [];
  const assignment = new RegExp(`^\\s*["']?${escaped}["']?\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{[^}]*\\bversion\\s*=\\s*"([^"]*)")`, 'im');
  for (const section of pyproject.matchAll(/\[tool\.poetry(?:\.group\.[\w-]+)?\.dependencies\]([\s\S]*?)(?=\n\[|$)/g)) {
    const m = assignment.exec(section[1]!);
    if (m) values.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  const pipfile = assignment.exec(readText(join(cwd, 'Pipfile')));
  if (pipfile) values.push(pipfile[1] ?? pipfile[2] ?? pipfile[3] ?? '');
  return { pep508, values };
}

/**
 * A package's version: installed (Node), pinned in a lockfile (Python), or as the project declares
 * it: package.json's range, a requirement's pin or lower bound, Poetry's or Pipfile's value.
 */
function packageVersion(cwd: string, name: string): string | null {
  const installed = installedVersion(cwd, name);
  if (installed) return installed;
  const pkg = readJson(join(cwd, 'package.json'));
  const declared = ((pkg?.dependencies ?? {}) as Record<string, string>)[name] ?? ((pkg?.devDependencies ?? {}) as Record<string, string>)[name];
  if (typeof declared === 'string' && /\d/.test(declared)) return cleanVersion(declared);
  const escaped = pythonName(name);
  for (const lock of ['uv.lock', 'poetry.lock', 'pdm.lock']) {
    const m = new RegExp(`\\bname\\s*=\\s*"${escaped}"\\s*\\nversion\\s*=\\s*"([^"]+)"`, 'i').exec(readText(join(cwd, lock)));
    if (m) return m[1]!;
  }
  const { pep508, values } = pythonDeclarations(cwd, name);
  // Poetry's `^0.69.0` and `~0.69` name their lowest release, as a lower bound does.
  const specs = [...pep508, ...values.map((v) => (/(?:===|==|~=|>=)/.test(v) ? v : `>=${cleanVersion(v)}`))];
  // An exact pin wherever it is declared, then a bound.
  for (const ops of [['===', '=='], ['~=', '>=']]) {
    for (const s of specs) {
      const version = specifiedVersion(s, ops);
      if (version) return version;
    }
  }
  return null;
}

function languageLine(cwd: string, r: InitReport, folder: FolderKind): string | null {
  const parts: string[] = [];
  const python = r.languages.includes('python');
  const node = r.languages.includes('typescript') || r.languages.includes('javascript');
  if (python) parts.push(['Python', pinnedVersion(cwd, ['.python-version'])?.version].filter(Boolean).join(' '));
  if (node) parts.push(['Node', pinnedVersion(cwd, ['.nvmrc', '.node-version'])?.version].filter(Boolean).join(' '));
  if (r.languages.includes('typescript')) parts.push('TypeScript');
  if (!parts.length) return folder.kind;
  // With both, the folder knows a manager for each side; the report keeps one.
  const managers = python && node ? folder.managers : r.packageManager ? [r.packageManager] : [];
  return [...parts, ...managers].join(' · ');
}

const jsKey = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`);
const camel = (name: string) => name.replace(/[-_.]+(\w)/g, (_, c: string) => c.toUpperCase()).replace(/^[^A-Za-z_$]+/, '') || 'myTool';

/** One block per framework, each with its own import, for the tools of one language. */
function wrapCode(language: WrapSnippet['language'], tools: FoundTool[]): string {
  const groups = new Map<string, FoundTool[]>();
  for (const t of tools) groups.set(t.via, [...(groups.get(t.via) ?? []), t]);
  const blocks: string[] = [];
  for (const [via, list] of groups) {
    if (language === 'python') {
      const def = (decorators: string[], t: FoundTool) => `${decorators.join('\n')}\ndef ${t.name}(…):\n    …`;
      if (via === 'openai-agents-python') blocks.push(['from shadowlap.adapters.openai_agents import function_tool', '', list.map((t) => def([`@function_tool(effect="${t.suggested}")`], t)).join('\n\n')].join('\n'));
      else if (via === 'langchain-python' || via === 'crewai') blocks.push([`from shadowlap.adapters.${via === 'crewai' ? 'crewai' : 'langchain'} import with_effect`, '', `tools = [${list.map((t) => `with_effect(${t.className ? `${t.className}()` : t.name}, "${t.suggested}")`).join(', ')}]`].join('\n'));
      else if (via === 'pydantic-ai') blocks.push(['from shadowlap import tool', '', list.map((t) => def([t.decorator ?? '@agent.tool', `@tool(effect="${t.suggested}")`], t)).join('\n\n')].join('\n'));
      // Strands and smolagents keep their own @tool over Shadowlap's.
      else if (via === 'strands' || via === 'smolagents') blocks.push(['from shadowlap import tool', '', list.map((t) => def([t.decorator ?? '@tool', `@tool(effect="${t.suggested}")`], t)).join('\n\n')].join('\n'));
      else if (via === 'claude-agent-sdk-python') blocks.push(['from shadowlap.adapters.claude_agent_sdk import with_effects', '', `tools = with_effects("<server>", [ … ], {${list.map((t) => `"${t.name}": "${t.suggested}"`).join(', ')}})`].join('\n'));
      else blocks.push(['from shadowlap import tool', '', list.map((t) => def([`@tool(effect="${t.suggested}")`], t)).join('\n\n')].join('\n'));
      continue;
    }
    const adapter = (module: string, line: (t: FoundTool) => string) => blocks.push([`import { withEffect } from '@shadowlap/adapters/${module}';`, '', ...list.map(line)].join('\n'));
    if (via === 'ai-sdk') blocks.push([`import { withEffects } from '@shadowlap/adapters/ai-sdk';`, '', `const tools = withEffects({ … }, { ${list.map((t) => `${jsKey(t.name)}: '${t.suggested}'`).join(', ')} });`].join('\n'));
    else if (via === 'openai-agents') adapter('openai-agents', (t) => `tool(withEffect({ name: '${t.name}', … }, '${t.suggested}'));`);
    else if (via === 'mastra') adapter('mastra', (t) => `createTool(withEffect({ id: '${t.name}', … }, '${t.suggested}'));`);
    else if (via === 'langchain') adapter('langchain', (t) => `withEffect(tool(…, { name: '${t.name}', … }), '${t.suggested}');`);
    else if (via === 'anthropic-tool-runner') adapter('anthropic', (t) => `betaZodTool(withEffect({ name: '${t.name}', … }, '${t.suggested}'));`);
    else if (via === 'claude-agent-sdk') blocks.push([`import { withEffects } from '@shadowlap/adapters/claude-agent-sdk';`, '', `const tools = withEffects('<server>', [ … ], { ${list.map((t) => `${jsKey(t.name)}: '${t.suggested}'`).join(', ')} });`].join('\n'));
    else blocks.push([`import { tool } from '@shadowlap/sdk';`, '', ...list.map((t) => `export const ${camel(t.name)} = tool('${t.name}', { effect: '${t.suggested}' }, async (args) => { … });`)].join('\n'));
  }
  return blocks.join('\n\n');
}

/** Code that wraps the tools that aren't, with the suggested effect declared, per language. */
export function wrapSnippets(tools: readonly FoundTool[]): WrapSnippet[] {
  const byLanguage = new Map<WrapSnippet['language'], FoundTool[]>();
  for (const t of tools) {
    if (t.effect) continue;
    const language: WrapSnippet['language'] = t.file.endsWith('.py') ? 'python' : /\.(ts|tsx|mts|cts)$/.test(t.file) ? 'typescript' : 'javascript';
    byLanguage.set(language, [...(byLanguage.get(language) ?? []), t]);
  }
  return [...byLanguage].map(([language, list]) => ({ language, tools: list.map((t) => t.name), code: wrapCode(language, list) }));
}

export function initJson(r: InitReport, wroteConfig: boolean): InitJson {
  const folder = describeFolder(r.cwd);
  const sdkNames = [...new Set(r.providers.map((p) => p.via.replace(/, imported$/, '')))];
  const sdk = sdkNames.map((n) => {
    const version = /^(@[\w.-]+\/)?[\w.-]+$/.test(n) ? packageVersion(r.cwd, n) : null;
    return version ? `${n} ${version}` : n;
  });
  const configName = basename(r.config.path);
  const node = nodePinOf(r.cwd, r.languages);
  return {
    ...r,
    config: { ...r.config, created: wroteConfig },
    // Addresses found in the project's files may hold a password or a key: never printed here.
    modelServer: r.modelServer ? modelServerFinding(r.modelServer) : null,
    hardcodedBaseUrls: r.hardcodedBaseUrls.map((w) => ({ ...w, url: modelServerFinding({ url: w.url, from: '' })?.url ?? w.url })),
    folder,
    summary: {
      language: languageLine(r.cwd, r, folder),
      sdk: sdk.length ? sdk.join(', ') : null,
      framework: r.frameworks.length ? r.frameworks.map((f) => (f.version ? `${f.name} ${cleanVersion(f.version)}` : f.name)).join(', ') : null,
      command: r.command ? quoteArgv(r.command.argv) : null,
      commandFrom: r.command?.from ?? null,
      config: wroteConfig ? `wrote an empty ${configName}` : r.config.existed ? `${configName} exists · left as it is` : `no ${configName} written: no project found here`,
      node: node ? { ...node, tooOld: nodePinTooOld(node.version) === true } : null,
    },
    tools: r.tools.map((t) => ({ ...t, wrapped: t.effect !== null })),
    unwrapped: r.tools.filter((t) => !t.effect).map((t) => t.name),
    wrap: wrapSnippets(r.tools),
  };
}

/** The findings as the project list keeps them for the dashboard's setup. */
export function initFindings(json: InitJson, at: number = Date.now()): SetupFindings {
  return {
    at,
    language: json.summary.language,
    files: json.folder.files,
    sdk: json.summary.sdk,
    framework: json.summary.framework,
    command: json.command?.argv ?? null,
    commandFrom: json.command?.from ?? null,
    config: { file: basename(json.config.path), created: json.config.created, existed: json.config.existed },
    // A wrapped tool shows the effect it declares; one that isn't, the effect suggested for it.
    tools: json.tools.map((t) => ({ name: t.name, effect: t.effect ?? t.suggested, wrapped: t.wrapped, why: t.effect ? 'declared' : t.why, file: t.file, line: t.line })),
    wrap: json.wrap,
    // Recording from the dashboard forwards there, as init tells a terminal to; never with credentials.
    modelServer: json.modelServer ? modelServerFinding({ url: json.modelServer.url, upstream: json.modelServer.upstream, from: json.modelServer.from }) : null,
    // The setup's first step flags one older than the guard takes, and Record waits for it.
    nodePin: json.summary.node ? { version: json.summary.node.version, from: json.summary.node.from } : null,
  };
}

/** What `init` did for the dashboard's setup of the folder: `project` in `init --json`, and in the result a dashboard job hears. */
export interface InspectedNote {
  /** The project the folder is in the dashboard; null when it isn't one, or the project list can't be read. */
  id: string | null;
  /** The setup's first step took these findings. */
  noted: boolean;
  /** Why it didn't, when the folder is a project (the list was busy, or written by a newer Shadowlap) or the list can't be read. */
  why: string | null;
}

/**
 * When the folder is a project in the dashboard, its setup's first step is done: the findings go
 * into the project list, so the setup shows them, in the dashboard or after `init` in a terminal.
 * Outside a project this reads the list and changes nothing. It never fails `init`, and says what
 * happened, so a dashboard job can explain a step that didn't move.
 */
export function noteInspected(cwd: string, json: InitJson, env: NodeJS.ProcessEnv = process.env, options: Pick<RegistryOptions, 'lockTimeoutMs' | 'home'> = {}): InspectedNote {
  let registry: ProjectRegistry;
  let id: string | null;
  try {
    registry = new ProjectRegistry({ env, ...options });
    id = registry.find(cwd)?.id ?? null;
  } catch (err) {
    return { id: null, noted: false, why: (err as Error).message };
  }
  if (!id) return { id: null, noted: false, why: null };
  try {
    registry.noteInspected(id, initFindings(json));
    return { id, noted: true, why: null };
  } catch (err) {
    return { id, noted: false, why: (err as Error).message };
  }
}
