import { basename, join } from 'node:path';
import type { Effect } from '@shadowlap/engine';
import { AGENT_NODE_MIN, ProjectRegistry, describeFolder, messageOf, modelServerFinding, nodePinTooOld, type FolderKind, type ModelServer, type RegistryOptions, type SetupFindings, type WrapSnippet } from '@shadowlap/engine';
import { CONFIG_FILE } from './config.js';
import { providers as sidecarProviders } from '@shadowlap/sidecar';
import { quoteArgv } from './ui.js';
import { FRAMEWORK_NAMES } from './init-models.js';
import { type Fence, type FoundTool, type InitReport, type Language, type Provider } from './init-report.js';
import { installedVersion, readJson, readText, tomlRequirements } from './init-source.js';

/**
 * What `shadowlap init` prints and hands on: the next steps as a person reads them, the JSON the
 * dashboard and the coding agents read, the code that wraps each tool found, and the findings kept
 * with the project's folder.
 */

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

/** A Claude Agent SDK query run through the fence, and the import that brings it, in each language, as docs/frameworks.md gives them. */
const FENCED_QUERY = {
  js: { code: 'query({ prompt, options: withFence(options) })', from: "import { withFence } from '@shadowlap/adapters/claude-agent-sdk'" },
  python: { code: 'query(prompt=prompt, options=with_fence(options))', from: 'from shadowlap.adapters.claude_agent_sdk import with_fence' },
} as const;

/** The packages that bring the Claude Agent SDK, as a model SDK found through one names it (`via`). */
const CLAUDE_AGENT_PACKAGES: ReadonlySet<string> = new Set(['@anthropic-ai/claude-agent-sdk', 'claude-agent-sdk']);

/**
 * What `shadowlap init` prints: what it found, then the steps to a first recording. Run by a global
 * `shadowlap` (`globalCli`), the steps use it as it is: they add only the SDKs to the project, and
 * run `shadowlap`, not `npx shadowlap`.
 */
export function formatInit(r: InitReport, p: Palette, wroteConfig: boolean, { globalCli = false }: { globalCli?: boolean } = {}): string {
  const lines: string[] = [];
  const out = (s = '') => lines.push(s);
  out(`${p.bold('Shadowlap init')}  ${p.dim(r.cwd)}`);
  out();
  out(p.bold('Found'));
  if (!r.languages.length) {
    out(`  No package.json, pyproject.toml or source files here. Run ${p.cyan('shadowlap init')} in your agent's project directory.`);
    return lines.join('\n');
  }
  // Output gets pasted into issues and chats: an address with credentials is shown without them.
  const shown = r.modelServer ? modelServerFinding(r.modelServer) : null;
  const w: InitWriter = { r, p, out, ts: r.languages.includes('typescript') || r.languages.includes('javascript'), python: r.languages.includes('python'), globalCli, secret: !!r.modelServer && !!shown && shown.url !== r.modelServer.url, step: 0 };
  found(w, shown?.url ?? r.modelServer?.url ?? null);
  warnings(w);
  install(w);
  fence(w);
  tools(w);
  record(w);
  out(wroteConfig ? `Created ${CONFIG_FILE} for normalizers and redaction rules.` : `${basename(r.config.path)} already exists; left as it is.`);
  return lines.join('\n');
}

/** What each part of init's report writes with: the report, the palette, the line it adds to, and what the steps depend on. */
interface InitWriter {
  r: InitReport;
  p: Palette;
  out: (line?: string) => void;
  /** The project has TypeScript or JavaScript, and Python. */
  ts: boolean;
  python: boolean;
  globalCli: boolean;
  /** The model server's address holds credentials, which aren't printed. */
  secret: boolean;
  /** The last step's number. */
  step: number;
}

/** A numbered step's title. */
const head = (w: InitWriter, title: string) => w.out(w.p.bold(`${++w.step}. ${title}`));

