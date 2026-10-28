import { componentFiles, hookItems, managedFileOf, projectDirs, settingsDocuments, type SettingsDocument, type SettingsPlaces } from './claude-hooks.js';
import { frontmatter } from './frontmatter.js';

/**
 * What the Claude Code CLI the Claude Agent SDK runs can connect to that Shadowlap's network guard
 * doesn't watch. The CLI is a native program, so no preload loads into it. Its model calls come
 * through Shadowlap (ANTHROPIC_BASE_URL), and so does WebSearch, a search the model API runs; the
 * rest is the query's to decide, and the files Claude Code reads its MCP servers from, as Claude
 * Code's documentation lists them:
 *
 * - the model API itself, when the CLI's ANTHROPIC_BASE_URL isn't Shadowlap's, or it runs on Amazon
 *   Bedrock, Vertex AI or Microsoft Foundry;
 * - WebFetch, which fetches each page itself, unless the query disallows it (`disallowedTools`, or a
 *   `tools` list without it);
 * - an MCP server over the network (`http`, `sse`), in the query's `mcpServers`, `--mcp-config`
 *   (`extraArgs`) or a subagent of its `agents`; and unless `strictMcpConfig` keeps Claude Code to
 *   those, in a project's `.mcp.json` (under the `project` source), `.claude.json` in
 *   `CLAUDE_CONFIG_DIR` or the home folder (read whatever the sources), a local plugin the query
 *   loads, a subagent's frontmatter, or the organization's managed settings (`managedMcpServers`); the
 *   plugins a settings file enables, whose servers aren't read here; and the claude.ai connectors,
 *   which only a claude.ai login brings (no ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, apiKeyHelper,
 *   Anthropic profile or other provider), unless ENABLE_CLAUDEAI_MCP_SERVERS=false or
 *   `disableClaudeAiConnectors` turns them off. An organization's `managed-mcp.json` takes MCP over:
 *   only its servers load then, with `managedMcpServers`;
 * - its nonessential traffic (updates, telemetry, error reports), unless
 *   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set, which withFence does under Shadowlap.
 *
 * Each is a few words the run's summary lists. None left: nothing the guard can't watch remains,
 * and the run passes `--guard block`.
 */

/** The query options that decide what the CLI connects to besides Shadowlap, as the TypeScript SDK names them. */
export interface ReachOptions {
  tools?: unknown;
  disallowedTools?: unknown;
  mcpServers?: unknown;
  strictMcpConfig?: unknown;
  agents?: unknown;
  extraArgs?: unknown;
  plugins?: unknown;
}

type Env = Readonly<Record<string, string | undefined>>;
type Fs = typeof import('node:fs');
type Path = typeof import('node:path');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** On, as Claude Code reads an on/off variable: 1, true, yes or on, in any case. */
const on = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
/** Off, as it reads one: 0, false, no or off. */
const off = (v: string | undefined) => v !== undefined && /^(0|false|no|off)$/i.test(v.trim());
const filled = (v: string | undefined) => v !== undefined && v.trim() !== '';
/** A name from a config file, as the summary quotes it: short, and with no control characters. */
const quote = (name: string) => JSON.stringify((name.length > 40 ? `${name.slice(0, 39)}…` : name).replace(/[\p{Cc}\p{Cf}]/gu, ' '));
const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');

const load = (name: string): Promise<unknown> => import(/* webpackIgnore: true */ /* @vite-ignore */ name);

/** A server Claude Code reaches over the network. */
interface Server {
  name: string;
  type: string;
}

