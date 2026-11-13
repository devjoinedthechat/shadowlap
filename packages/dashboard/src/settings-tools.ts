import { isObject, parseToolTrust, type Effect, type ToolTrust, type TrustSource } from '@shadowlap/engine';
import { toolTrust, type ToolTrustRow } from './tool-trust.js';
import type { ToolsRead, ToolTest } from './injection-security.js';
import { toolReads, type ToolReads } from './tool-reads.js';
import { trustLine } from './tool-trust.js';
import { type ConfigInfo, loadConfigFile, type SettingsContext } from './settings-shared.js';
import { type ClientConfigBlock, clientConfigs, type McpRecordedServer, type McpServerRow, mcpServers, recordedMcpServers } from './settings-mcp.js';
import { mcpClientConfig, readShippedDoc } from './settings-docs.js';

/** Settings' Tools tab: each tool the runs called with its effect, the HTTP hosts they reached, and the MCP servers behind them. */

export interface ToolRow {
  name: string;
  /** The effect of its latest call; null when the tool declares none (it then runs live after a fork). */
  effect: Effect | null;
  /** Calls in every run of the store, the runs they are in, and the latest. */
  calls: number;
  runs: number;
  lastAt: number;
  /** It was recorded with another effect before: the declaration changed. */
  changed: boolean;
  /** Its effect comes from `mcp.effects` in the config. */
  mcp: boolean;
  /** Its trust: the config's `tools`, else what its calls were recorded with, else trusted (tool-trust.ts toolTrust). */
  trust: 'trusted' | 'untrusted';
  from: TrustSource | null;
  /** Where the mark comes from, in the Trust column's words; null for a tool trusted by default. */
  where: string | null;
  /** The `tools` line that marks it the other way: Mark trusted's or Mark untrusted's. */
  flip: string;
  /** What a person typed (`meta.input`): never planted in, so it has no mark. */
  input: boolean;
  /** An untrusted read's Run injection test…: the run it tests and what its card says; null where no run reads it, and for every other tool. */
  test: ToolTest | null;
}

/** One line of the config's `tools` entry, as the file holds it: `  "get_ticket": { "trust": "untrusted" },`. */
export interface ToolsEntryLine {
  tool: string;
  text: string;
}

export interface HttpHostRow {
  /** A host under `http` in the config, or one the recordings called that the config no longer has. */
  host: string;
  effect: Effect | null;
  /** In the config now. */
  declared: boolean;
  /** Recorded calls to it, as tool calls named `METHOD host/path`. */
  calls: number;
  lastAt: number | null;
  error: string | null;
}

export interface ToolsSettings {
  config: ConfigInfo;
  /** The config's `tools` entry, a tool a line, `unrecorded` as written: the box under the table. */
  entry: ToolsEntryLine[];
  /** Runs live after a fork: read and pure tools, and tools that declare no effect. */
  live: ToolRow[];
  /** Blocked or stubbed after a fork: write tools. */
  fenced: ToolRow[];
  http: HttpHostRow[];
  mcp: {
    /** `mcp.effects` in the config: effects by tool name, over the servers' annotations. */
    effects: Array<{ tool: string; effect: Effect | null; seen: boolean; error: string | null }>;
    servers: McpServerRow[];
    /** Every server the recordings came through, those no project client config lists included (a config outside the project). */
    recorded: McpRecordedServer[];
    /** The client config files looked at, and why one couldn't be read. */
    files: Array<{ path: string; found: boolean; error: string | null }>;
    /**
     * The client configs to copy: one per project file that lists servers, each server with
     * `shadowlap mcp` in front, credentials and environment values left out and named in `putBack`;
     * without any, the example in docs/mcp.md (`file` null), which shows both forms.
     */
    clientConfigs: ClientConfigBlock[];
    /** The forms (`stdio`, a command; `http`, a URL) no server in the blocks uses: the page shows a line for each. Empty for the docs' example. */
    otherForms: Array<'stdio' | 'http'>;
  };
}

/** `GET api.example.com/v1/items`: how a call to a host under `http` is recorded. */
const HTTP_CALL = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) ([a-z0-9.*-]+(?::\d{1,5})?)(\/\S*)?$/i;

/** A rule's host against a recorded one, as the sidecar matches them: `*.` is any subdomain, a port must agree. */
function hostMatches(rule: string, host: string): boolean {
  const [ruleName, rulePort] = rule.toLowerCase().split(':') as [string, string | undefined];
  const [hostName, hostPort] = host.toLowerCase().split(':') as [string, string | undefined];
  // A recorded name leaves out a default port.
  if (rulePort !== undefined && rulePort !== hostPort && !(hostPort === undefined && (rulePort === '443' || rulePort === '80'))) return false;
  return ruleName.startsWith('*.') ? hostName.endsWith(ruleName.slice(1)) : hostName === ruleName;
}

const EFFECTS: readonly Effect[] = ['pure', 'read', 'write'];

const effectOf = (v: unknown): Effect | null => (EFFECTS.includes(v as Effect) ? (v as Effect) : null);

