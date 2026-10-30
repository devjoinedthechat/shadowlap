import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '@shadowlap/engine';
import { inspectProject, writeInitialConfig } from '../src/init.js';
import { initFindings, initJson, noteInspected, wrapSnippets, type InitJson } from '../src/init-format.js';

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function project(files: Record<string, string>, root = tempDir('sl-initjson-')): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
/**
 * A project in a home folder of its own, the way the dashboard adds one. Never the system's
 * temporary folder as the home folder: Linux's (/tmp) is a system folder, which holds no projects.
 */
function homeProject(files: Record<string, string>): { home: string; dir: string } {
  const home = tempDir('sl-initjson-user-');
  return { home, dir: project(files, join(home, 'research-agent')) };
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The mock's research agent: Pydantic AI on uv, one tool wrapped and two write tools that aren't. */
const RESEARCH = {
  'pyproject.toml': '[project]\nname = "research-agent"\ndependencies = ["anthropic>=0.69", "pydantic-ai-slim[anthropic]>=2.43"]\n',
  'uv.lock': 'version = 1\n\n[[package]]\nname = "anthropic"\nversion = "0.69.0"\nsource = { registry = "https://pypi.org/simple" }\n',
  '.python-version': '3.12.4\n',
  'agent.py': `from pydantic_ai import Agent
from shadowlap import tool

agent = Agent("anthropic:claude-sonnet-5")

@agent.tool_plain
@tool(effect="read")
def search_filings(company: str, form: str) -> dict:
    ...

@agent.tool
def save_report(ctx, path: str, body: str) -> dict:
    ...

@agent.tool_plain
def notify_slack(channel: str, text: str) -> dict:
    ...
`,
};

const json = (dir: string): InitJson => {
  const report = inspectProject(dir, {});
  return initJson(report, report.languages.length ? writeInitialConfig(report) : false);
};

describe('shadowlap init --json', () => {
  it('says what the setup shows: language, SDK, framework, command and config', () => {
    const dir = project(RESEARCH);
    const j = json(dir);
    expect(j.summary).toEqual({
      language: 'Python 3.12 · uv',
      sdk: 'anthropic 0.69.0',
      framework: 'Pydantic AI',
      command: 'uv run agent.py',
      commandFrom: 'the entry file agent.py',
      config: 'wrote an empty shadowlap.config.json',
      node: null,
    });
    expect(j.folder).toMatchObject({ kind: 'Python · uv', label: 'Python · uv · pyproject.toml · uv.lock', files: ['pyproject.toml', 'uv.lock'] });
    // Everything the report had is still there, for scripts that read it.
    expect(j.providers).toEqual([{ id: 'anthropic', via: 'anthropic' }]);
    expect(j.config).toMatchObject({ existed: false, created: true });
  });

  it('gives the Python SDK’s version as the project declares it when no lock pins it', () => {
    const sdk = (files: Record<string, string>) => json(project({ 'agent.py': 'import anthropic\n', ...files })).summary.sdk;
    // A lock that doesn't list it: the declared pin.
    expect(sdk({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["anthropic==0.69.0"]\n', 'uv.lock': 'version = 1\n' })).toBe('anthropic 0.69.0');
    // A lower bound, or a compatible release, names the release it starts from.
    expect(sdk({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = [\n  "anthropic[bedrock]>=0.69,<1 ; python_version >= \'3.9\'",\n]\n' })).toBe('anthropic 0.69');
    expect(sdk({ 'requirements.txt': 'anthropic~=0.69.0\n' })).toBe('anthropic 0.69.0');
    // Another package whose name starts the same is not it.
    expect(sdk({ 'requirements.txt': 'anthropic-bedrock==1.0.0\nanthropic>=0.70\n' })).toBe('anthropic 0.70');
    // An exact pin wins over a bound declared elsewhere.
    expect(sdk({ 'requirements.txt': 'anthropic>=0.60\n', 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["anthropic==0.69.1"]\n' })).toBe('anthropic 0.69.1');
    // Poetry's and Pipfile's values.
    expect(sdk({ 'pyproject.toml': '[tool.poetry]\nname = "x"\n\n[tool.poetry.dependencies]\npython = "^3.12"\nanthropic = "^0.69.0"\n' })).toBe('anthropic 0.69.0');
    expect(sdk({ 'pyproject.toml': '[tool.poetry.dependencies]\nanthropic = { version = "~0.69", extras = ["bedrock"] }\n' })).toBe('anthropic 0.69');
    expect(sdk({ Pipfile: '[packages]\nanthropic = "==0.69.0"\n' })).toBe('anthropic 0.69.0');
    // A comment in the array isn't a requirement.
    expect(sdk({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = [\n  # was "anthropic==0.1.0"\n  "anthropic>=0.71",\n]\n' })).toBe('anthropic 0.71');
    // Nothing that names a version: the name alone.
    expect(sdk({ Pipfile: '[packages]\nanthropic = "*"\n' })).toBe('anthropic');
    expect(sdk({ 'requirements.txt': 'anthropic\n' })).toBe('anthropic');
  });

  it('flags every tool that isn’t wrapped, with the code to wrap it for that language', () => {
    const j = json(project(RESEARCH));
    expect(j.tools.map((t) => [t.name, t.suggested, t.wrapped])).toEqual([
      ['search_filings', 'read', true],
      ['save_report', 'write', false],
      ['notify_slack', 'write', false],
    ]);
    expect(j.unwrapped).toEqual(['save_report', 'notify_slack']);
    expect(j.tools.map((t) => t.decorator)).toEqual([undefined, '@agent.tool', '@agent.tool_plain']);
    expect(j.wrap).toEqual([
      {
        language: 'python',
        tools: ['save_report', 'notify_slack'],
        // Each keeps the decorator it has: a tool_plain takes no RunContext, and Pydantic AI checks.
        code: 'from shadowlap import tool\n\n@agent.tool\n@tool(effect="write")\ndef save_report(…):\n    …\n\n@agent.tool_plain\n@tool(effect="write")\ndef notify_slack(…):\n    …',
      },
    ]);
  });

  it('re-checks when run again: the config is left alone, and wrapped tools are no longer flagged', () => {
    const dir = project(RESEARCH);
    json(dir);
    project({ 'agent.py': RESEARCH['agent.py'].replace('@agent.tool\ndef save_report', '@agent.tool\n@tool(effect="write")\ndef save_report').replace('@agent.tool_plain\ndef notify_slack', '@agent.tool_plain\n@tool(effect="write")\ndef notify_slack') }, dir);
    const again = json(dir);
    expect(again.summary.config).toBe('shadowlap.config.json exists · left as it is');
    expect(again.config).toMatchObject({ existed: true, created: false });
    expect(again.unwrapped).toEqual([]);
    expect(again.wrap).toEqual([]);
  });

  it('writes TypeScript for a TypeScript project, through its framework’s adapter', () => {
    const dir = project({
      'package.json': JSON.stringify({ scripts: { agent: 'tsx src/agent.ts' }, dependencies: { ai: '^7.0.0', '@ai-sdk/anthropic': '^3.0.0' } }),
      'pnpm-lock.yaml': '',
      '.nvmrc': 'v22.13.0\n',
      'tsconfig.json': '{}',
      'src/tools.ts': `import { tool } from 'ai';
export const tools = {
  delete_record: tool({ description: 'Delete', inputSchema, execute: async ({ id }) => db.delete(id) }),
  'search-docs': tool({ description: 'Search', inputSchema, execute: async ({ id }) => db.get(id) }),
};
`,
    });
    const j = json(dir);
    // The pin with its minor, as for Python: 22.13, not 22.
    expect(j.summary).toMatchObject({ language: 'Node 22.13 · TypeScript · pnpm', sdk: '@ai-sdk/anthropic 3.0.0', framework: 'Vercel AI SDK 7.0.0', command: 'pnpm agent', node: { version: '22.13', from: '.nvmrc', tooOld: false } });
    expect(j.wrap).toEqual([
      { language: 'typescript', tools: ['delete_record', 'search-docs'], code: "import { withEffects } from '@shadowlap/adapters/ai-sdk';\n\nconst tools = withEffects({ … }, { delete_record: 'write', 'search-docs': 'read' });" },
    ]);
  });

  it("gives a Claude Agent SDK query the fence, in TypeScript and Python, beside the effects of its in-process tools, until it runs through it", () => {
    const query = "import { query } from '@anthropic-ai/claude-agent-sdk';\n\nfor await (const message of query({ prompt: 'Tidy the changelog', options: { allowedTools: ['Bash'] } })) console.log(message);\n";
    const ts = json(project({ 'package.json': JSON.stringify({ dependencies: { '@anthropic-ai/claude-agent-sdk': '^0.3.0' } }), 'agent.ts': query }));
    expect(ts.fence).toEqual([{ framework: 'claude-agent-sdk', language: 'typescript', at: null }]);
    // Bash is no tool of the project's: nothing is unwrapped, and the fence is the code to add.
    expect(ts.unwrapped).toEqual([]);
    expect(ts.wrap).toEqual([{ language: 'typescript', tools: [], code: "import { withFence } from '@shadowlap/adapters/claude-agent-sdk';\n\nquery({ prompt, options: withFence(options) });" }]);
    // An in-process tool to wrap as well: one import for both.
    const py = json(
      project({
        'requirements.txt': 'claude-agent-sdk\n',
        'agent.py': 'from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, query, tool\n\n@tool("lookup_order", "Look an order up", {"order_id": str})\nasync def lookup(args):\n    ...\n\norders = create_sdk_mcp_server(name="orders", version="1.0.0", tools=[lookup])\n\nasync def main():\n    async for message in query(prompt="Where is A-1042?", options=ClaudeAgentOptions(mcp_servers={"orders": orders}, allowed_tools=["Bash"])):\n        print(message)\n',
      }),
    );
    expect(py.fence).toEqual([{ framework: 'claude-agent-sdk-python', language: 'python', at: null }]);
    expect(py.unwrapped).toEqual(['lookup_order']);
    expect(py.wrap).toEqual([
      { language: 'python', tools: ['lookup_order'], code: 'from shadowlap.adapters.claude_agent_sdk import with_effects, with_fence\n\ntools = with_effects("<server>", [ … ], {"lookup_order": "read"})\nquery(prompt=prompt, options=with_fence(options))' },
    ]);
    // Checked again once the query runs through it: nothing left to add.
    const fenced = json(project({ 'package.json': JSON.stringify({ dependencies: { '@anthropic-ai/claude-agent-sdk': '^0.3.0', '@shadowlap/adapters': '^0.1.0' } }), 'agent.ts': query.replace("import { query } from '@anthropic-ai/claude-agent-sdk';\n", "import { query } from '@anthropic-ai/claude-agent-sdk';\nimport { withFence } from '@shadowlap/adapters/claude-agent-sdk';\n").replace("options: { allowedTools: ['Bash'] }", "options: withFence({ allowedTools: ['Bash'] })") }));
    expect(fenced.fence).toEqual([{ framework: 'claude-agent-sdk', language: 'typescript', at: { file: 'agent.ts', line: 4 } }]);
    expect(fenced.wrap).toEqual([]);
  });

  it('writes one block per framework, each with its import', () => {
    const tools = [
      { name: 'refund', file: 'agents.mjs', line: 3, via: 'openai-agents', effect: null, suggested: 'write' as const, why: '' },
      { name: 'lookup_order', file: 'tools.mjs', line: 9, via: 'mastra', effect: null, suggested: 'read' as const, why: '' },
      { name: 'search', file: 'tools.mjs', line: 12, via: 'mastra', effect: 'read' as const, suggested: 'read' as const, why: 'declared' },
      { name: 'delete_row', file: 'graph.py', line: 4, via: 'langchain-python', effect: null, suggested: 'write' as const, why: '' },
      { name: 'send', file: 'crew.py', line: 8, via: 'openai-agents-python', effect: null, suggested: 'write' as const, why: '' },
    ];
    expect(wrapSnippets(tools)).toEqual([
      {
        language: 'javascript',
        tools: ['refund', 'lookup_order'],
        code: "import { withEffect } from '@shadowlap/adapters/openai-agents';\n\ntool(withEffect({ name: 'refund', … }, 'write'));\n\nimport { withEffect } from '@shadowlap/adapters/mastra';\n\ncreateTool(withEffect({ id: 'lookup_order', … }, 'read'));",
      },
      {
        language: 'python',
        tools: ['delete_row', 'send'],
        code: 'from shadowlap.adapters.langchain import with_effect\n\ntools = [with_effect(delete_row, "write")]\n\nfrom shadowlap.adapters.openai_agents import function_tool\n\n@function_tool(effect="write")\ndef send(…):\n    …',
      },
    ]);
  });

  it('keeps what the setup needs in the project list', () => {
    const f = initFindings(json(project(RESEARCH)), 42);
    expect(f).toMatchObject({
      at: 42,
      language: 'Python 3.12 · uv',
      files: ['pyproject.toml', 'uv.lock'],
      command: ['uv', 'run', 'agent.py'],
      commandFrom: 'the entry file agent.py',
      config: { file: 'shadowlap.config.json', created: true, existed: false },
    });
    expect(f.tools.map((t) => [t.name, t.effect, t.wrapped, t.file])).toEqual([
      ['search_filings', 'read', true, 'agent.py'],
      ['save_report', 'write', false, 'agent.py'],
      ['notify_slack', 'write', false, 'agent.py'],
    ]);
  });
});

/** The CLI's environment in a test: no colour, no telemetry, and a project list of its own. */
const cliEnv = (home: string) => ({ ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: home });

describe('a Node pin', () => {
  const NODE18 = { 'package.json': JSON.stringify({ dependencies: { '@anthropic-ai/sdk': '0.30.0' } }), 'package-lock.json': '{}', 'agent.mjs': "import Anthropic from '@anthropic-ai/sdk';\n" };

  it('keeps its minor, and says when it is older than the 18.18 the guard needs, for the setup to flag', () => {
    const j = json(project({ ...NODE18, '.nvmrc': '18.17\n' }));
    expect(j.summary).toMatchObject({ language: 'Node 18.17 · npm', node: { version: '18.17', from: '.nvmrc', tooOld: true } });
    expect(initFindings(j, 1).nodePin).toEqual({ version: '18.17', from: '.nvmrc' });
    // A major alone names its newest release; .node-version counts as .nvmrc does.
    expect(json(project({ ...NODE18, '.node-version': '18\n' })).summary.node).toEqual({ version: '18', from: '.node-version', tooOld: false });
    expect(json(project({ ...NODE18, '.nvmrc': 'v16.20.2\n' })).summary.node).toMatchObject({ version: '16.20', tooOld: true });
    // None pinned, or not a version.
    expect(json(project(NODE18)).summary.node).toBeNull();
    expect(json(project({ ...NODE18, '.nvmrc': 'lts/*\n' })).summary.node).toBeNull();
    expect(initFindings(json(project(NODE18)), 1).nodePin).toBeNull();
  });

  it('is flagged in a terminal, before the steps', () => {
    const dir = project({ ...NODE18, '.nvmrc': '18.17\n' });
    const text = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8', env: cliEnv(tempDir('sl-initjson-node-')) });
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("! .nvmrc pins Node 18.17, too old for Shadowlap's guard, which needs Node 18.18 or later: the agent wouldn't start. Pin 18.18 or later before you record.");
    expect(text.stdout.indexOf('.nvmrc pins')).toBeLessThan(text.stdout.indexOf('1. Install'));
  });
});

describe('shadowlap init as a dashboard job', () => {
  it('prints only what it found, as the drawer beside the setup shows it, and ends on what it did with the config', async () => {
    const slHome = tempDir('sl-initjson-drawer-');
    const dir = project({ ...RESEARCH, '.nvmrc': '18.17\n', 'package.json': '{}', 'agent.mjs': '' });
    const child = spawn(process.execPath, [CLI, 'init'], { cwd: dir, env: { ...cliEnv(slHome), SHADOWLAP_EVENTS_FD: '3' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    child.stdout!.on('data', (c: Buffer) => out.push(c));
    (child.stdio[3] as NodeJS.ReadableStream).resume();
    expect(await new Promise<number | null>((resolve) => child.on('close', resolve))).toBe(0);
    const lines = Buffer.concat(out).toString('utf8').trimEnd().split('\n');
    expect(lines[0]).toBe(`▸ reading ${dir} · runs nothing`);
    expect(lines).toContain('  model SDK    anthropic 0.69.0');
    expect(lines).toContain('  framework    Pydantic AI');
    expect(lines).toContain('  tool         search_filings  read');
    // A tool that isn't wrapped is flagged, with what it suggests and why.
    expect(lines.filter((l) => l.startsWith('! tool')).map((l) => l.replace(/ \(.*\)$/, ''))).toEqual(['! tool         save_report  not wrapped · suggest write', '! tool         notify_slack  not wrapped · suggest write']);
    expect(lines.find((l) => l.startsWith('! node'))).toBe("! node         .nvmrc pins Node 18.17, too old for Shadowlap's guard, which needs Node 18.18 or later: the agent wouldn't start. Pin 18.18 or later before you record.");
    // It ends on the config, and leaves out the steps a terminal gets: the setup's own buttons are those.
    expect(lines.at(-1)).toBe('✓ wrote shadowlap.config.json (empty)');
    const text = lines.join('\n');
    for (const step of ['1. Install', 'Record a run', 'shadowlap replay', 'shadowlap dashboard', 'Created shadowlap.config.json']) expect(text).not.toContain(step);
  });
});

describe('initFindings', () => {
  it('keeps a wrapped tool’s declared effect, whatever its name suggests', () => {
    const j = json(project(RESEARCH));
    const declared = { ...j, tools: [{ name: 'send_digest', file: 'agent.py', line: 3, via: 'shadowlap', effect: 'read' as const, suggested: 'write' as const, why: '"send" changes something', wrapped: true }] };
    expect(initFindings(declared).tools).toEqual([{ name: 'send_digest', effect: 'read', wrapped: true, why: 'declared', file: 'agent.py', line: 3 }]);
  });

  it('keeps the model server the project points at, never the credentials in its address', () => {
    // The research agent with an OpenAI client too, which OPENAI_BASE_URL points somewhere else.
    const both = { ...RESEARCH, 'pyproject.toml': RESEARCH['pyproject.toml'].replace('"anthropic>=0.69"', '"anthropic>=0.69", "openai>=1"') };
    const local = json(project({ ...both, '.env': 'OPENAI_BASE_URL=http://127.0.0.1:11434/v1\n' }));
    expect(local.modelServer).toEqual({ url: 'http://127.0.0.1:11434/v1', upstream: 'http://127.0.0.1:11434', from: 'OPENAI_BASE_URL in .env' });
    expect(initFindings(local).modelServer).toEqual({ url: 'http://127.0.0.1:11434/v1', upstream: 'http://127.0.0.1:11434', from: 'OPENAI_BASE_URL in .env' });
    const secret = json(project({ ...both, '.env': 'OPENAI_BASE_URL=https://dana:s3cret@llm.internal/v1\n' }));
    expect(secret.modelServer).toEqual({ url: 'https://llm.internal/v1', upstream: null, from: 'OPENAI_BASE_URL in .env' });
    expect(initFindings(secret).modelServer).toEqual({ url: 'https://llm.internal/v1', upstream: null, from: 'OPENAI_BASE_URL in .env' });
    expect(initFindings(json(project(both))).modelServer).toBeNull();
    // Anthropic's SDK alone never sends to it: no model server, so the setup records as usual.
    expect(json(project({ ...RESEARCH, '.env': 'OPENAI_BASE_URL=https://dana:s3cret@llm.internal/v1\n' })).modelServer).toBeNull();
  });
});

describe('shadowlap init in a dashboard project', () => {
  const env = (home: string) => ({ ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: home });

  it('marks the project inspected, with its findings, and again after the tools are wrapped', () => {
    const slHome = tempDir('sl-initjson-home-');
    const { home, dir } = homeProject(RESEARCH);
    const registry = new ProjectRegistry({ home, dir: slHome, actor: () => null });
    registry.add(dir);
    const out = spawnSync(process.execPath, [CLI, 'init', '--json'], { cwd: dir, encoding: 'utf8', env: env(slHome) });
    expect(out.status).toBe(0);
    expect((JSON.parse(out.stdout) as InitJson).unwrapped).toEqual(['save_report', 'notify_slack']);
    const p = registry.find(dir)!;
    expect(p.setup.stage).toBe('inspected');
    expect(p.setup.findings).toMatchObject({ language: 'Python 3.12 · uv', sdk: 'anthropic 0.69.0' });
    expect(p.setup.findings!.wrap[0].tools).toEqual(['save_report', 'notify_slack']);

    project({ 'agent.py': RESEARCH['agent.py'].replace(/@agent\.tool\ndef save_report/, '@agent.tool\n@tool(effect="write")\ndef save_report').replace(/@agent\.tool_plain\ndef notify_slack/, '@agent.tool_plain\n@tool(effect="write")\ndef notify_slack') }, dir);
    // In a terminal too: the text output, and the same update.
    const text = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8', env: env(slHome) });
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Every tool found declares an effect.');
    expect(registry.find(dir)!.setup.findings!.wrap).toEqual([]);
  });

  it('changes nothing for a folder that isn’t a project, and creates no list', () => {
    const slHome = tempDir('sl-initjson-none-');
    const dir = project(RESEARCH);
    const out = spawnSync(process.execPath, [CLI, 'init', '--json'], { cwd: dir, encoding: 'utf8', env: env(slHome) });
    expect(out.status).toBe(0);
    expect(existsSync(join(slHome, 'projects.json'))).toBe(false);
  });

  it('never prints a model server’s credentials, nor tells a dashboard job them', async () => {
    const slHome = tempDir('sl-initjson-secret-');
    const dir = project({
      ...RESEARCH,
      '.env': 'OPENAI_BASE_URL=https://dana:s3cret-token@llm.internal/v1\n',
      'client.py': 'from openai import OpenAI\nclient = OpenAI(base_url="https://bot:hunter2@gateway.internal/v1?api_key=k3y")\n',
    });
    const child = spawn(process.execPath, [CLI, 'init', '--json'], { cwd: dir, env: { ...env(slHome), SHADOWLAP_EVENTS_FD: '3' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const events: Buffer[] = [];
    child.stdout!.on('data', (c: Buffer) => out.push(c));
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (c: Buffer) => events.push(c));
    expect(await new Promise<number | null>((resolve) => child.on('close', resolve))).toBe(0);
    const stdout = Buffer.concat(out).toString('utf8');
    const event = Buffer.concat(events).toString('utf8');
    for (const secret of ['s3cret-token', 'hunter2', 'k3y', 'dana:', 'bot:']) {
      expect(stdout, secret).not.toContain(secret);
      expect(event, secret).not.toContain(secret);
    }
    const printed = JSON.parse(stdout) as InitJson;
    expect(printed.modelServer).toEqual({ url: 'https://llm.internal/v1', upstream: null, from: 'OPENAI_BASE_URL in .env' });
    expect(printed.hardcodedBaseUrls.map((w) => w.url)).toEqual(['https://gateway.internal/v1']);
    // Nor in a terminal, whose output gets pasted into issues.
    const text = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8', env: env(slHome) });
    expect(text.status).toBe(0);
    expect(text.stdout).not.toContain('s3cret-token');
    expect(text.stdout).toContain('Model server: https://llm.internal/v1 (OPENAI_BASE_URL in .env; its credentials aren’t shown)');
    expect(text.stdout).toContain('SHADOWLAP_UPSTREAM_OPENAI=<your model server> shadowlap run -- uv run agent.py');
  });

  it('tells a dashboard job its findings, once the setup has taken them', async () => {
    const slHome = tempDir('sl-initjson-job-');
    const { home, dir } = homeProject(RESEARCH);
    new ProjectRegistry({ home, dir: slHome, actor: () => null }).add(dir);
    const child = spawn(process.execPath, [CLI, 'init', '--json'], { cwd: dir, env: { ...env(slHome), SHADOWLAP_EVENTS_FD: '3' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const events: Buffer[] = [];
    const out: Buffer[] = [];
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (c: Buffer) => events.push(c));
    child.stdout!.on('data', (c: Buffer) => out.push(c));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    const lines = Buffer.concat(events).toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; data: InitJson });
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe('result');
    expect(lines[0].data.summary.command).toBe('uv run agent.py');
    const id = new ProjectRegistry({ home, dir: slHome }).find(dir)!.id;
    expect(lines[0].data.project).toEqual({ id, noted: true, why: null });
    expect((JSON.parse(Buffer.concat(out).toString('utf8')) as InitJson).project).toEqual({ id, noted: true, why: null });
  });

  it('says when the setup couldn’t take the findings, in the result and in a terminal', () => {
    const slHome = tempDir('sl-initjson-newer-');
    const { home, dir } = homeProject(RESEARCH);
    const registry = new ProjectRegistry({ home, dir: slHome, actor: () => null });
    const id = registry.add(dir).project.id;
    // A newer Shadowlap wrote the list since: this one can read it, not change it.
    const file = join(slHome, 'projects.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version: 99 }));
    const out = spawnSync(process.execPath, [CLI, 'init', '--json'], { cwd: dir, encoding: 'utf8', env: env(slHome) });
    expect(out.status).toBe(0);
    expect((JSON.parse(out.stdout) as InitJson).project).toEqual({ id, noted: false, why: expect.stringMatching(/written by a newer Shadowlap/) });
    const text = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8', env: env(slHome) });
    expect(text.status).toBe(0);
    expect(text.stderr).toMatch(new RegExp(`! The dashboard’s setup of ${id} didn’t take this in: .*written by a newer Shadowlap`));
    // A folder that isn't a project says nothing of it.
    const other = project(RESEARCH);
    const none = spawnSync(process.execPath, [CLI, 'init'], { cwd: other, encoding: 'utf8', env: env(slHome) });
    expect(none.stderr).not.toContain('dashboard’s setup');
  });
});

describe('noteInspected', () => {
  it('says what it did for the dashboard’s setup, and never fails init', () => {
    const slHome = tempDir('sl-note-');
    const { home, dir } = homeProject(RESEARCH);
    const env = { SHADOWLAP_HOME: slHome };
    const j = json(dir);
    expect(noteInspected(dir, j, env)).toEqual({ id: null, noted: false, why: null });
    const registry = new ProjectRegistry({ home, dir: slHome, actor: () => null });
    const id = registry.add(dir).project.id;
    expect(noteInspected(dir, j, env)).toEqual({ id, noted: true, why: null });
    // Another process holds the list for longer than init waits.
    const lock = join(slHome, 'projects.json.lock');
    writeFileSync(lock, String(process.pid));
    try {
      expect(noteInspected(dir, j, env, { lockTimeoutMs: 50 })).toEqual({ id, noted: false, why: expect.stringMatching(/is held by another Shadowlap process/) });
    } finally {
      rmSync(lock, { force: true });
    }
    // A list that can't be read: whether the folder is a project can't be told.
    writeFileSync(join(slHome, 'projects.json'), '{ not json');
    expect(noteInspected(dir, j, env)).toEqual({ id: null, noted: false, why: expect.stringMatching(/isn’t valid JSON/) });
  });
});
