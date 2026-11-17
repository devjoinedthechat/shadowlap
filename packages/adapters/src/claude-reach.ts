import { componentFiles, homeOf, hookItems, managedFileOf, projectDirs, settingsDocuments, type SettingsDocument, type SettingsPlaces } from './claude-hooks.js';
import { frontmatter } from './frontmatter.js';
import { isObject } from './is-object.js';
import { load } from './load.js';

/**
 * What the Claude Code CLI the Claude Agent SDK runs can connect to that shadowlap's network guard
 * doesn't watch. The CLI is a native program, so no preload loads into it. Its model calls come
 * through shadowlap (ANTHROPIC_BASE_URL), and so does WebSearch, a search the model API runs; the
 * rest is the query's to decide, and the files Claude Code reads its MCP servers from, as Claude
 * Code's documentation lists them:
 *
 * - the model API itself, when the CLI's ANTHROPIC_BASE_URL isn't shadowlap's, or it runs on Amazon
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
 *   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set, which withFence does under shadowlap.
 *
 * Each is a few words the run's summary lists. None left: nothing the guard can't watch remains,
 * and the run passes `--guard block`.
 */

/** The query options that decide what the CLI connects to besides shadowlap, as the TypeScript SDK names them. */
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

/** On, as Claude Code reads an on/off variable: 1, true, yes or on, in any case. */
const on = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
/** Off, as it reads one: 0, false, no or off. */
const off = (v: string | undefined) => v !== undefined && /^(0|false|no|off)$/i.test(v.trim());
const filled = (v: string | undefined) => v !== undefined && v.trim() !== '';
/** A name from a config file, as the summary quotes it: short, and with no control characters. */
const quote = (name: string) => JSON.stringify((name.length > 40 ? `${name.slice(0, 39)}…` : name).replace(/[\p{Cc}\p{Cf}]/gu, ' '));
const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');

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
 * loads shadowlap's preload from the PYTHONPATH the CLI passes on. The CLI passes no NODE_OPTIONS,
 * so a Node program it starts (node, npx) loads no preload, and a native one never does.
 */
export const watchedProgram = (program: string): boolean => /^(python[0-9.]*|py)(\.exe)?$/i.test(program);

/** A stdio server that is shadowlap's own MCP proxy, which records and fences what it reaches: `shadowlap mcp …`, or through npx. */
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
 * (a `command`, typed or not) unless it is Python, which loads the preload, or shadowlap's own MCP
 * proxy. One with neither a command nor a URL connects nowhere. A stdio server's type says its
 * program: `stdio, npx`.
 */