/** What was found: the languages and package manager, the model SDKs, the framework, a model server, the agent's command and its tools. */
function found(w: InitWriter, server: string | null): void {
  const { r, p, out } = w;
  out(`  ${r.languages.map((l) => (l === 'typescript' ? 'TypeScript' : l === 'javascript' ? 'JavaScript' : 'Python')).join(' and ')}${r.packageManager ? ` · ${r.packageManager}` : ''} · ${r.scannedFiles} source file${r.scannedFiles === 1 ? '' : 's'}`);
  out(`  Model SDKs: ${r.providers.length ? r.providers.map((x) => `${PROVIDER_NAMES[x.id][0]} (${x.via})`).join(', ') : p.yellow('none found')}`);
  if (r.frameworks.length) out(`  Framework: ${r.frameworks.map((f) => `${f.name}${f.version ? ` ${f.version}` : ''}`).join(', ')}`);
  if (r.modelServer) out(`  Model server: ${server ?? r.modelServer.url} ${p.dim(`(${r.modelServer.from}${w.secret ? '; its credentials aren’t shown' : ''})`)}`);
  if (r.command) out(`  Agent command: ${quoteArgv(r.command.argv)} ${p.dim(`(${r.command.from})`)}`);
  const unwrapped = r.tools.filter((t) => !t.effect).length;
  out(`  Tools: ${r.tools.length ? `${r.tools.length} found, ${r.tools.length - unwrapped} with an effect` : 'none found'}`);
  out();
}

