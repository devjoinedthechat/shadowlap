import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { plain } from '@shadowlap/engine';
import { formatInit, inspectProject, suggestEffect, writeInitialConfig } from '../src/init.js';
import { CONFIG_SCHEMA_URL } from '../src/config.js';

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'fp-init-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const palette = { ...plain, cyan: (s: string) => s };

describe('shadowlap init', () => {
  const ts = project({
    'package.json': JSON.stringify({ name: 'support-agent', scripts: { dev: 'next dev', agent: 'tsx src/agent.ts' }, dependencies: { ai: '^7.0.0', '@ai-sdk/anthropic': '^3.0.0', '@shadowlap/adapters': '^0.1.0', zod: '^4.0.0' } }),
    'pnpm-lock.yaml': '',
    'tsconfig.json': '{}',
    'src/tools.ts': `import { tool } from 'ai';
import { withEffects } from '@shadowlap/adapters/ai-sdk';
// A tool( in a comment is not a definition, and neither is send_everything: tool({ in one.
export const tools = withEffects(
  {
    search_web: tool({ description: 'Search', inputSchema, execute: async ({ query }) => search(query) }),
  },
  { search_web: 'read' },
);
`,
    'src/admin.ts': `import { tool } from 'ai';
export const adminTools = {
  delete_record: tool({ description: 'Delete a record', inputSchema, execute: async ({ id }) => db.delete(id) }),
  calculateTotal: tool({ description: 'Sum', inputSchema, execute: async ({ items }) => sum(items) }),
};
`,
    'src/llm.ts': `import Anthropic from '@anthropic-ai/sdk';
export const client = new Anthropic({ baseURL: 'https://llm-proxy.internal/anthropic' });
export const other = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com' });
`,
    'node_modules/ai/package.json': JSON.stringify({ name: 'ai', version: '7.0.103' }),
    'node_modules/ai/dist/index.js': "export const tool = (x) => x; // tool({ should not be scanned",
  });

  it('reads a TypeScript project: package manager, SDKs, framework, command, tools and base URLs', () => {
    const r = inspectProject(ts, {});
    expect(r.languages).toEqual(['typescript']);
    expect(r.packageManager).toBe('pnpm');
    expect(r.providers).toEqual([{ id: 'anthropic', via: '@ai-sdk/anthropic' }]);
    expect(r.frameworks).toEqual([{ id: 'ai-sdk', name: 'Vercel AI SDK', package: 'ai', version: '7.0.103', adapter: 'ai-sdk' }]);
    // `dev` starts a web server, so the agent script is the one to record.
    expect(r.command).toEqual({ argv: ['pnpm', 'agent'], from: 'package.json scripts.agent: tsx src/agent.ts' });
    expect(r.tools.map((t) => [t.name, t.file, t.effect, t.suggested])).toEqual([
      ['delete_record', 'src/admin.ts', null, 'write'],
      ['calculateTotal', 'src/admin.ts', null, 'pure'],
      ['search_web', 'src/tools.ts', 'read', 'read'],
    ]);
    expect(r.hardcodedBaseUrls).toEqual([{ file: 'src/llm.ts', line: 2, url: 'https://llm-proxy.internal/anthropic', client: 'anthropic' }]);
    expect(r.scannedFiles).toBe(3);

    const text = formatInit(r, palette, true);
    expect(text).toContain('Framework: Vercel AI SDK 7.0.103');
    expect(text).toContain('Tools: 3 found, 1 with an effect');
    expect(text).toContain("src/llm.ts:2 sets the model base URL to https://llm-proxy.internal/anthropic. Shadowlap doesn't know that host");
    expect(text).toContain('Run with SHADOWLAP_UPSTREAM_ANTHROPIC=https://llm-proxy.internal/anthropic, or read the base URL from ANTHROPIC_BASE_URL.');
    expect(text).toContain('pnpm add -D shadowlap');
    expect(text).toContain('pnpm add @shadowlap/sdk @shadowlap/adapters');
    expect(text).toMatch(/delete_record\s+write\s+"delete" changes something/);
    expect(text).toContain("withEffects({ delete_record: tool({ … }) }, { delete_record: 'write' })");
    expect(text).toContain('npx shadowlap run -- pnpm agent');
  });

  it('leaves the CLI out of the install step when a global shadowlap runs it, and runs that one', () => {
    const text = formatInit(inspectProject(ts, {}), palette, true, { globalCli: true });
    expect(text).not.toContain('add -D shadowlap');
    expect(text).toContain('pnpm add @shadowlap/sdk @shadowlap/adapters');
    expect(text).toContain('     shadowlap run -- pnpm agent');
    expect(text).not.toContain('npx shadowlap');
    const py = inspectProject(project({ 'pyproject.toml': '[project]\nname = "triage"\ndependencies = ["anthropic>=0.40"]\n', 'agent.py': 'import anthropic\n' }), {});
    expect(formatInit(py, palette, true)).toContain('npm install --global shadowlap');
    const global = formatInit(py, palette, true, { globalCli: true });
    expect(global).toContain('pip install shadowlap');
    expect(global).not.toContain('npm install --global shadowlap');
  });

  it('finds AI SDK tools kept in constants, named by the key that gives them to the model', () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'docs-agent', dependencies: { ai: '^7.0.0', '@ai-sdk/openai': '^3.0.0', '@shadowlap/adapters': '^0.1.0' } }),
      'src/agent.ts': `import { generateText, tool } from 'ai';
import { withEffects } from '@shadowlap/adapters/ai-sdk';

const searchDocs = tool({ description: 'Search the docs', inputSchema, execute: async ({ q }) => search(q) });
export const sendReply: Tool = tool({ description: 'Reply to the customer', inputSchema, execute: async ({ text }) => reply(text) });
const lookupOrder = tool({ description: 'Look an order up', inputSchema, execute: async ({ id }) => orders.get(id) });
// const draftNote = tool({ is a thought, not a tool
await generateText({ model, tools: { searchDocs, reply_to_customer: sendReply, ...withEffects({ lookupOrder }, { lookupOrder: 'read' }) } });
`,
    });
    const r = inspectProject(dir, {});
    // Shorthand keeps the constant's name; a key names the tool the model sees.
    expect(r.tools.map((t) => [t.name, t.line, t.effect, t.suggested])).toEqual([
      ['searchDocs', 4, null, 'read'],
      ['reply_to_customer', 5, null, 'write'],
      ['lookupOrder', 6, 'read', 'read'],
    ]);
    const text = formatInit(r, palette, true);
    expect(text).toContain('Tools: 3 found, 1 with an effect');
    expect(text).toContain("withEffects({ searchDocs: tool({ … }) }, { searchDocs: 'read' })");
  });

  it("reads a Mastra project as create-mastra lays it out: the router's models, its tools, and no server for a command", () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'weather', type: 'module', scripts: { dev: 'mastra dev', build: 'mastra build', start: 'mastra start' }, dependencies: { '@mastra/core': '^1.67.0', zod: '^4.0.0' }, devDependencies: { mastra: '^1.0.0' } }),
      'tsconfig.json': '{}',
      'src/mastra/tools/weather-tool.ts': `import { createTool } from '@mastra/core/tools';
export const weatherTool = createTool({ id: 'get-weather', description: 'Weather', inputSchema, execute: async ({ location }) => getWeather(location) });
`,
      'src/mastra/agents/weather-agent.ts': `import { Agent } from '@mastra/core/agent';
import { weatherTool } from '../tools/weather-tool';
// model: 'xai/grok-4' in a comment names nothing.
export const weatherAgent = new Agent({ id: 'weather-agent', name: 'Weather', instructions: '…', model: process.env.MODEL ?? 'anthropic/claude-sonnet-4-5', tools: { weatherTool } });
export const backup = new Agent({ id: 'backup', name: 'Backup', instructions: '…', model: 'google/gemini-2.5-flash' });
export const fast = new Agent({ id: 'fast', name: 'Fast', instructions: '…', model: 'groq/llama-3.3-70b-versatile' });
`,
      'src/mastra/index.ts': "import { Mastra } from '@mastra/core/mastra';\nexport const mastra = new Mastra({});\n",
    });
    const r = inspectProject(dir, {});
    // No provider SDK is a dependency: the router builds the clients from the models' router ids.
    expect(r.providers).toEqual([
      { id: 'anthropic', via: 'Mastra model router: anthropic/claude-sonnet-4-5' },
      { id: 'gemini', via: 'Mastra model router: google/gemini-2.5-flash' },
    ]);
    expect(r.unrecordedModels).toEqual([{ file: 'src/mastra/agents/weather-agent.ts', line: 6, model: 'groq/llama-3.3-70b-versatile', via: 'mastra' }]);
    // `mastra dev` and `mastra start` serve the agents and wait for requests: neither is a run.
    expect(r.command).toBeNull();
    expect(r.tools.map((t) => [t.name, t.via, t.suggested])).toEqual([['get-weather', 'mastra', 'read']]);
    const text = formatInit(r, palette, false);
    expect(text).toContain('Model SDKs: Anthropic (Mastra model router: anthropic/claude-sonnet-4-5), Gemini (Mastra model router: google/gemini-2.5-flash)');
    expect(text).not.toContain('No model SDK found');
    expect(text).toContain("src/mastra/agents/weather-agent.ts:6 names the model groq/llama-3.3-70b-versatile through Mastra's model router");
    expect(text).toContain("record a script that calls an agent, await mastra.getAgent('…').generate('…')");
    // A script that runs the agent is the command, though its path names Mastra.
    const scripted = project({ 'package.json': JSON.stringify({ scripts: { agent: 'tsx src/mastra/run.ts', dev: 'mastra dev' }, dependencies: { '@mastra/core': '^1.67.0' } }) });
    expect(inspectProject(scripted, {}).command?.argv).toEqual(['npm', 'run', 'agent']);
  });

  it("names Vercel's AI Gateway for an AI SDK agent that names its model by a string, and not for Mastra's router", () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'support', type: 'module', dependencies: { ai: '^7.0.0', zod: '^4.0.0' } }),
      'agent.mjs': `import { generateText, stepCountIs } from 'ai';
// model: 'xai/grok-4' in a comment names nothing.
const result = await generateText({ model: process.env.MODEL ?? 'openai/gpt-5', prompt: 'Refund A-1.', stopWhen: stepCountIs(4) });
`,
    });
    const r = inspectProject(dir, {});
    expect(r.providers).toEqual([{ id: 'ai-gateway', via: 'AI SDK model id: openai/gpt-5' }]);
    const text = formatInit(r, palette, false);
    expect(text).toContain("Model SDKs: Vercel's AI Gateway (AI SDK model id: openai/gpt-5)");
    expect(text).not.toContain('No model SDK found');
    // A Mastra agent's string is its model router's, which builds the provider's own client.
    const mastra = project({ 'package.json': JSON.stringify({ dependencies: { '@mastra/core': '^1.67.0', ai: '^7.0.0' } }), 'agent.ts': "import { Agent } from '@mastra/core/agent';\nimport { tool } from 'ai';\nexport const a = new Agent({ id: 'a', name: 'A', instructions: '…', model: 'openai/gpt-5' });\n" });
    expect(inspectProject(mastra, {}).providers).toEqual([{ id: 'openai', via: 'Mastra model router: openai/gpt-5' }]);
  });

  describe('every framework the docs name', () => {
    const found = (files: Record<string, string>) => {
      const r = inspectProject(project(files), {});
      return { r, tools: r.tools.map((t) => ({ name: t.name, via: t.via, effect: t.effect, suggested: t.suggested, ...(t.decorator ? { decorator: t.decorator } : {}), ...(t.className ? { className: t.className } : {}) })), text: formatInit(r, palette, false) };
    };

    it("Strands: its @tool over Shadowlap's, and Bedrock, its default model", () => {
      const { r, tools, text } = found({
        'requirements.txt': 'strands-agents==1.62.0\n',
        'agent.py': 'from strands import Agent, tool as strands_tool\n\n@strands_tool\ndef send_email(to: str) -> str:\n    """Send."""\n    ...\n\nagent = Agent(tools=[send_email])\n',
      });
      expect(r.frameworks.map((f) => f.id)).toEqual(['strands']);
      expect(r.providers).toEqual([{ id: 'bedrock', via: 'Strands Agents default model: Bedrock' }]);
      expect(tools).toEqual([{ name: 'send_email', via: 'strands', effect: null, suggested: 'write', decorator: '@strands_tool' }]);
      expect(text).toContain('@strands_tool over @tool(effect="write") on def send_email');
      expect(text).not.toContain('No model SDK found');
    });

    it('Agno: a model class, a model string Shadowlap does not record, and plain functions as tools', () => {
      const { r, tools, text } = found({
        'requirements.txt': 'agno\n',
        'agent.py': 'from agno.agent import Agent\nfrom agno.models.anthropic import Claude\n\ndef search_web(query: str) -> str:\n    ...\n\nagent = Agent(model=Claude(id="claude-sonnet-4-5"), tools=[search_web])\nfast = Agent(model="groq:llama-3.3-70b-versatile", tools=[search_web])\n',
      });
      expect(r.frameworks.map((f) => f.id)).toEqual(['agno']);
      expect(r.providers).toEqual([{ id: 'anthropic', via: 'Agno model: Claude (agno.models.anthropic)' }]);
      expect(r.unrecordedModels).toEqual([{ file: 'agent.py', line: 8, model: 'groq:llama-3.3-70b-versatile', via: 'agno' }]);
      expect(tools).toEqual([{ name: 'search_web', via: 'agno', effect: null, suggested: 'read' }]);
      expect(text).toContain('agent.py:8 names the model groq:llama-3.3-70b-versatile through Agno');
    });

    it("Google ADK: Gemini from the model it names, and the functions it is given", () => {
      const { r, tools } = found({
        'requirements.txt': 'google-adk==2.12.0\n',
        'agent.py': 'from google.adk.agents import LlmAgent\n\ndef search_web(query: str) -> dict:\n    ...\n\nroot_agent = LlmAgent(name="support", model="gemini-2.5-flash", tools=[search_web])\n',
      });
      expect(r.frameworks.map((f) => f.id)).toEqual(['google-adk']);
      expect(r.providers).toEqual([{ id: 'gemini', via: 'Google ADK model: gemini-2.5-flash' }]);
      expect(tools).toEqual([{ name: 'search_web', via: 'google-adk', effect: null, suggested: 'read' }]);
    });

    it('LlamaIndex: its LLM package, and FunctionTool.from_defaults', () => {
      const { r, tools } = found({
        'requirements.txt': 'llama-index-core\nllama-index-llms-anthropic\n',
        'agent.py': 'from llama_index.core.agent.workflow import FunctionAgent\nfrom llama_index.core.tools import FunctionTool\nfrom llama_index.llms.anthropic import Anthropic\n\ndef send_email(to: str) -> str:\n    ...\n\nagent = FunctionAgent(tools=[FunctionTool.from_defaults(fn=send_email)], llm=Anthropic(model="claude-sonnet-4-5"))\n',
      });
      expect(r.frameworks.map((f) => f.id)).toEqual(['llamaindex']);
      expect(r.providers.map((p) => p.id)).toEqual(['anthropic']);
      expect(tools).toEqual([{ name: 'send_email', via: 'llamaindex', effect: null, suggested: 'write' }]);
    });

    it("Microsoft Agent Framework: its OpenAI client, and a client's as_agent tools", () => {
      const { r, tools } = found({
        'requirements.txt': 'agent-framework-core\nagent-framework-openai\n',
        'agent.py': 'from agent_framework.openai import OpenAIChatClient\n\ndef send_email(to: str) -> str:\n    ...\n\nagent = OpenAIChatClient().as_agent(instructions="Help.", tools=[send_email])\n',
      });
      expect(r.frameworks.map((f) => f.id)).toEqual(['agent-framework']);
      expect(r.providers.map((p) => p.id)).toEqual(['openai']);
      expect(tools).toEqual([{ name: 'send_email', via: 'agent-framework', effect: null, suggested: 'write' }]);
    });

    it("smolagents: its default model, Hugging Face's, named as a host Shadowlap doesn't know", () => {
      const { r, tools, text } = found({
        'requirements.txt': 'smolagents\n',
        'agent.py': 'from smolagents import CodeAgent, InferenceClientModel, tool as smol_tool\n\n@smol_tool\ndef send_email(to: str) -> str:\n    """Send.\n\n    Args:\n        to: The address.\n    """\n    ...\n\nagent = CodeAgent(tools=[send_email], model=InferenceClientModel())\n',
      });
      expect(r.frameworks.map((f) => f.id)).toEqual(['smolagents']);
      expect(r.unrecordedModels.map((m) => [m.model, m.via])).toEqual([['InferenceClientModel', 'smolagents']]);
      expect(tools).toEqual([{ name: 'send_email', via: 'smolagents', effect: null, suggested: 'write', decorator: '@smol_tool' }]);
      expect(text).toContain('Declare its host in shadowlap.config.json');
    });

    it('the Claude Agent SDK, in Python and TypeScript: its in-process MCP tools, by the name the model knows them by, and their effects where the server is made', () => {
      const py = found({
        'requirements.txt': 'claude-agent-sdk\n',
        'agent.py': 'from claude_agent_sdk import create_sdk_mcp_server, tool\n\n@tool("lookup_order", "Look an order up", {"order_id": str})\nasync def lookup(args):\n    ...\n\norders = create_sdk_mcp_server(name="orders", version="1.0.0", tools=[lookup])\n',
      });
      expect(py.r.frameworks.map((f) => f.id)).toEqual(['claude-agent-sdk-python']);
      expect(py.r.providers.map((p) => p.id)).toEqual(['anthropic']);
      expect(py.tools).toEqual([{ name: 'lookup_order', via: 'claude-agent-sdk-python', effect: null, suggested: 'read' }]);
      expect(py.text).toContain('with_effects("<server>", [ … ], {"lookup_order": "read"})');
      const ts = found({
        'package.json': JSON.stringify({ dependencies: { '@anthropic-ai/claude-agent-sdk': '^0.3.0', '@shadowlap/adapters': '^0.1.0' } }),
        'agent.ts': "import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';\nimport { withEffects } from '@shadowlap/adapters/claude-agent-sdk';\nconst refund = tool('refund_order', 'Refund an order', schema, handler);\nexport const orders = createSdkMcpServer({ name: 'orders', version: '1.0.0', tools: withEffects('orders', [refund], { refund_order: 'write' }) });\n",
      });
      expect(ts.r.frameworks.map((f) => f.id)).toEqual(['claude-agent-sdk']);
      expect(ts.r.providers).toEqual([{ id: 'anthropic', via: '@anthropic-ai/claude-agent-sdk' }]);
      expect(ts.tools).toEqual([{ name: 'refund_order', via: 'claude-agent-sdk', effect: 'write', suggested: 'write' }]);
    });

    it("Pydantic AI, LangChain and CrewAI: the providers their model strings name, CrewAI's default, and BaseTool classes", () => {
      const pydantic = found({ 'requirements.txt': 'pydantic-ai-slim\n', 'agent.py': 'from pydantic_ai import Agent\n\nagent = Agent("anthropic:claude-sonnet-4-5")\n' });
      expect(pydantic.r.providers).toEqual([{ id: 'anthropic', via: 'Pydantic AI model: anthropic:claude-sonnet-4-5' }]);
      const langchain = found({ 'requirements.txt': 'langchain\nlanggraph\n', 'agent.py': 'from langchain.chat_models import init_chat_model\n\nmodel = init_chat_model("claude-sonnet-4-5", model_provider="anthropic")\n' });
      expect(langchain.r.providers).toEqual([{ id: 'anthropic', via: 'LangChain model: anthropic:claude-sonnet-4-5' }]);
      const crew = found({
        'requirements.txt': 'crewai\n',
        'crew.py': 'from crewai import Agent\nfrom crewai.tools import BaseTool\nfrom shadowlap.adapters.crewai import with_effect\n\nclass SendEmail(BaseTool):\n    name: str = "send_email"\n    description: str = "Email the team"\n\n    def _run(self, to: str) -> str:\n        ...\n\nwriter = Agent(role="Writer", goal="Write", backstory="…", tools=[with_effect(SendEmail(), "write")])\nresearcher = Agent(role="Researcher", goal="Find", backstory="…", llm="groq/llama-3.3-70b-versatile")\n',
      });
      expect(crew.r.providers).toEqual([{ id: 'openai', via: 'CrewAI default model: OpenAI' }]);
      expect(crew.r.unrecordedModels.map((m) => [m.model, m.via])).toEqual([['groq/llama-3.3-70b-versatile', 'crewai']]);
      expect(crew.tools).toEqual([{ name: 'send_email', via: 'crewai', effect: 'write', suggested: 'write', className: 'SendEmail' }]);
    });
  });

  it('writes an empty configuration once and never overwrites one', () => {
    const r = inspectProject(ts, {});
    expect(writeInitialConfig(r)).toBe(true);
    // The $schema line is the point of writing the file at all: completion from the first edit.
    expect(JSON.parse(readFileSync(join(ts, 'shadowlap.config.json'), 'utf8'))).toEqual({ $schema: CONFIG_SCHEMA_URL, normalize: [], redact: [] });
    writeFileSync(join(ts, 'shadowlap.config.json'), '{"normalize":[{"path":"$.system"}],"redact":[]}');
    const again = inspectProject(ts, {});
    expect(again.config.existed).toBe(true);
    expect(writeInitialConfig(again)).toBe(false);
    expect(readFileSync(join(ts, 'shadowlap.config.json'), 'utf8')).toContain('$.system');
    expect(formatInit(again, palette, false)).toContain('shadowlap.config.json already exists; left as it is.');
  });

  it('reads a Python project: uv, Pydantic AI, decorated tools and a local model server', () => {
    const py = project({
      'pyproject.toml': '[project]\nname = "triage"\ndependencies = [\n  "pydantic-ai-slim[openai]>=2.0",\n  "openai>=1",\n]\n',
      'uv.lock': '',
      '.env': 'OPENAI_BASE_URL=http://localhost:11434/v1\n',
      'agent.py': `from pydantic_ai import Agent, RunContext
from shadowlap import tool

agent = Agent("openai:qwen2.5:7b")

@agent.tool
async def fetch_page(ctx: RunContext[None], url: str) -> str:
    return await ctx.deps.get(url)

@agent.tool_plain
@tool(effect="write", on_fork=lambda to: {"sent": False})
def send_page(to: str) -> dict:
    ...
`,
    });
    const r = inspectProject(py, {});
    expect(r.languages).toEqual(['python']);
    expect(r.packageManager).toBe('uv');
    expect(r.providers.map((p) => p.id)).toEqual(['openai']);
    expect(r.frameworks.map((f) => f.id)).toEqual(['pydantic-ai']);
    expect(r.command).toEqual({ argv: ['uv', 'run', 'agent.py'], from: 'the entry file agent.py' });
    expect(r.tools.map((t) => [t.name, t.via, t.effect, t.suggested])).toEqual([
      ['fetch_page', 'pydantic-ai', null, 'read'],
      ['send_page', 'shadowlap', 'write', 'write'],
    ]);
    expect(r.modelServer).toEqual({ url: 'http://localhost:11434/v1', upstream: 'http://localhost:11434', from: 'OPENAI_BASE_URL in .env' });
    const text = formatInit(r, palette, true);
    expect(text).toContain('uv add shadowlap');
    expect(text).toContain('npm install --global shadowlap');
    expect(text).toContain('@agent.tool over @tool(effect="read") on def fetch_page');
    expect(text).toContain('SHADOWLAP_UPSTREAM_OPENAI=http://localhost:11434 shadowlap run -- uv run agent.py');
  });

  it('starts a Python project by the script its pyproject.toml declares', () => {
    const scripted = (manifest: string, lock: Record<string, string>) => inspectProject(project({ 'pyproject.toml': manifest, ...lock, 'main.py': 'print(1)\n' }), {}).command;
    const declared = '[project]\nname = "research-agent"\n\n[project.scripts]\nresearch-agent = "research_agent.main:run"\n';
    expect(scripted(declared, { 'uv.lock': '' })).toEqual({ argv: ['uv', 'run', 'research-agent'], from: '[project.scripts] in pyproject.toml' });
    expect(scripted(declared, {})).toEqual({ argv: ['research-agent'], from: '[project.scripts] in pyproject.toml' });
    expect(scripted('[tool.poetry]\nname = "x"\n\n[tool.poetry.scripts]\nagent = "x.cli:main"\n', { 'poetry.lock': '' })).toEqual({ argv: ['poetry', 'run', 'agent'], from: '[tool.poetry.scripts] in pyproject.toml' });
    // Without one, the entry file.
    expect(scripted('[project]\nname = "x"\n', { 'uv.lock': '' })).toEqual({ argv: ['uv', 'run', 'main.py'], from: 'the entry file main.py' });
  });

  it('names the package manager of the workspace a package belongs to, and how it runs Python', () => {
    const at = (files: Record<string, string>, member: string) => {
      const r = inspectProject(join(project(files), member), {});
      return { pm: r.packageManager, argv: r.command?.argv, text: formatInit(r, palette, false) };
    };
    // pnpm: the lockfile and pnpm-workspace.yaml are at the root, never in the member.
    const pnpm = at({ 'package.json': '{"name":"root","private":true}', 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n", 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'apps/agent/package.json': JSON.stringify({ name: 'agent', scripts: { start: 'tsx src/index.ts' }, dependencies: { '@anthropic-ai/sdk': '^0.60.0', '@repo/lib': 'workspace:*' } }), 'apps/agent/src/index.ts': "import Anthropic from '@anthropic-ai/sdk';\n" }, 'apps/agent');
    expect(pnpm).toMatchObject({ pm: 'pnpm', argv: ['pnpm', 'start'] });
    expect(pnpm.text).toContain('pnpm add -D shadowlap');
    expect(pnpm.text).toContain('run -- pnpm start');
    // Yarn and npm: `workspaces` in the root package.json, the lockfile beside it.
    const yarnRoot = { 'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*'] }), 'yarn.lock': '# yarn lockfile v1\n', 'apps/bot/package.json': JSON.stringify({ name: 'bot', scripts: { start: 'node bot.js' }, dependencies: { openai: '^5.0.0' } }), 'apps/bot/bot.js': "const OpenAI = require('openai');\n" };
    const yarn = at(yarnRoot, 'apps/bot');
    expect(yarn).toMatchObject({ pm: 'yarn', argv: ['yarn', 'start'] });
    expect(yarn.text).toContain('yarn add -D shadowlap');
    const { 'yarn.lock': _lock, ...unlocked } = yarnRoot;
    expect(at({ ...unlocked, 'package.json': JSON.stringify({ name: 'root', workspaces: { packages: ['apps/**'] } }), 'bun.lock': '{}' }, 'apps/bot').pm).toBe('bun');
    expect(at(unlocked, 'apps/bot').pm).toBe('npm');
    // The packageManager field Corepack reads, at the root or in the package.
    expect(at({ ...unlocked, 'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'], packageManager: 'pnpm@9.12.0' }) }, 'apps/bot').pm).toBe('pnpm');
    expect(at({ ...yarnRoot, 'apps/bot/package.json': JSON.stringify({ name: 'bot', packageManager: 'yarn@4.5.0', scripts: { start: 'node bot.js' } }) }, 'apps/bot').pm).toBe('yarn');
    // A folder the workspace doesn't take in, or its own lockfile, keeps its own manager.
    expect(at({ ...yarnRoot, 'tools/script/package.json': JSON.stringify({ name: 'script' }) }, 'tools/script').pm).toBe('npm');
    expect(at({ ...yarnRoot, 'apps/bot/package-lock.json': '{}' }, 'apps/bot').pm).toBe('npm');
    // uv: [tool.uv.workspace] and uv.lock at the root; the member runs with uv run.
    const uv = at({ 'pyproject.toml': '[tool.uv.workspace]\nmembers = ["agents/*"]\n', 'uv.lock': 'version = 1\n', 'agents/triage/pyproject.toml': '[project]\nname = "triage"\nversion = "0.1.0"\ndependencies = ["anthropic>=0.40"]\n', 'agents/triage/agent.py': 'import anthropic\n' }, 'agents/triage');
    expect(uv).toMatchObject({ pm: 'uv', argv: ['uv', 'run', 'agent.py'] });
    expect(uv.text).toContain('uv add shadowlap');
    // Nothing above the repository's root counts.
    expect(at({ 'pnpm-workspace.yaml': "packages: ['repo/**']\n", 'pnpm-lock.yaml': '', 'repo/.git/HEAD': 'ref: refs/heads/main\n', 'repo/app/package.json': '{"name":"app"}' }, 'repo/app').pm).toBe('npm');
  });

  it('runs a Poetry project’s entry file with poetry run, as it does a script it declares', () => {
    const poetry = '[tool.poetry]\nname = "f"\nversion = "0.1.0"\n\n[tool.poetry.dependencies]\npython = "^3.11"\nanthropic = "^0.40"\n';
    const locked = inspectProject(project({ 'pyproject.toml': poetry, 'poetry.lock': '# poetry lock\n', 'agent.py': 'import anthropic\n' }), {});
    expect(locked.packageManager).toBe('poetry');
    expect(locked.command).toEqual({ argv: ['poetry', 'run', 'python', 'agent.py'], from: 'the entry file agent.py' });
    const text = formatInit(locked, palette, false);
    expect(text).toContain('poetry add shadowlap');
    expect(text).toContain('shadowlap run -- poetry run python agent.py');
    // Before its first lock, [tool.poetry] says the same; a file found by what it imports runs the same way.
    const unlocked = inspectProject(project({ 'pyproject.toml': poetry, 'triage.py': 'from anthropic import Anthropic\n' }), {});
    expect(unlocked.packageManager).toBe('poetry');
    expect(unlocked.command).toEqual({ argv: ['poetry', 'run', 'python', 'triage.py'], from: 'the entry file triage.py' });
  });

  it('starts a Node project by the file its package.json names, before guessing one by its name', () => {
    const started = (pkg: Record<string, unknown>, more: Record<string, string> = {}) => inspectProject(project({ 'package.json': JSON.stringify({ name: 'triage-bot', ...pkg }), 'agent.js': 'export const runAgent = () => {};\n', 'main.js': 'console.log(1)\n', ...more }), {}).command;
    // agent.js only exports the agent; main.js, which package.json names, runs it.
    expect(started({ main: 'main.js' })).toEqual({ argv: ['node', 'main.js'], from: 'package.json main: main.js' });
    expect(started({ main: './lib/run' }, { 'lib/run.js': '' })).toEqual({ argv: ['node', 'lib/run.js'], from: 'package.json main: ./lib/run' });
    expect(started({ bin: { triage: 'cli.mjs', other: 'other.js' }, main: 'main.js' }, { 'cli.mjs': '' })).toEqual({ argv: ['node', 'cli.mjs'], from: 'package.json bin.triage: cli.mjs' });
    expect(started({ bin: 'src/cli.ts' }, { 'src/cli.ts': '' })).toEqual({ argv: ['npx', 'tsx', 'src/cli.ts'], from: 'package.json bin: src/cli.ts' });
    // A start script still comes first; a file that isn't there, or outside the folder, is passed over.
    expect(started({ main: 'main.js', scripts: { start: 'node agent.js' } })).toEqual({ argv: ['npm', 'start'], from: 'package.json scripts.start: node agent.js' });
    expect(started({ main: 'gone.js' })).toEqual({ argv: ['node', 'agent.js'], from: 'the entry file agent.js' });
    expect(started({ main: '../elsewhere/main.js' })).toEqual({ argv: ['node', 'agent.js'], from: 'the entry file agent.js' });
  });

  it('starts an agent named after what it does by the one file at the top that calls a model', () => {
    const command = (files: Record<string, string>) => inspectProject(project(files), {}).command;
    const pkg = JSON.stringify({ name: 'triage-bot', type: 'module', dependencies: { '@anthropic-ai/sdk': '^0.126.0' } });
    const triage = "import Anthropic from '@anthropic-ai/sdk';\nimport { label } from './labels.mjs';\n";
    expect(command({ 'package.json': pkg, 'triage.mjs': triage, 'labels.mjs': 'export const label = 1;\n', 'triage.test.mjs': "import Anthropic from '@anthropic-ai/sdk';\n" })).toEqual({ argv: ['node', 'triage.mjs'], from: 'the entry file triage.mjs' });
    expect(command({ 'tsconfig.json': '{}', 'digest.ts': "import { GoogleGenAI } from '@google/genai';\n" })).toEqual({ argv: ['npx', 'tsx', 'digest.ts'], from: 'the entry file digest.ts' });
    expect(command({ 'uv.lock': '', 'bot.py': 'from anthropic import Anthropic\n' })).toEqual({ argv: ['uv', 'run', 'bot.py'], from: 'the entry file bot.py' });
    expect(command({ 'requirements.txt': 'openai\n', 'bot.py': 'import openai\n' })).toEqual({ argv: ['python', 'bot.py'], from: 'the entry file bot.py' });
    // Two that call a model, one another file imports, one in a folder below, or tools alone: no guess.
    expect(command({ 'package.json': pkg, 'triage.mjs': triage, 'digest.mjs': "import OpenAI from 'openai';\n" })).toBeNull();
    expect(command({ 'package.json': pkg, 'llm.mjs': "import Anthropic from '@anthropic-ai/sdk';\n", 'run.mjs': "import { ask } from './llm.mjs';\n" })).toBeNull();
    expect(command({ 'requirements.txt': 'openai\n', 'llm.py': 'import openai\n', 'cli.py': 'from llm import ask\n' })).toBeNull();
    expect(command({ 'package.json': pkg, 'src/triage.mjs': triage })).toBeNull();
    expect(command({ 'package.json': pkg, 'tools.ts': "import { tool } from 'ai';\n" })).toBeNull();
  });

  it('takes OPENAI_BASE_URL as the model server only for a project with an OpenAI client, or SDKs it can’t tell', () => {
    const env = { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' };
    const found = { url: 'http://127.0.0.1:11434/v1', upstream: 'http://127.0.0.1:11434', from: 'OPENAI_BASE_URL in your environment' };
    const anthropic = { 'package.json': JSON.stringify({ name: 'triage-bot', dependencies: { '@anthropic-ai/sdk': '^0.126.0' } }), 'agent.mjs': "import Anthropic from '@anthropic-ai/sdk';\n" };
    // Its calls go to Anthropic's API, wherever OPENAI_BASE_URL points: in the environment or in .env.
    expect(inspectProject(project(anthropic), env).modelServer).toBeNull();
    expect(inspectProject(project({ ...anthropic, '.env': 'OPENAI_BASE_URL=http://127.0.0.1:11434/v1\n' }), {}).modelServer).toBeNull();
    const openai = { 'package.json': JSON.stringify({ name: 'triage-bot', dependencies: { openai: '^6.0.0' } }), 'agent.mjs': "import OpenAI from 'openai';\n" };
    expect(inspectProject(project(openai), env).modelServer).toEqual(found);
    expect(inspectProject(project({ 'agent.py': 'print(1)\n' }), env).modelServer).toEqual(found);
    expect(formatInit(inspectProject(project(anthropic), env), palette, false)).not.toContain('SHADOWLAP_UPSTREAM_OPENAI');
  });

  it('counts an OpenAI client a framework, an extra or a lockfile brings in, next to another provider’s SDK', () => {
    const env = { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' };
    const server = (files: Record<string, string>, given: Record<string, string> = env) => inspectProject(project(files), given).modelServer?.url ?? null;
    // Pydantic AI's `openai:` models next to Anthropic's SDK: the agent's OpenAI calls go to the local server, from the environment or .env.
    const pydantic = { 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["anthropic", "pydantic-ai-slim[openai]"]\n', 'agent.py': "from pydantic_ai import Agent\nagent = Agent('openai:llama3.2')\n" };
    expect(server(pydantic)).toBe('http://127.0.0.1:11434/v1');
    // The extra installs OpenAI's SDK: it is one of the project's SDKs, named by what brought it.
    expect(inspectProject(project(pydantic), {}).providers).toEqual([{ id: 'anthropic', via: 'anthropic' }, { id: 'openai', via: 'pydantic-ai-slim[openai]' }]);
    expect(server({ ...pydantic, '.env': 'OPENAI_BASE_URL=http://127.0.0.1:11434/v1\n' }, {})).toBe('http://127.0.0.1:11434/v1');
    // Pydantic AI as a whole, the OpenAI Agents SDK, CrewAI or Mastra beside another provider's SDK: each brings an OpenAI client.
    expect(server({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["anthropic", "pydantic-ai>=1"]\n', 'agent.py': 'from pydantic_ai import Agent\n' })).toBe('http://127.0.0.1:11434/v1');
    expect(server({ 'requirements.txt': 'anthropic\nopenai-agents\n', 'agent.py': 'from agents import Agent\n' })).toBe('http://127.0.0.1:11434/v1');
    expect(server({ 'requirements.txt': 'anthropic\ncrewai\n', 'agent.py': 'from crewai import Agent\n' })).toBe('http://127.0.0.1:11434/v1');
    expect(server({ 'package.json': JSON.stringify({ dependencies: { '@ai-sdk/anthropic': '^2.0.0', '@mastra/core': '^0.20.0' } }), 'agent.mjs': "import { Agent } from '@mastra/core/agent';\n" })).toBe('http://127.0.0.1:11434/v1');
    // The AI SDK, LangChain or Pydantic AI's slim package with Anthropic's provider alone: every client is Anthropic's.
    expect(server({ 'package.json': JSON.stringify({ dependencies: { '@ai-sdk/anthropic': '^2.0.0', ai: '^5.0.0' } }), 'agent.mjs': "import { generateText } from 'ai';\n" })).toBeNull();
    expect(server({ 'requirements.txt': 'langchain\nlangchain-anthropic\n', 'agent.py': 'from langchain_anthropic import ChatAnthropic\n' })).toBeNull();
    expect(server({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["pydantic-ai-slim[anthropic]"]\n', 'agent.py': 'from pydantic_ai import Agent\n' })).toBeNull();
    // An extra alone, or openai in the lockfile for another package.
    expect(server({ 'requirements.txt': 'anthropic\nsome-agent-kit[openai]>=1\n', 'agent.py': 'import anthropic\n' })).toBe('http://127.0.0.1:11434/v1');
    expect(server({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["anthropic", "some-agent-kit"]\n', 'uv.lock': 'version = 1\n\n[[package]]\nname = "openai"\nversion = "1.54.0"\n', 'agent.py': 'import anthropic\n' })).toBe('http://127.0.0.1:11434/v1');
    expect(server({ 'package.json': JSON.stringify({ dependencies: { '@anthropic-ai/sdk': '^0.126.0', 'agent-kit': '^1.0.0' } }), 'package-lock.json': JSON.stringify({ packages: { 'node_modules/openai': { version: '6.0.0' } } }), 'agent.mjs': "import Anthropic from '@anthropic-ai/sdk';\n" })).toBe('http://127.0.0.1:11434/v1');
    // Anthropic's SDK and nothing that brings an OpenAI client in: not this project's server.
    expect(server({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["anthropic"]\n', 'uv.lock': 'version = 1\n\n[[package]]\nname = "anthropic"\n', 'agent.py': 'import anthropic\n' })).toBeNull();
  });

  it('leaves OPENAI_BASE_URL alone for Pydantic AI when every model its code names is another provider’s', () => {
    const env = { OPENAI_BASE_URL: 'http://127.0.0.1:60506' };
    // The demo's research agent: Pydantic AI as a whole beside Anthropic's SDK, and Agent("anthropic:claude-sonnet-4-5").
    const demo = fileURLToPath(new URL('../../../scripts/demo-store/folders/research-agent', import.meta.url));
    const report = inspectProject(demo, env);
    expect(report.providers).toEqual([{ id: 'anthropic', via: 'anthropic' }]);
    expect(report.modelServer).toBeNull();
    expect(formatInit(report, palette, false)).not.toContain('SHADOWLAP_UPSTREAM_OPENAI');

    const server = (files: Record<string, string>, given: Record<string, string> = env) => inspectProject(project(files), given).modelServer?.url ?? null;
    const whole = { 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["pydantic-ai>=1"]\n', 'uv.lock': 'version = 1\n\n[[package]]\nname = "openai"\n\n[[package]]\nname = "pydantic-ai"\n' };
    // Other providers' models alone: no OpenAI client, though Pydantic AI as a whole put openai in the lockfile; nor is a .env's address read.
    expect(server({ ...whole, 'agent.py': "from pydantic_ai import Agent\nagent = Agent('google-gla:gemini-2.5-flash')\nhelper = Agent(model='anthropic:claude-haiku-4-5')\n" })).toBeNull();
    expect(server({ ...whole, '.env': 'OPENAI_BASE_URL=http://127.0.0.1:60506\n', 'agent.py': "from pydantic_ai import Agent\nagent = Agent('anthropic:claude-sonnet-4-5')\n" }, {})).toBeNull();
    // An OpenAI model among them, named with its provider or without, or built in code: the server is the project's.
    expect(server({ ...whole, 'agent.py': "from pydantic_ai import Agent\nagent = Agent('anthropic:claude-sonnet-4-5')\nlocal = Agent('openai:llama3.2')\n" })).toBe('http://127.0.0.1:60506');
    expect(server({ ...whole, 'agent.py': "from pydantic_ai import Agent\nagent = Agent('anthropic:claude-sonnet-4-5')\nfast = Agent('gpt-5-mini')\n" })).toBe('http://127.0.0.1:60506');
    expect(server({ ...whole, 'agent.py': "from pydantic_ai import Agent\nfrom pydantic_ai.models.openai import OpenAIChatModel\nagent = Agent('anthropic:claude-sonnet-4-5')\nlocal = Agent(OpenAIChatModel('llama3.2'))\n" })).toBe('http://127.0.0.1:60506');
    // A model the code doesn't name (read from the environment) can't be told, so the server counts.
    expect(server({ ...whole, 'agent.py': "import os\nfrom pydantic_ai import Agent\nagent = Agent(os.environ['MODEL'])\n" })).toBe('http://127.0.0.1:60506');
    // The slim package doesn't install openai: in the lockfile, another package brought it, and it counts.
    expect(server({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["pydantic-ai-slim[anthropic]", "some-agent-kit"]\n', 'uv.lock': 'version = 1\n\n[[package]]\nname = "openai"\n', 'agent.py': "from pydantic_ai import Agent\nagent = Agent('anthropic:claude-sonnet-4-5')\n" })).toBe('http://127.0.0.1:60506');
  });

  it('counts Python tools wrapped with the framework adapters as declared', () => {
    const py = project({
      'requirements.txt': 'openai-agents==0.20.0\nlanggraph\ncrewai\n',
      'agents_app.py': `from shadowlap.adapters.openai_agents import function_tool

@function_tool(effect="read")
async def search_web(ctx: RunContextWrapper[Deps], query: str) -> str:
    ...

@function_tool
async def refund(ctx: RunContextWrapper[Deps], order: str) -> str:
    ...
`,
      'graph_app.py': `from langchain_core.tools import tool
from shadowlap.adapters.langchain import with_effect

@tool
def lookup(query: str) -> str:
    """Look up."""

@tool
def delete_row(id: str) -> str:
    """Delete."""

tools = [with_effect(lookup, "read")]
`,
    });
    const r = inspectProject(py, {});
    expect(r.frameworks.map((f) => f.id).sort()).toEqual(['crewai', 'langchain-python', 'openai-agents-python']);
    expect(r.tools.map((t) => [t.name, t.via, t.effect, t.suggested])).toEqual([
      ['search_web', 'openai-agents-python', 'read', 'read'],
      ['refund', 'openai-agents-python', null, 'write'],
      ['lookup', 'langchain-python', 'read', 'read'],
      ['delete_row', 'langchain-python', null, 'write'],
    ]);
    const text = formatInit(r, palette, false);
    expect(text).toContain('Tools: 4 found, 2 with an effect');
    expect(text).toContain('@function_tool(effect="write") on def refund');
  });

  it('reads files that start with a byte order mark, as Node and npm do', () => {
    // Windows editors save UTF-8 with a BOM; Node's require('./package.json') reads such a file as if it had none.
    const BOM = '﻿';
    const node = inspectProject(project({ 'package.json': BOM + JSON.stringify({ scripts: { start: 'node agent.js' }, dependencies: { openai: '^5.0.0' } }), 'agent.js': "const OpenAI = require('openai');\n" }), {});
    expect(node.packageManager).toBe('npm');
    expect(node.providers).toEqual([{ id: 'openai', via: 'openai' }]);
    expect(node.command).toEqual({ argv: ['npm', 'start'], from: 'package.json scripts.start: node agent.js' });
    const declared = inspectProject(project({ 'pyproject.toml': BOM + '[project.scripts]\ntriage = "triage.main:run"\n', 'requirements.txt': BOM + 'anthropic>=0.40\n' }), {});
    expect(declared.providers).toEqual([{ id: 'anthropic', via: 'anthropic' }]);
    expect(declared.command).toEqual({ argv: ['triage'], from: '[project.scripts] in pyproject.toml' });
    // A source file too: the one file that imports a model SDK is still found by its first line.
    expect(inspectProject(project({ 'bot.py': BOM + 'from anthropic import Anthropic\n' }), {}).command).toEqual({ argv: ['python', 'bot.py'], from: 'the entry file bot.py' });
  });

  it('says so in a directory with no project, and writes nothing', () => {
    const empty = project({});
    const r = inspectProject(empty, {});
    expect(r.languages).toEqual([]);
    expect(formatInit(r, palette, false)).toContain("Run shadowlap init in your agent's project directory");
    const out = spawnSync(process.execPath, [CLI, 'init'], { cwd: empty, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: project({}) } });
    expect(out.status).toBe(0);
    expect(existsSync(join(empty, 'shadowlap.config.json'))).toBe(false);
  });

  it('prints JSON for tools', () => {
    const dir = project({ 'package.json': JSON.stringify({ dependencies: { openai: '^7' } }), 'agent.mjs': "import OpenAI from 'openai';\n" });
    const out = spawnSync(process.execPath, [CLI, 'init', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: project({}) } });
    expect(out.status).toBe(0);
    const json = JSON.parse(out.stdout) as { providers: unknown[]; command: { argv: string[] }; config: { created: boolean } };
    expect(json.providers).toEqual([{ id: 'openai', via: 'openai' }]);
    expect(json.command.argv).toEqual(['node', 'agent.mjs']);
    expect(json.config.created).toBe(true);
  });
});

describe('suggestEffect', () => {
  it('goes by the leading verb and falls back to write', () => {
    const e = (n: string) => suggestEffect(n).effect;
    expect([e('read_file'), e('send_email'), e('getWeather'), e('calculate_total'), e('search-web'), e('update_status'), e('get_email')]).toEqual(['read', 'write', 'read', 'pure', 'read', 'write', 'read']);
    expect(suggestEffect('frobnicate')).toEqual({ effect: 'write', why: 'no hint in the name; write is the safe guess, it never re-runs after a fork' });
  });
});