export function unwatchedServers(servers: unknown): Server[] {
  if (!isObject(servers)) return [];
  return Object.entries(servers).flatMap(([name, c]) => {
    if (!isObject(c)) return [];
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
 * CLI runs with; `shadowlapBase`, the ANTHROPIC_BASE_URL shadowlap gave the agent, which the CLI's
 * model calls must go to.
 */
export async function claudeReach(query: ReachOptions, places: SettingsPlaces, cliEnv: Env, shadowlapBase: string | undefined): Promise<string[]> {
  const r = await Reach.open(query, places, cliEnv);
  const provider = modelApi(r, shadowlapBase);
  // WebFetch fetches each page itself; WebSearch's search is a model call, through shadowlap.
  const disallowed = Array.isArray(query.disallowedTools) ? query.disallowedTools : [];
  const tools = Array.isArray(query.tools) ? query.tools : null;
  if (!disallowed.includes('WebFetch') && (tools === null || tools.includes('WebFetch'))) r.out.push('WebFetch, which fetches each page itself');
  const takenOver = givenServers(r);
  // Servers the organization provides in its managed settings files; --strict-mcp-config leaves them out, unless managed-mcp.json is there.
  if (!r.strict || takenOver) {
    for (const d of r.docs) if (d.managed && !d.host && isObject(d.data)) r.servers(d.data.managedMcpServers, 'managed settings');
  }
  if (!r.strict && !takenOver) {
    projectServers(r);
    userServers(r);
    for (const plugin of Array.isArray(query.plugins) ? query.plugins : []) pluginServers(r, plugin);
    enabledPlugins(r);
    await agentServers(r);
  }
  await hooksAndHelpers(r);
  if (!connectorsOff(r, provider, takenOver)) r.out.push('claude.ai connectors, which a claude.ai login brings');
  if (telemetryExported(r)) r.out.push('its OpenTelemetry export (CLAUDE_CODE_ENABLE_TELEMETRY, to an otlp collector)');
  // Its own traffic: any value at all turns it off, 0 and false among them.
  if (!filled(cliEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)) r.out.push('its nonessential traffic (updates, telemetry, error reports)');
  return [...new Set(r.out)];
}

/**
 * What claudeReach works from (the session's folder, the query, the settings it loads, the CLI's
 * environment) and the reach it found so far, in the order the summary lists it.
 */
class Reach {
  readonly sources: readonly string[];
  readonly extra: Record<string, unknown>;
  readonly strict: boolean;
  readonly out: string[] = [];

  private constructor(
    readonly query: ReachOptions,
    readonly places: SettingsPlaces,
    readonly cliEnv: Env,
    readonly fs: Fs,
    readonly path: Path,
    readonly cwd: string,
    readonly home: string,
    readonly docs: SettingsDocument[],
  ) {
    this.sources = places.sources ?? ['user', 'project', 'local'];
    this.extra = isObject(query.extraArgs) ? query.extraArgs : {};
    this.strict = query.strictMcpConfig === true || Object.hasOwn(this.extra, 'strict-mcp-config');
  }

  /** Node's modules it reads files with, the session's and the home folder, and the settings documents Claude Code loads for the query. */
  static async open(query: ReachOptions, places: SettingsPlaces, cliEnv: Env): Promise<Reach> {
    const fs = (await load('node:fs')) as Fs;
    const path = (await load('node:path')) as Path;
    const os = (await load('node:os')) as typeof import('node:os');
    const cwd = places.cwd ?? process.cwd();
    return new Reach(query, places, cliEnv, fs, path, cwd, homeOf(cliEnv, os.homedir()), await settingsDocuments(places, cwd));
  }

  /** A file as the summary names it: from the session's folder, or the home folder (`~`), with `/` between its parts on every system, and at most 60 characters. */
  short(file: string): string {
    const { cwd, home, path } = this;
    const portable = (rel: string) => rel.split(path.sep).join('/');
    const rel = file.startsWith(cwd + path.sep) ? portable(file.slice(cwd.length + 1)) : file.startsWith(home + path.sep) ? `~/${portable(file.slice(home.length + 1))}` : file;
    return rel.length > 60 ? `…${rel.slice(-59)}` : rel;
  }

  /** Where a setting is from, as the summary names it: the query's own, or its file. */
  named(source: string): string {
    return source.startsWith('the query') ? source : this.short(source);
  }

  /** A JSON file: what it holds, null when it can't be parsed, undefined when it isn't there. */
  readJson(file: string): unknown {
    if (!this.fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(this.fs.readFileSync(file, 'utf8')) as unknown;
    } catch {
      return null;
    }
  }

  /** Each server of an MCP config the guard can't watch, as the summary names it, with where it comes from. */
  servers(config: unknown, where = ''): void {
    for (const s of unwatchedServers(config)) this.out.push(`the MCP server ${quote(s.name)} (${s.type}${where ? `, ${where}` : ''})`);
  }

  unreadable(what: string): void {
    this.out.push(`${what}, which shadowlap could not read`);
  }

  /** The servers of an MCP config (mcpConfig), or that `what` could not be read. */
  configServers(given: unknown, what: string, where = ''): void {
    const servers = this.mcpConfig(given);
    if (servers === null) this.unreadable(what);
    else this.servers(servers, where);
  }

  /** An MCP config given as an object, JSON text or a file (`--mcp-config`): its servers, or null when it can't be read. */
  mcpConfig(given: unknown): Record<string, unknown> | null {
    let value = given;
    if (typeof given === 'string') {
      const t = given.trim();
      if (!t.startsWith('{')) value = this.readJson(this.path.resolve(this.cwd, t));
      else {
        try {
          value = JSON.parse(t) as unknown;
        } catch {
          value = null;
        }
      }
    }
    if (!isObject(value)) return null;
    return isObject(value.mcpServers) ? value.mcpServers : value;
  }
}

/** The model API: shadowlap's, unless the CLI's environment sends it elsewhere. Returns the cloud platform it runs on, if one. */
function modelApi(r: Reach, shadowlapBase: string | undefined): string | undefined {
  const env = r.cliEnv;
  const provider = ([['CLAUDE_CODE_USE_BEDROCK', 'Amazon Bedrock'], ['CLAUDE_CODE_USE_VERTEX', 'Vertex AI'], ['CLAUDE_CODE_USE_FOUNDRY', 'Microsoft Foundry']] as const).find(([v]) => on(env[v]))?.[1];
  if (provider) r.out.push(`the model API on ${provider}`);
  else if (shadowlapBase !== undefined && trimSlash(env.ANTHROPIC_BASE_URL ?? '') !== trimSlash(shadowlapBase)) {
    let host = 'api.anthropic.com';
    try {
      if (env.ANTHROPIC_BASE_URL?.trim()) host = new URL(env.ANTHROPIC_BASE_URL).host;
    } catch {
      host = 'another host';
    }
    r.out.push(`the model API at ${host.slice(0, 60)}, past shadowlap's ANTHROPIC_BASE_URL`);
  }
  return provider;
}

/**
 * The servers the CLI is given: the organization's managed-mcp.json, which takes over (only its
 * servers load, and the managed settings' ones), or else the query's own, --mcp-config's and its
 * subagents'. Returns whether managed-mcp.json took over.
 */
function givenServers(r: Reach): boolean {
  const managed = managedFileOf(r.places, r.path);
  const managedMcpFile = managed ? r.path.join(r.path.dirname(managed), 'managed-mcp.json') : null;
  const managedMcp = managedMcpFile ? r.readJson(managedMcpFile) : undefined;
  if (managedMcp !== undefined) {
    if (!isObject(managedMcp)) r.unreadable(`the MCP servers in ${r.short(managedMcpFile!)}`);
    else r.servers(managedMcp.mcpServers, 'managed-mcp.json');
    return true;
  }
  r.servers(r.query.mcpServers);
  if (r.extra['mcp-config'] !== undefined && r.extra['mcp-config'] !== null) r.configServers(r.extra['mcp-config'], 'the MCP servers of --mcp-config', '--mcp-config');
  // A subagent of the query's own may bring a server with it.
  if (isObject(r.query.agents)) {
    for (const [agent, def] of Object.entries(r.query.agents)) {
      const specs = isObject(def) && Array.isArray(def.mcpServers) ? def.mcpServers : [];
      for (const spec of specs) r.servers(spec, `subagent ${quote(agent)}`);
    }
  }
  return false;
}

/** A project's .mcp.json, which an SDK session loads without asking. */
function projectServers(r: Reach): void {
  if (!r.sources.includes('project')) return;
  for (const dir of projectDirs(r.fs, r.path, r.cwd)) {
    const file = r.path.join(dir, '.mcp.json');
    const json = r.readJson(file);
    if (json !== undefined) r.configServers(json, `the MCP servers in ${r.short(file)}`, r.short(file));
  }
}

/**
 * The user's and the local scope's servers, in .claude.json: read whatever settingSources says. The
 * local scope's are kept under the folder they were added in: this one or one above it.
 */
function userServers(r: Reach): void {
  const userFile = r.path.join(r.cliEnv.CLAUDE_CONFIG_DIR || r.home, '.claude.json');
  const user = r.readJson(userFile);
  if (user === null) {
    r.unreadable(`the MCP servers in ${r.short(userFile)}`);
    return;
  }
  if (!isObject(user)) return;
  r.servers(user.mcpServers, r.short(userFile));
  const projects = isObject(user.projects) ? user.projects : {};
  for (const dir of ancestors(r.path, r.cwd)) {
    const p = projects[dir];
    if (isObject(p)) r.servers(p.mcpServers, `local scope in ${r.short(userFile)}`);
  }
}

/** A local plugin's servers: its .mcp.json, and those its manifest names, inline or in a file. */
function pluginServers(r: Reach, plugin: unknown): void {
  if (!isObject(plugin) || typeof plugin.path !== 'string' || plugin.skipMcpDiscovery === true) return;
  const root = r.path.resolve(r.cwd, plugin.path);
  const name = `plugin ${quote(r.path.basename(root))}`;
  const own = r.readJson(r.path.join(root, '.mcp.json'));
  r.configServers(own === undefined ? {} : own, `the MCP servers of the ${name}`, name);
  const manifest = r.readJson(r.path.join(root, '.claude-plugin', 'plugin.json'));
  if (manifest === null) {
    r.unreadable(`the manifest of the ${name}`);
    return;
  }
  if (!isObject(manifest) || manifest.mcpServers === undefined) return;
  for (const entry of [manifest.mcpServers].flat()) {
    const servers = typeof entry === 'string' ? r.mcpConfig(r.readJson(r.path.resolve(root, entry)) ?? null) : isObject(entry) ? entry : null;
    if (servers === null) r.unreadable(`the MCP servers of the ${name}`);
    else r.servers(servers, name);
  }
}

/** The plugins a settings file enables: their servers come from where Claude Code installed them. */
function enabledPlugins(r: Reach): void {
  for (const d of r.docs) {
    if (isObject(d.data) && isObject(d.data.enabledPlugins) && Object.values(d.data.enabledPlugins).some((v) => v === true)) {
      r.out.push(`the MCP servers of the plugins ${r.named(d.source)} enables`);
    }
  }
}

/** A subagent's frontmatter may bring a server with it. */
async function agentServers(r: Reach): Promise<void> {
  for (const file of (await componentFiles(r.places, r.cwd)).agents) {
    let text: string;
    try {
      text = r.fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const v = frontmatter(text)?.get('mcpServers');
    if (!v) continue;
    if ('unreadable' in v) r.unreadable(`the MCP servers in ${r.short(file)}`);
    else for (const spec of Array.isArray(v.value) ? v.value : [v.value]) r.servers(spec, r.short(file));
  }
}

/**
 * Hooks Claude Code runs itself: an http one posts to its URL from the CLI, a command one runs a
 * program the CLI starts, which loads no preload but Python's. Then the commands a settings file
 * names for a key, a token or a header, which the CLI runs itself.
 */
async function hooksAndHelpers(r: Reach): Promise<void> {
  for (const h of await hookItems(r.places, r.cwd)) {
    if (h.type === 'unreadable') r.unreadable(`the hooks in ${r.named(h.source)}`);
    else if (h.type === 'http' && h.url !== undefined) {
      let host = 'its URL';
      try {
        host = new URL(h.url).host.slice(0, 60) || host;
      } catch {
        // a URL that doesn't parse goes nowhere a host can name
      }
      r.out.push(`the HTTP hook in ${r.named(h.source)} (${quoteProgram(host)})`);
    } else if (h.type === 'command' && h.command !== undefined) {
      const program = programOf(h.command);
      if (program !== null && !watchedProgram(program)) r.out.push(`the command hook ${quoteProgram(program)} in ${r.named(h.source)}`);
    }
  }
  for (const d of r.docs) {
    if (!isObject(d.data)) continue;
    for (const key of HELPERS) {
      const command = d.data[key];
      const program = typeof command === 'string' ? programOf(command) : null;
      if (program !== null && !watchedProgram(program)) r.out.push(`the ${key} command ${quoteProgram(program)} in ${r.named(d.source)}`);
    }
  }
}

/** Whether the claude.ai connectors stay off: Claude Code fetches them only for a claude.ai login. */
function connectorsOff(r: Reach, provider: string | undefined, takenOver: boolean): boolean {
  const { cliEnv: env, docs } = r;
  return (
    r.strict ||
    off(env.ENABLE_CLAUDEAI_MCP_SERVERS) ||
    docs.some((d) => isObject(d.data) && d.data.disableClaudeAiConnectors === true) ||
    filled(env.ANTHROPIC_API_KEY) ||
    filled(env.ANTHROPIC_AUTH_TOKEN) ||
    filled(env.ANTHROPIC_PROFILE) ||
    docs.some((d) => isObject(d.data) && typeof d.data.apiKeyHelper === 'string' && d.data.apiKeyHelper.trim() !== '') ||
    provider !== undefined ||
    // managed-mcp.json suppresses them, unless the organization's own settings allow them beside it.
    (takenOver && !docs.some((d) => d.managed && !d.host && isObject(d.data) && d.data.allowAllClaudeAiMcps === true))
  );
}

/**
 * Its OpenTelemetry export, which no nonessential-traffic switch turns off: on with
 * CLAUDE_CODE_ENABLE_TELEMETRY, in the environment or the env of a settings file that may set it (a
 * repository's may not), to a collector an otlp exporter sends to.
 */
function telemetryExported(r: Reach): boolean {
  const otelDocs = r.docs.filter((d) => d.scope === 'user' || d.scope === 'managed' || d.scope === 'query');
  const values = (name: string) => [r.cliEnv[name], ...otelDocs.map((d) => (isObject(d.data) && isObject(d.data.env) ? d.data.env[name] : undefined))].filter((v): v is string => typeof v === 'string');
  const otlp = (name: string) => values(name).some((v) => v.split(',').some((e) => e.trim().toLowerCase() === 'otlp'));
  const traces = [...values('CLAUDE_CODE_ENHANCED_TELEMETRY_BETA'), ...values('ENABLE_ENHANCED_TELEMETRY_BETA')].some(on);
  return values('CLAUDE_CODE_ENABLE_TELEMETRY').some(on) && (otlp('OTEL_METRICS_EXPORTER') || otlp('OTEL_LOGS_EXPORTER') || (traces && otlp('OTEL_TRACES_EXPORTER')));
}

/** The folder and every folder above it. */
function ancestors(path: Path, cwd: string): string[] {
  const out: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    out.push(dir);
    if (path.dirname(dir) === dir) return out;
  }
}
