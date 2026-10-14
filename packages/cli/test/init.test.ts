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
    expect(r.command).toEqual({ argv: ['uv', 'run', 'agent.py'], from: 'agent.py' });
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
    \"\"\"Look up.\"\"\"

@tool
def delete_row(id: str) -> str:
    \"\"\"Delete.\"\"\"

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