/** What would keep calls from being recorded, or the CLI from running: a host Shadowlap doesn't know, a model sent where it can't follow, no model SDK, a Node too old. */
function warnings(w: InitWriter): void {
  const { r, p, out } = w;
  // A provider's own host is captured in Node and Python processes; another host needs naming.
  const unknownHosts = r.hardcodedBaseUrls.filter((u) => !captured(u.url));
  for (const u of unknownHosts) {
    const id = u.client ?? '<provider>';
    out(`${p.yellow('!')} ${u.file}:${u.line} sets the model base URL to ${u.url}. Shadowlap doesn't know that host, so calls through that client would not be recorded.`);
    out(`  ${p.dim(`Run with SHADOWLAP_UPSTREAM_${id.toUpperCase()}=${u.url.replace(/\/v1\/?$/, '')}, or read the base URL from ${u.client ? PROVIDER_NAMES[u.client][1] : 'the environment'}.`)}`);
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
}

/** The step that installs the CLI and the SDKs, with the project's package manager. */
function install(w: InitWriter): void {
  const { r, p, out } = w;
  head(w, 'Install');
  if (w.ts) {
    const add = r.packageManager === 'pnpm' ? 'pnpm add' : r.packageManager === 'yarn' ? 'yarn add' : r.packageManager === 'bun' ? 'bun add' : 'npm install';
    const adapters = r.frameworks.some((f) => f.adapter);
    if (!w.globalCli) out(`     ${p.cyan(`${add} ${r.packageManager === 'npm' || !r.packageManager ? '--save-dev' : '-D'} shadowlap`)}`);
    out(`     ${p.cyan(`${add} @shadowlap/sdk${adapters ? ' @shadowlap/adapters' : ''}`)}   ${p.dim(adapters ? 'tool effects, through your framework' : 'tool effects, clock and randomness')}`);
  }
  if (w.python) {
    out(`     ${p.cyan(r.packageManager === 'uv' ? 'uv add shadowlap' : r.packageManager === 'poetry' ? 'poetry add shadowlap' : 'pip install shadowlap')}   ${p.dim('the Python SDK')}`);
    if (!w.ts && !w.globalCli) out(`     ${p.cyan('npm install --global shadowlap')}   ${p.dim('the CLI (Node 22.16 or later, not 23)')}`);
  }
  out();
}

/**
 * The step that runs a Claude Agent SDK query through the fence, while none does: Claude Code runs
 * the SDK's built-in tools itself, where no wrapper reaches them, and the fence records them through
 * the SDK's hooks.
 */
function fence(w: InitWriter): void {
  const { r, p, out } = w;
  const open = r.fence.filter((f) => !f.at);
  if (!open.length) return;
  head(w, "Fence Claude Code's built-in tools");
  for (const f of open) {
    const query = f.language === 'python' ? FENCED_QUERY.python : FENCED_QUERY.js;
    out(`     ${query.code}   ${f.language === 'python' ? '#' : '//'} ${query.from}`);
  }
  out(`     ${p.dim("Bash, Write, Edit and the rest run inside Claude Code, where no wrapper reaches them: the fence records them through the SDK's hooks, so a fork repeats a side effect only with --writes allow.")}`);
  out();
}

/**
 * Whether the project has a framework or a model SDK besides the Claude Agent SDK, whose tools are
 * wrapped one by one. The Claude Agent SDK's own are fenced, and its in-process tools are found.
 */
function wrapsOwnTools(r: InitReport): boolean {
  return r.frameworks.some((f) => f.id !== 'claude-agent-sdk' && f.id !== 'claude-agent-sdk-python') || r.providers.some((x) => !CLAUDE_AGENT_PACKAGES.has(x.via));
}

/** The step that gives each tool its effect: those found without one, and how to declare it; or, with none found, how to wrap one. */
function tools(w: InitWriter): void {
  const { r, p, out } = w;
  const unwrapped = r.tools.filter((t) => !t.effect);
  if (r.tools.length) {
    head(w, unwrapped.length ? 'Declare what each tool does' : 'Tools');
    if (!unwrapped.length) out(`     Every tool found declares an effect.`);
    for (const t of unwrapped.slice(0, 20)) out(`     ${`${t.file}:${t.line}`.padEnd(32)} ${t.name.padEnd(22)} ${p.green(t.suggested.padEnd(5))}  ${p.dim(t.why)}`);
    if (unwrapped.length > 20) out(`     ${p.dim(`… ${unwrapped.length - 20} more`)}`);
    if (unwrapped.length) {
      const example = unwrapped[0]!;
      const snippet = ADAPTER_SNIPPETS[example.via] ?? (example.file.endsWith('.py') ? ADAPTER_SNIPPETS.python : undefined);
      if (snippet) out(`     ${p.dim('for example:')} ${snippet(example.name, example.suggested, example)}`);
      out(`     ${p.dim('read: may run again after a fork · write: runs again after a fork only with --writes allow · pure: depends only on its input')}`);
    }
    out();
  } else if (wrapsOwnTools(r)) {
    head(w, 'Wrap your tools');
    out(`     ${p.dim('No tool definitions found. Wrap each tool with its effect so a fork repeats a side effect only with --writes allow:')}`);
    out(`     ${w.ts ? "tool('send_email', { effect: 'write' }, impl)   // import { tool } from '@shadowlap/sdk'" : '@tool(effect="write")   # from shadowlap import tool'}`);
    out();
  }
}

/** The steps that record a run and replay it. */
function record(w: InitWriter): void {
  const { r, p, out } = w;
  head(w, 'Record a run');
  const upstream = r.modelServer ? `SHADOWLAP_UPSTREAM_OPENAI=${w.secret ? '<your model server>' : r.modelServer.upstream} ` : '';
  const cli = w.ts && !w.globalCli ? 'npx shadowlap' : 'shadowlap';
  out(`     ${p.cyan(`${upstream}${cli} run -- ${r.command ? quoteArgv(r.command.argv) : '<the command that starts your agent>'}`)}`);
  // `mastra dev` and `mastra start` serve agents and wait for requests: a run is a script that asks one.
  if (!r.command && r.frameworks.some((f) => f.id === 'mastra')) out(`     ${p.dim("Mastra's dev server waits for requests: record a script that calls an agent, await mastra.getAgent('…').generate('…'), or a test with @shadowlap/test.")}`);
  if (r.modelServer) out(`     ${p.dim(w.secret ? 'SHADOWLAP_UPSTREAM_OPENAI is the model server’s address without /v1, credentials included; init doesn’t print them.' : 'SHADOWLAP_UPSTREAM_OPENAI keeps your model server as the upstream; the agent talks to Shadowlap.')}`);
  out();
  head(w, 'Replay it, then change something and replay again');
  out(`     ${p.cyan(`${cli} replay <run>`)}   ${p.dim('0 upstream requests when nothing changed')}`);
  out(`     ${p.cyan(`${cli} dashboard`)}   ${p.dim('or: shadowlap ui')}`);
  out();
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
  /**
   * Code that wraps them, per language, and that runs a Claude Agent SDK query through the fence while
   * none does (`fence`); empty when every tool is wrapped and every such query fenced.
   */
  wrap: WrapSnippet[];
  /** What the command did for the folder's setup in the dashboard ({@link noteInspected}); `shadowlap init` always says. */
  project?: InspectedNote;
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

/**
 * The Claude Agent SDK's block, under one import: the effects of its in-process tools (the server
 * named by its key in the query's mcpServers), and the query through the fence when it needs it.
 */
function claudeAgentCode(py: boolean, tools: readonly FoundTool[], fence: boolean): string {
  const names = [...(tools.length ? [py ? 'with_effects' : 'withEffects'] : []), ...(fence ? [py ? 'with_fence' : 'withFence'] : [])];
  const effects = py ? `tools = with_effects("<server>", [ … ], {${tools.map((t) => `"${t.name}": "${t.suggested}"`).join(', ')}})` : `const tools = withEffects('<server>', [ … ], { ${tools.map((t) => `${jsKey(t.name)}: '${t.suggested}'`).join(', ')} });`;
  const query = py ? FENCED_QUERY.python.code : `${FENCED_QUERY.js.code};`;
  return [py ? `from shadowlap.adapters.claude_agent_sdk import ${names.join(', ')}` : `import { ${names.join(', ')} } from '@shadowlap/adapters/claude-agent-sdk';`, '', ...(tools.length ? [effects] : []), ...(fence ? [query] : [])].join('\n');
}

/**
 * One block per framework, each with its own import, for the tools of one language; with `fence`,
 * the Claude Agent SDK's block runs its query through the fence too, with or without tools of its own.
 */
function wrapCode(language: WrapSnippet['language'], tools: FoundTool[], fence: boolean): string {
  const groups = new Map<string, FoundTool[]>();
  if (fence) groups.set(language === 'python' ? 'claude-agent-sdk-python' : 'claude-agent-sdk', []);
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
      else if (via === 'claude-agent-sdk-python') blocks.push(claudeAgentCode(true, list, fence));
      else blocks.push(['from shadowlap import tool', '', list.map((t) => def([`@tool(effect="${t.suggested}")`], t)).join('\n\n')].join('\n'));
      continue;
    }
    const adapter = (module: string, line: (t: FoundTool) => string) => blocks.push([`import { withEffect } from '@shadowlap/adapters/${module}';`, '', ...list.map(line)].join('\n'));
    if (via === 'ai-sdk') blocks.push([`import { withEffects } from '@shadowlap/adapters/ai-sdk';`, '', `const tools = withEffects({ … }, { ${list.map((t) => `${jsKey(t.name)}: '${t.suggested}'`).join(', ')} });`].join('\n'));
    else if (via === 'openai-agents') adapter('openai-agents', (t) => `tool(withEffect({ name: '${t.name}', … }, '${t.suggested}'));`);
    else if (via === 'mastra') adapter('mastra', (t) => `createTool(withEffect({ id: '${t.name}', … }, '${t.suggested}'));`);
    else if (via === 'langchain') adapter('langchain', (t) => `withEffect(tool(…, { name: '${t.name}', … }), '${t.suggested}');`);
    else if (via === 'anthropic-tool-runner') adapter('anthropic', (t) => `betaZodTool(withEffect({ name: '${t.name}', … }, '${t.suggested}'));`);
    else if (via === 'claude-agent-sdk') blocks.push(claudeAgentCode(false, list, fence));
    else blocks.push([`import { tool } from '@shadowlap/sdk';`, '', ...list.map((t) => `export const ${camel(t.name)} = tool('${t.name}', { effect: '${t.suggested}' }, async (args) => { … });`)].join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Code that wraps the tools that aren't, with the suggested effect declared, per language, and that
 * runs a Claude Agent SDK query through the fence while none does (`fence`, as inspectProject found it).
 */
export function wrapSnippets(tools: readonly FoundTool[], fence: readonly Fence[] = []): WrapSnippet[] {
  const byLanguage = new Map<WrapSnippet['language'], FoundTool[]>();
  // A query to fence is code to add in its language, with no tool of the project's.
  const fenced = new Set(fence.filter((f) => !f.at).map((f) => f.language));
  for (const language of fenced) byLanguage.set(language, []);
  for (const t of tools) {
    if (t.effect) continue;
    const language: WrapSnippet['language'] = t.file.endsWith('.py') ? 'python' : /\.(ts|tsx|mts|cts)$/.test(t.file) ? 'typescript' : 'javascript';
    byLanguage.set(language, [...(byLanguage.get(language) ?? []), t]);
  }
  return [...byLanguage].map(([language, list]) => ({ language, tools: list.map((t) => t.name), code: wrapCode(language, list, fenced.has(language)) }));
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
    wrap: wrapSnippets(r.tools, r.fence),
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
    return { id: null, noted: false, why: messageOf(err) };
  }
  if (!id) return { id: null, noted: false, why: null };
  try {
    registry.noteInspected(id, initFindings(json));
    return { id, noted: true, why: null };
  } catch (err) {
    return { id, noted: false, why: messageOf(err) };
  }
}