/** The program a command line runs: its first word past any `VAR=value`, by its file's name. */
export function programOf(command: string): string | null {
  const first = command
    .trim()
    .split(/\s+/)
    .find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const name = first?.replace(/^["']+|["']+$/g, '').split(/[\\/]/).pop();
  return name ? name.slice(0, 40) : null;
}

/**
 * A program whose own connections the guard watches when the Claude Code CLI starts it: Python, which
 * loads Shadowlap's preload from the PYTHONPATH the CLI passes on. The CLI passes no NODE_OPTIONS,
 * so a Node program it starts (node, npx) loads no preload, and a native one never does.
 */
export const watchedProgram = (program: string): boolean => /^(python[0-9.]*|py)(\.exe)?$/i.test(program);

/** A stdio server that is Shadowlap's own MCP proxy, which records and fences what it reaches: `shadowlap mcp …`, or through npx. */
function shadowlapMcp(command: string, args: readonly unknown[]): boolean {
  const words = [...command.trim().split(/\s+/), ...args.filter((a): a is string => typeof a === 'string')];
  const program = programOf(command);
  const cli = (w: string) => /^(@shadowlap\/cli|shadowlap)(@\S*)?$/.test(w);
  if (program !== null && /^shadowlap(\.cmd)?$/.test(program)) return words.includes('mcp');
  return program !== null && /^(npx|pnpx|bunx|pnpm|yarn)(\.cmd)?$/.test(program) && words.some(cli) && words.includes('mcp');
}

/**
 * The servers of an MCP config (`{ name: config }`) whose connections the guard can't watch: one over
 * the network (`http`, `sse`, any type but `stdio` and the SDK's in-process `sdk`), and a `stdio` one
 * (a `command`, typed or not) unless it is Python, which loads the preload, or Shadowlap's own MCP
 * proxy. One with neither a command nor a URL connects nowhere. A stdio server's type says its
 * program: `stdio, npx`.
 */
export function unwatchedServers(servers: unknown): Server[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).flatMap(([name, c]) => {
    if (!isRecord(c)) return [];
    const type = typeof c.type === 'string' ? c.type : typeof c.command === 'string' ? 'stdio' : typeof c.url === 'string' ? 'http' : null;
    if (type === null || type === 'sdk') return [];
    if (type !== 'stdio') return [{ name, type: type.slice(0, 20) }];
    const command = typeof c.command === 'string' ? c.command : '';
    const program = programOf(command);
    if (program === null || watchedProgram(program) || shadowlapMcp(command, Array.isArray(c.args) ? c.args : [])) return [];
    return [{ name, type: `stdio, ${quoteProgram(program)}` }];
  });
}

/** A program's name as a summary prints it: no control characters, no quotes needed. */
const quoteProgram = (program: string) => program.replace(/[\p{Cc}\p{Cf}]/gu, ' ');

/** The settings keys whose value is a command Claude Code runs itself, for a key, a token or a header. */
const HELPERS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper'] as const;

/**
 * The CLI's reach, as the summary lists it: each path in a few words. `cliEnv` is the environment the
 * CLI runs with; `shadowlapBase`, the ANTHROPIC_BASE_URL Shadowlap gave the agent, which the CLI's
 * model calls must go to.
 */
export async function claudeReach(query: ReachOptions, places: SettingsPlaces, cliEnv: Env, shadowlapBase: string | undefined): Promise<string[]> {
  const fs = (await load('node:fs')) as Fs;
  const path = (await load('node:path')) as Path;
  const os = (await load('node:os')) as typeof import('node:os');
  const cwd = places.cwd ?? process.cwd();
  const home = cliEnv.HOME || os.homedir();
  const sources = places.sources ?? ['user', 'project', 'local'];
  /** A file as the summary names it: from the session's folder, or the home folder (`~`), and at most 60 characters. */
  const short = (file: string) => {
    const rel = file.startsWith(cwd + path.sep) ? file.slice(cwd.length + 1) : file.startsWith(home + path.sep) ? `~${path.sep}${file.slice(home.length + 1)}` : file;
    return rel.length > 60 ? `…${rel.slice(-59)}` : rel;
  };
  /** A JSON file: what it holds, null when it can't be parsed, undefined when it isn't there. */
  const readJson = (file: string): unknown => {
    if (!fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    } catch {
      return null;
    }
  };
  const out: string[] = [];
  const server = (s: Server, where = '') => out.push(`the MCP server ${quote(s.name)} (${s.type}${where ? `, ${where}` : ''})`);
  const unreadable = (what: string) => out.push(`${what}, which Shadowlap could not read`);
  const docs: SettingsDocument[] = await settingsDocuments(places, cwd);
  const extra = isRecord(query.extraArgs) ? query.extraArgs : {};
  const strict = query.strictMcpConfig === true || Object.hasOwn(extra, 'strict-mcp-config');

  // The model API: Shadowlap's, unless the CLI's environment sends it elsewhere.
  const provider = ([['CLAUDE_CODE_USE_BEDROCK', 'Amazon Bedrock'], ['CLAUDE_CODE_USE_VERTEX', 'Vertex AI'], ['CLAUDE_CODE_USE_FOUNDRY', 'Microsoft Foundry']] as const).find(([v]) => on(cliEnv[v]));
  if (provider) out.push(`the model API on ${provider[1]}`);
  else if (shadowlapBase !== undefined && trimSlash(cliEnv.ANTHROPIC_BASE_URL ?? '') !== trimSlash(shadowlapBase)) {
    let host = 'api.anthropic.com';
    try {
      if (cliEnv.ANTHROPIC_BASE_URL?.trim()) host = new URL(cliEnv.ANTHROPIC_BASE_URL).host;
    } catch {
      host = 'another host';
    }
    out.push(`the model API at ${host.slice(0, 60)}, past Shadowlap's ANTHROPIC_BASE_URL`);
  }

  // WebFetch fetches each page itself; WebSearch's search is a model call, through Shadowlap.
  const disallowed = Array.isArray(query.disallowedTools) ? query.disallowedTools : [];
  const tools = Array.isArray(query.tools) ? query.tools : null;
  if (!disallowed.includes('WebFetch') && (tools === null || tools.includes('WebFetch'))) out.push('WebFetch, which fetches each page itself');

  /** An MCP config given as an object, JSON text or a file (`--mcp-config`): its servers, or null when it can't be read. */
  const mcpConfig = (given: unknown): Record<string, unknown> | null => {
    let value = given;
    if (typeof given === 'string') {
      const t = given.trim();
      if (!t.startsWith('{')) value = readJson(path.resolve(cwd, t));
      else {
        try {
          value = JSON.parse(t) as unknown;
        } catch {
          value = null;
        }
      }
    }
    if (!isRecord(value)) return null;
    return isRecord(value.mcpServers) ? value.mcpServers : value;
  };

  const managed = managedFileOf(places, path);
  const managedMcpFile = managed ? path.join(path.dirname(managed), 'managed-mcp.json') : null;
  const managedMcp = managedMcpFile ? readJson(managedMcpFile) : undefined;
  const takenOver = managedMcp !== undefined;
  if (takenOver) {
    // The organization's managed-mcp.json: only its servers load, and the provided ones below.
    if (!isRecord(managedMcp)) unreadable(`the MCP servers in ${short(managedMcpFile!)}`);
    else for (const s of unwatchedServers(managedMcp.mcpServers)) server(s, 'managed-mcp.json');
  } else {
    for (const s of unwatchedServers(query.mcpServers)) server(s);
    if (extra['mcp-config'] !== undefined && extra['mcp-config'] !== null) {
      const given = mcpConfig(extra['mcp-config']);
      if (given === null) unreadable('the MCP servers of --mcp-config');
      else for (const s of unwatchedServers(given)) server(s, '--mcp-config');
    }
    // A subagent of the query's own may bring a server with it.
    if (isRecord(query.agents)) {
      for (const [agent, def] of Object.entries(query.agents)) {
        const specs = isRecord(def) && Array.isArray(def.mcpServers) ? def.mcpServers : [];
        for (const spec of specs) for (const s of unwatchedServers(spec)) server(s, `subagent ${quote(agent)}`);
      }
    }
  }
  // Servers the organization provides in its managed settings files; --strict-mcp-config leaves them out, unless managed-mcp.json is there.
  if (!strict || takenOver) {
    for (const d of docs) if (d.managed && d.source !== "the query's managedSettings option" && isRecord(d.data)) for (const s of unwatchedServers(d.data.managedMcpServers)) server(s, 'managed settings');
  }
  if (!strict && !takenOver) {
    const repo = projectDirs(fs, path, cwd);
    // A project's .mcp.json, which an SDK session loads without asking.
    if (sources.includes('project')) {
      for (const dir of repo) {
        const file = path.join(dir, '.mcp.json');
        const json = readJson(file);
        if (json === undefined) continue;
        const servers = mcpConfig(json);
        if (servers === null) unreadable(`the MCP servers in ${short(file)}`);
        else for (const s of unwatchedServers(servers)) server(s, short(file));
      }
    }
    // The user's and the local scope's servers, in .claude.json: read whatever settingSources says.
    const userFile = path.join(cliEnv.CLAUDE_CONFIG_DIR || home, '.claude.json');
    const user = readJson(userFile);
    if (user === null) unreadable(`the MCP servers in ${short(userFile)}`);
    else if (isRecord(user)) {
      for (const s of unwatchedServers(user.mcpServers)) server(s, short(userFile));
      // The local scope's, kept under the folder they were added in: this one or one above it.
      const projects = isRecord(user.projects) ? user.projects : {};
      for (const dir of ancestors(path, cwd)) {
        const p = projects[dir];
        if (isRecord(p)) for (const s of unwatchedServers(p.mcpServers)) server(s, `local scope in ${short(userFile)}`);
      }
    }
    // The local plugins the query loads.
    for (const plugin of Array.isArray(query.plugins) ? query.plugins : []) {
      if (!isRecord(plugin) || typeof plugin.path !== 'string' || plugin.skipMcpDiscovery === true) continue;
      const root = path.resolve(cwd, plugin.path);
      const name = `plugin ${quote(path.basename(root))}`;
      const own = readJson(path.join(root, '.mcp.json'));
      const servers = own === undefined ? {} : mcpConfig(own);
      if (servers === null) unreadable(`the MCP servers of the ${name}`);
      else for (const s of unwatchedServers(servers)) server(s, name);
      const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
      if (manifest === null) unreadable(`the manifest of the ${name}`);
      else if (isRecord(manifest) && manifest.mcpServers !== undefined) {
        for (const entry of [manifest.mcpServers].flat()) {
          const servers = typeof entry === 'string' ? mcpConfig(readJson(path.resolve(root, entry)) ?? null) : isRecord(entry) ? entry : null;
          if (servers === null) unreadable(`the MCP servers of the ${name}`);
          else for (const s of unwatchedServers(servers)) server(s, name);
        }
      }
    }
    // The plugins a settings file enables: their servers come from where Claude Code installed them.
    for (const d of docs) {
      if (isRecord(d.data) && isRecord(d.data.enabledPlugins) && Object.values(d.data.enabledPlugins).some((v) => v === true)) {
        out.push(`the MCP servers of the plugins ${d.source.startsWith('the query') ? d.source : short(d.source)} enables`);
      }
    }
    // A subagent's frontmatter may bring a server with it.
    for (const file of (await componentFiles(places, cwd)).agents) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const v = frontmatter(text)?.get('mcpServers');
      if (!v) continue;
      if ('unreadable' in v) unreadable(`the MCP servers in ${short(file)}`);
      else for (const spec of Array.isArray(v.value) ? v.value : [v.value]) for (const s of unwatchedServers(spec)) server(s, short(file));
    }
  }
  // Hooks Claude Code runs itself: an http one posts to its URL from the CLI, a command one runs a
  // program the CLI starts, which loads no preload but Python's.
  const where = (source: string) => (source.startsWith('the query') ? source : short(source));
  for (const h of await hookItems(places, cwd)) {
    if (h.type === 'unreadable') unreadable(`the hooks in ${where(h.source)}`);
    else if (h.type === 'http' && h.url !== undefined) {
      let host = 'its URL';
      try {
        host = new URL(h.url).host.slice(0, 60) || host;
      } catch {
        // a URL that doesn't parse goes nowhere a host can name
      }
      out.push(`the HTTP hook in ${where(h.source)} (${quoteProgram(host)})`);
    } else if (h.type === 'command' && h.command !== undefined) {
      const program = programOf(h.command);
      if (program !== null && !watchedProgram(program)) out.push(`the command hook ${quoteProgram(program)} in ${where(h.source)}`);
    }
  }
  // The commands a settings file names for a key, a token or a header, which the CLI runs itself.
  for (const d of docs) {
    if (!isRecord(d.data)) continue;
    for (const key of HELPERS) {
      const command = d.data[key];
      const program = typeof command === 'string' ? programOf(command) : null;
      if (program !== null && !watchedProgram(program)) out.push(`the ${key} command ${quoteProgram(program)} in ${where(d.source)}`);
    }
  }
  // The claude.ai connectors: Claude Code fetches them only for a claude.ai login.
  const connectorsOff =
    strict ||
    off(cliEnv.ENABLE_CLAUDEAI_MCP_SERVERS) ||
    docs.some((d) => isRecord(d.data) && d.data.disableClaudeAiConnectors === true) ||
    filled(cliEnv.ANTHROPIC_API_KEY) ||
    filled(cliEnv.ANTHROPIC_AUTH_TOKEN) ||
    filled(cliEnv.ANTHROPIC_PROFILE) ||
    docs.some((d) => isRecord(d.data) && typeof d.data.apiKeyHelper === 'string' && d.data.apiKeyHelper.trim() !== '') ||
    provider !== undefined ||
    // managed-mcp.json suppresses them, unless the organization's own settings allow them beside it.
    (takenOver && !docs.some((d) => d.managed && d.source !== "the query's managedSettings option" && isRecord(d.data) && d.data.allowAllClaudeAiMcps === true));
  if (!connectorsOff) out.push('claude.ai connectors, which a claude.ai login brings');
  // Its OpenTelemetry export, which no nonessential-traffic switch turns off: on with
  // CLAUDE_CODE_ENABLE_TELEMETRY, in the environment or the env of a settings file that may set it (a
  // repository's may not), to a collector an otlp exporter sends to.
  const otelDocs = docs.filter((d) => d.scope === 'user' || d.scope === 'managed' || d.scope === 'query');
  const values = (name: string) => [cliEnv[name], ...otelDocs.map((d) => (isRecord(d.data) && isRecord(d.data.env) ? d.data.env[name] : undefined))].filter((v): v is string => typeof v === 'string');
  const otlp = (name: string) => values(name).some((v) => v.split(',').some((e) => e.trim().toLowerCase() === 'otlp'));
  const traces = [...values('CLAUDE_CODE_ENHANCED_TELEMETRY_BETA'), ...values('ENABLE_ENHANCED_TELEMETRY_BETA')].some(on);
  if (values('CLAUDE_CODE_ENABLE_TELEMETRY').some(on) && (otlp('OTEL_METRICS_EXPORTER') || otlp('OTEL_LOGS_EXPORTER') || (traces && otlp('OTEL_TRACES_EXPORTER')))) {
    out.push('its OpenTelemetry export (CLAUDE_CODE_ENABLE_TELEMETRY, to an otlp collector)');
  }
  // Its own traffic: any value at all turns it off, 0 and false among them.
  if (!filled(cliEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)) out.push('its nonessential traffic (updates, telemetry, error reports)');
  return [...new Set(out)];
}

/** The folder and every folder above it. */
function ancestors(path: Path, cwd: string): string[] {
  const out: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    out.push(dir);
    if (path.dirname(dir) === dir) return out;
  }
}