/** A JSON value on one line, spaced as the config's entries are written: `{ "trust": "untrusted" }`. */
function oneLine(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(oneLine).join(', ')}]`;
  if (isObject(v)) {
    const keys = Object.entries(v);
    return keys.length ? `{ ${keys.map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(v) ?? 'null';
}

/** The config's `tools` entry, a key a line with its comma, as the box under the Trust table shows it. */
export function toolsEntry(tools: unknown): ToolsEntryLine[] {
  if (!isObject(tools)) return [];
  const keys = Object.entries(tools);
  return keys.map(([tool, v], i) => ({ tool, text: `  ${JSON.stringify(tool)}: ${oneLine(v)}${i < keys.length - 1 ? ',' : ''}` }));
}

/** The config's trust marks, for a page read without the pooled job's: none where `tools` can't be read. */
function trustMarks(tools: unknown): ToolTrust | undefined {
  try {
    return parseToolTrust(tools);
  } catch {
    return undefined;
  }
}

/** A tool row's trust columns, from its trust row; trusted by default where none was read. */
function trustCells(name: string, t: ToolTrustRow | undefined, tests: Record<string, ToolTest>): Pick<ToolRow, 'trust' | 'from' | 'where' | 'flip' | 'input' | 'test'> {
  return {
    trust: t?.trust ?? 'trusted',
    from: t?.from ?? null,
    where: t?.where ?? null,
    flip: t?.flip ?? trustLine(name, 'untrusted'),
    input: t?.input ?? false,
    test: Object.hasOwn(tests, name) ? tests[name]! : null,
  };
}

/**
 * The Tools tab: every tool any run called, from one query across the store, by what happens to it
 * after a fork; the hosts under `http` and `mcp.effects` in the config; and the MCP servers the
 * project's client configs list, with the `shadowlap mcp` line that records each. The server hands
 * it the store's part, read beside it (`reads`); without them it reads them itself.
 */
export function toolsSettings(ctx: SettingsContext, options: { mcpDoc?: string | null; reads?: ToolReads | ToolsRead } = {}): ToolsSettings {
  const { info, file } = loadConfigFile(ctx.cwd);
  const data = file?.data ?? {};
  const mcpEffects = isObject(data.mcp) && isObject(data.mcp.effects) ? data.mcp.effects : {};
  const httpRules = isObject(data.http) ? Object.entries(data.http) : [];

  // One row per tool: the effect of its latest call, and whether an earlier one differed.
  const read = options.reads ?? toolReads(ctx.store);
  const { usage, mcp: mcpUsage } = read;
  const pooled = 'tests' in read ? (read as ToolsRead) : null;
  const trustBy = new Map((pooled?.trust ?? toolTrust(ctx.store, trustMarks(data.tools)).tools).map((t) => [t.name, t]));
  const tests = pooled?.tests ?? {};
  const tools = new Map<string, ToolRow>();
  const hostCalls = new Map<string, { calls: number; lastAt: number; effect: Effect | null }>();
  for (const u of usage) {
    const http = HTTP_CALL.exec(u.name);
    if (http) {
      const host = http[2]!.toLowerCase();
      const h = hostCalls.get(host) ?? { calls: 0, lastAt: 0, effect: u.effect };
      h.calls += u.calls;
      if (u.lastAt >= h.lastAt) {
        h.lastAt = u.lastAt;
        h.effect = u.effect;
      }
      hostCalls.set(host, h);
      continue;
    }
    const t = tools.get(u.name);
    if (!t) {
      tools.set(u.name, { name: u.name, effect: u.effect, calls: u.calls, runs: u.runs, lastAt: u.lastAt, changed: false, mcp: Object.hasOwn(mcpEffects, u.name), ...trustCells(u.name, trustBy.get(u.name), tests) });
      continue;
    }
    t.changed ||= t.effect !== u.effect;
    if (u.lastAt >= t.lastAt) {
      t.effect = u.effect;
      t.lastAt = u.lastAt;
    }
    t.calls += u.calls;
    t.runs += u.runs;
  }
  const rows = [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));

  const http: HttpHostRow[] = httpRules.map(([host, effect]) => {
    const seen = [...hostCalls.entries()].filter(([h]) => hostMatches(host, h));
    for (const [h] of seen) hostCalls.delete(h);
    return {
      host,
      effect: effectOf(effect),
      declared: true,
      calls: seen.reduce((n, [, s]) => n + s.calls, 0),
      lastAt: seen.length ? Math.max(...seen.map(([, s]) => s.lastAt)) : null,
      error: effectOf(effect) ? null : `${host} must map to pure, read or write`,
    };
  });
  for (const [host, s] of hostCalls) http.push({ host, effect: s.effect, declared: false, calls: s.calls, lastAt: s.lastAt, error: null });

  const effects = Object.entries(mcpEffects).map(([tool, effect]) => ({ tool, effect: effectOf(effect), seen: tools.has(tool), error: effectOf(effect) ? null : `mcp.effects["${tool}"] must be pure, read or write` }));
  const found = mcpServers(ctx.cwd);
  const recorded = recordedMcpServers(mcpUsage);
  const recordedKey = (r: { transport: string; server: string }) => `${r.transport} ${r.server}`;
  const byName = new Map(recorded.map((r) => [recordedKey(r), r]));
  const servers = found.servers.map((row) => {
    const match = byName.get(recordedKey(row.recordedAs)) ?? null;
    if (match) match.inConfig = true;
    return { ...row, recorded: match };
  });
  const doc = options.mcpDoc !== undefined ? options.mcpDoc : readShippedDoc('mcp.md');
  return {
    config: info,
    entry: toolsEntry(data.tools),
    live: rows.filter((t) => t.effect !== 'write'),
    fenced: rows.filter((t) => t.effect === 'write'),
    http,
    mcp: { effects, servers, recorded, files: found.files, ...clientConfigs(servers, doc === null ? null : mcpClientConfig(doc)) },
  };
}
