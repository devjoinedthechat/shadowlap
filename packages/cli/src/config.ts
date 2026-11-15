import { execFile, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_FILE, configBuild, configFilePath, editConfigFile, messageOf, parseRules, parseToolTrust, parseUnrecordedConfig, readConfigFile, type ClockMode, type Effect, type Normalizer, type Price, type Rates, type ToolTrust } from '@shadowlap/engine';
import { declareFormatHosts, formatHostProblem, validHttpHost, type FormatHost, type HttpRule } from '@shadowlap/sidecar';
import { parseTests, parseTestSettings, type TestEntry, type TestSettings } from './checks.js';
import { usageError } from './exit-codes.js';

// The file itself (reading it, and every edit to it) is the engine's, shared with the dashboard.
export { CONFIG_FILE };

/**
 * The published schema for {@link CONFIG_FILE}. A new config points at it so an editor offers
 * completion and flags a typo before a run does. It is a raw GitHub URL rather than a domain,
 * because it has to resolve for anyone who opens the file today.
 */
export const CONFIG_SCHEMA_URL = 'https://raw.githubusercontent.com/devjoinedthechat/shadowlap/main/shadowlap.config.schema.json';

export interface ShadowlapConfig {
  /** Masked before fingerprinting; stored content is untouched. */
  normalize: Normalizer[];
  /** Applied to every export, pack and share link of a run (see REDACTION_EXPORTS); a redacted pack replays with these as normalizers. */
  redact: Normalizer[];
  /** USD per million tokens by model name prefix, for cost estimates; extends and overrides the built-in table. */
  prices?: Record<string, Price>;
  /** `shadowlap mcp`: effects by tool name, overriding the server's annotations. */
  mcp?: { effects: Record<string, Effect> };
  /** `auto` (default): dates and timestamps near each run's start match across days. `exact`: they must be equal. */
  clock?: ClockMode;
  /** HTTP hosts recorded as tools, from `"http": { "<host>": "<effect>" }`. */
  http?: HttpRule[];
  /**
   * Hosts of a provider's wire format, recorded as that provider's calls: `"providers": [{ "host":
   * "openrouter.ai", "format": "openai", "root": "/api/v1" }]`. Every sidecar the command starts
   * serves them, and capture sends their calls there (declareFormatHosts).
   */
  providers?: FormatHost[];
  /** `shadowlap repair`: the model that proposes fixes (`provider:model`), its base URL, and how long it may take to answer, in seconds. */
  repair?: { repairer?: string; baseUrl?: string; timeout?: number };
  /** The command that builds the agent, such as `npm run build`: what `--build` runs where a command takes it and none is given (buildCommand). */
  build?: string;
  /**
   * `shadowlap verify`: how a good run is kept. Not worse than its baseline by `margin` or more (0.1
   * is 10 points), the baseline the same run at the base revision (`paired`) or its golden's test
   * history (`history`), up to `max` pairs or attempts. Flags override each.
   */
  verify?: { margin?: number; baseline?: 'paired' | 'history'; max?: number };
  /** Tools by name (or a captured HTTP call's host): `trust` marks the reads `shadowlap injection` plants in, over what the SDK or an MCP server declared. */
  tools?: ToolTrust;
  /** `tools.unrecorded`: the effect of tools the agent runs without shadowlap recording them, which decides whether `replay` and `test` may run them again. */
  unrecorded?: Record<string, 'read' | 'write'>;
  /**
   * The network guard: `accept` names the runtimes whose unwatched connections `--guard block` takes
   * as they are, the Claude Code CLI the Claude Agent SDK runs (`claude-code`) alone. Node and Python
   * keep block.
   */
  guard?: { accept: string[] };
  // ---- Team store ----
  /** The team store, a bucket URL (`shadowlap store set`). Parsed in full by the commands that use it. */
  store?: string;
  /** False stops `test --push` from pushing in CI (Settings → Store, Push from CI). */
  ciPush?: boolean;
}

/** The project's config file. */
export function configPath(cwd: string): string {
  return configFilePath(cwd);
}

/**
 * The project's config. A missing file is an empty config. Each list of rules is checked when a
 * command first uses it, as every writer checks a rule (a bad pattern or path, or a kind that
 * doesn't exist, is named with the rule's number as `ls` shows it), so a broken redaction rule
 * stops `pack` and the exports, which apply it, but not a recording, and a broken normalizer stops
 * what records or replays, but not the dashboard that shows it and can remove it. Everything else
 * is checked here.
 */
export function loadConfig(cwd: string): ShadowlapConfig {
  const stored = readConfigFile(cwd);
  // The hosts a config declares are this process's: none until a config says so.
  declareFormatHosts([]);
  if (!stored.exists) return { normalize: [], redact: [] };
  const file = CONFIG_FILE;
  const parsed = stored.data as Partial<ShadowlapConfig>;
  const config: Partial<ShadowlapConfig> = {};
  Object.defineProperty(config, 'normalize', checkedOnFirstUse('normalize', parsed.normalize));
  Object.defineProperty(config, 'redact', checkedOnFirstUse('redact', parsed.redact));
  if (parsed.clock !== undefined) {
    if (parsed.clock !== 'auto' && parsed.clock !== 'exact') throw new Error(`${file}: clock must be "auto" or "exact"`);
    config.clock = parsed.clock;
  }
  if (parsed.http !== undefined) {
    const raw = parsed.http as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file}: http must map hosts to effects, e.g. { "*.pinecone.io": "read" }`);
    config.http = Object.entries(raw as Record<string, unknown>).map(([host, effect]) => {
      if (!validHttpHost(host.toLowerCase())) throw new Error(`${file}: http["${host}"]: a host is a name like api.example.com or *.example.com, with an optional :port`);
      if (effect !== 'pure' && effect !== 'read' && effect !== 'write') throw new Error(`${file}: http["${host}"] must be pure, read or write`);
      return { host: host.toLowerCase(), effect };
    });
  }
  // Hosts of a provider's wire format: checked here, since capture and every sidecar take them.
  if (parsed.providers !== undefined) {
    const raw = parsed.providers as unknown;
    if (!Array.isArray(raw)) throw new Error(`${file}: providers must be a list, such as [{ "host": "openrouter.ai", "format": "openai", "root": "/api/v1" }]`);
    const seen = new Set<string>();
    config.providers = (raw as unknown[]).map((given, i) => {
      // Host names read in any case, as under http.
      const entry = typeof given === 'object' && given !== null && typeof (given as { host?: unknown }).host === 'string' ? { ...given, host: (given as { host: string }).host.toLowerCase() } : given;
      const problem = formatHostProblem(entry, `providers[${i}]`);
      if (problem) throw new Error(`${file}: ${problem}`);
      const { host, format, root } = entry as FormatHost;
      if (seen.has(host)) throw new Error(`${file}: providers[${i}].host "${host}" is declared twice`);
      seen.add(host);
      return { host, format, ...(root !== undefined ? { root } : {}) };
    });
    declareFormatHosts(config.providers);
  }
  if (parsed.repair !== undefined) config.repair = parseRepairConfig(parsed.repair, file);
  // The agent's build: what --build runs where it isn't given.
  const build = configBuild(parsed.build, file);
  if (build) config.build = build;
  // verify: how a good run is kept against its baseline.
  if (parsed.verify !== undefined) config.verify = parseVerifyConfig(parsed.verify, file);
  // Team store: taken as written. A typo in the URL can't stop a recording: push, pull and the store
  // commands parse it and say what is wrong.
  if (parsed.store !== undefined) {
    if (typeof parsed.store !== 'string') throw new Error(`${file}: store must be a bucket URL such as s3://<bucket>/<folder> (set it with shadowlap store set)`);
    config.store = parsed.store;
  }
  if (parsed.ciPush !== undefined) {
    if (typeof parsed.ciPush !== 'boolean') throw new Error(`${file}: ciPush must be true or false (set it with shadowlap store push-from-ci on|off)`);
    config.ciPush = parsed.ciPush;
  }
  if (parsed.guard !== undefined) config.guard = { accept: parseGuardAccept(parsed.guard, file) };
  const prices = parsePrices(parsed.prices, file);
  if (prices) config.prices = prices;
  // Injection tests: which reads bring outside text in. A mistake here is named, as for http.
  if (parsed.tools !== undefined) {
    config.tools = parseToolTrust(parsed.tools, file);
    const unrecorded = parseUnrecordedConfig(parsed.tools, file);
    if (unrecorded) config.unrecorded = unrecorded;
  }
  const mcp = parsed.mcp as { effects?: unknown } | undefined;
  if (mcp && typeof mcp === 'object' && mcp.effects && typeof mcp.effects === 'object') {
    const effects: Record<string, Effect> = {};
    for (const [name, effect] of Object.entries(mcp.effects as Record<string, unknown>)) {
      if (effect !== 'pure' && effect !== 'read' && effect !== 'write') throw new Error(`${file}: mcp.effects["${name}"] must be pure, read or write`);
      effects[name] = effect;
    }
    config.mcp = { effects };
  }
  // Whole once its two lists are defined on it, each checked on first use.
  return config as ShadowlapConfig;
}

/** The runtimes `--guard block` can accept unwatched: the Claude Code CLI alone, which no preload loads into. */
export const ACCEPTABLE_RUNTIMES = ['claude-code'] as const;

/** The `guard` section: `{ "accept": ["claude-code"] }`. */
function parseGuardAccept(raw: unknown, file: string): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file}: guard must be an object, e.g. { "accept": ["claude-code"] }`);
  const { accept, ...rest } = raw as Record<string, unknown>;
  const unknown = Object.keys(rest)[0];
  if (unknown !== undefined) throw new Error(`${file}: guard has an unknown key "${unknown}" (expected "accept")`);
  if (accept === undefined) return [];
  if (!Array.isArray(accept)) throw new Error(`${file}: guard.accept must be a list, e.g. ["claude-code"]`);
  return acceptList(accept, `${file}: guard.accept`);
}

/** A list of runtimes to accept, each one `--guard block` can accept, or the usage error (2) that names the one it can't. */
function acceptList(items: readonly unknown[], where: string): string[] {
  for (const item of items) {
    if (!(ACCEPTABLE_RUNTIMES as readonly unknown[]).includes(item)) {
      throw usageError(`${where} takes "claude-code" alone, not ${JSON.stringify(item)}: a Node or Python process whose guard is off still fails --guard block`);
    }
  }
  return [...new Set(items as string[])];
}

/**
 * The runtimes `--guard block` accepts unwatched for a run in `cwd`: the config's `guard.accept`, and
 * SHADOWLAP_GUARD_ACCEPT (names separated by commas, as the GitHub Action's guard-accept input sets it).
 */
export function guardAccept(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const stored = readConfigFile(cwd);
  const fromConfig = stored.exists && (stored.data as { guard?: unknown }).guard !== undefined ? parseGuardAccept((stored.data as { guard?: unknown }).guard, CONFIG_FILE) : [];
  const fromEnv = (env.SHADOWLAP_GUARD_ACCEPT ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  return [...new Set([...fromConfig, ...acceptList(fromEnv, 'SHADOWLAP_GUARD_ACCEPT')])];
}

/** The `repair` section: the repairer as `provider:model`, its base URL, and how long it may take to answer. */
function parseRepairConfig(raw: unknown, file: string): NonNullable<ShadowlapConfig['repair']> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file}: repair must be an object, e.g. { "repairer": "anthropic:claude-opus-5-5" }`);
  const { repairer, baseUrl, timeout } = raw as Record<string, unknown>;
  if (repairer !== undefined && typeof repairer !== 'string') throw new Error(`${file}: repair.repairer must be a string such as "anthropic:claude-opus-5-5"`);
  if (baseUrl !== undefined && typeof baseUrl !== 'string') throw new Error(`${file}: repair.baseUrl must be a URL`);
  // How long the repairer may take to answer (shadowlap repair --repairer-timeout).
  if (timeout !== undefined && !(typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0)) throw new Error(`${file}: repair.timeout must be a whole number of seconds, such as 600`);
  return { ...(repairer ? { repairer } : {}), ...(baseUrl ? { baseUrl } : {}), ...(timeout !== undefined ? { timeout: timeout } : {}) };
}

/**
 * The command that builds the agent where a command takes `--build`: the flag as given, `--build ""`
 * for none, else `build` in shadowlap.config.json (`config`, read only then), else none. `note` is the
 * line a command's progress says when the config gave it, so a build nobody typed is never a surprise.
 */
export function buildCommand(flag: string | undefined, config: () => Pick<ShadowlapConfig, 'build'>): { command: string | null; note: string | null } {
  if (flag !== undefined) return { command: flag.trim() ? flag : null, note: null };
  const command = config().build ?? null;
  return { command, note: command ? configBuildNote(command) : null };
}

/** The line that says a build came from the config, and how to run none. */
export const configBuildNote = (command: string): string => `build: ${command}, from ${CONFIG_FILE} (--build "" for none)`;

/** The `verify` section: a margin between 0 and 1, `paired` or `history`, a whole number of pairs or attempts. */
function parseVerifyConfig(raw: unknown, file: string): NonNullable<ShadowlapConfig['verify']> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file}: verify must be an object, e.g. { "margin": 0.1 }`);
  const { margin, baseline, max, ...rest } = raw as Record<string, unknown>;
  const unknown = Object.keys(rest)[0];
  if (unknown !== undefined) throw new Error(`${file}: verify has an unknown key "${unknown}" (expected "margin", "baseline", "max")`);
  if (margin !== undefined && (typeof margin !== 'number' || !(margin > 0 && margin < 1))) throw new Error(`${file}: verify.margin must be a number between 0 and 1, such as 0.1 (a drop of 10 points)`);
  if (baseline !== undefined && baseline !== 'paired' && baseline !== 'history') throw new Error(`${file}: verify.baseline must be "paired" or "history"`);
  if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 1000)) throw new Error(`${file}: verify.max must be a whole number from 1 to 1000`);
  return { ...(margin !== undefined ? { margin: margin } : {}), ...(baseline !== undefined ? { baseline: baseline } : {}), ...(max !== undefined ? { max: max } : {}) };
}

/**
 * The normalizers a copy's Show diff reads (export html, team share), as the dashboard's export reads
 * them: none when one can't be read, which `warn` names once. A broken redaction rule still stops the
 * copy, which applies it: read the redaction rules first.
 */
export function copyNormalizers(config: Pick<ShadowlapConfig, 'normalize'>, warn: (line: string) => void): Normalizer[] {
  try {
    return config.normalize;
  } catch (err) {
    warn(`${messageOf(err)}; the copy's Show diff applies no normalizers`);
    return [];
  }
}

/**
 * A list of rules as a property that checks it the first time a command reads it. It behaves as a
 * plain property otherwise: a command may replace the list (to put rules in front of the project's),
 * copy the config or spread it.
 */
function checkedOnFirstUse(list: 'normalize' | 'redact', raw: unknown): PropertyDescriptor {
  let rules: Normalizer[] | undefined;
  return {
    enumerable: true,
    configurable: true,
    get: () => (rules ??= parseRules(raw, list)),
    set: (value: Normalizer[]) => {
      rules = value;
    },
  };
}

function parsePrices(raw: unknown, file = CONFIG_FILE): Record<string, Price> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, Price> = {};
  for (const [model, p] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof p !== 'object' || p === null) continue;
    const rates = parseRates(p as Record<string, unknown>);
    if (!rates) throw new Error(`${file}: prices["${model}"] needs numeric "input" and "output" (USD per million tokens)`);
    const above = (p as Record<string, unknown>).above;
    if (above === undefined) {
      out[model] = rates;
      continue;
    }
    const long = typeof above === 'object' && above !== null && !Array.isArray(above) ? parseRates(above as Record<string, unknown>) : null;
    const tokens = long ? (above as Record<string, unknown>).tokens : undefined;
    if (!long || typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 1) throw new Error(`${file}: prices["${model}"].above needs a whole number of "tokens" (1 or more) and numeric "input" and "output": the rates of a call whose prompt is longer`);
    out[model] = { ...rates, above: { tokens, ...long } };
  }
  return out;
}

/** One rate card of a price: `input` and `output`, and the cache's rates when given; null without the first two. */
function parseRates(p: Record<string, unknown>): Rates | null {
  const { input, output, cacheRead, cacheWrite } = p;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  return { input, output, ...(typeof cacheRead === 'number' ? { cacheRead } : {}), ...(typeof cacheWrite === 'number' ? { cacheWrite } : {}) };
}

/**
 * Writes the rules commands edit (normalizers and redaction) into the file, keeping everything else
 * as the user wrote it: tests, prices, and keys this version doesn't know. One atomic replace, under
 * the lock every writer takes. Commands that add or remove one rule use addRule and removeRule.
 */
export function saveConfig(cwd: string, config: Pick<ShadowlapConfig, 'normalize' | 'redact'>): void {
  editConfigFile(cwd, {}, (data) => {
    data.normalize = config.normalize;
    data.redact = config.redact;
  });
}

/** `shadowlap test` outcome checks, read only by that command so a mistake in them can't stop a recording. */
export function loadTests(cwd: string): TestEntry[] {
  const stored = readConfigFile(cwd);
  if (!stored.exists) return [];
  return parseTests((stored.data as { tests?: unknown }).tests);
}

/** `shadowlap test`'s own settings under `tests`: `suiteRisk` and `baselineBranch`. */
export function loadTestSettings(cwd: string): TestSettings {
  const stored = readConfigFile(cwd);
  if (!stored.exists) return {};
  return parseTestSettings((stored.data as { tests?: unknown }).tests);
}

/** The store for a project: `.shadowlap/shadowlap.db` in its folder. */
export function defaultDbPath(cwd: string): string {
  return resolve(cwd, '.shadowlap', 'shadowlap.db');
}

/** `<short sha>` plus `+dirty` when the working tree has changes; null outside a git repository. */
export function codeVersion(cwd: string): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return null;
  }
}

const execFileAsync = promisify(execFile);

/**
 * codeVersion, read without holding the process up: for what reads it once per attempt, beside a
 * sidecar in the same process that answers other attempts' agents meanwhile. git's two questions are
 * asked at once, as processes of their own.
 */
export async function readCodeVersion(cwd: string): Promise<string | null> {
  const git = async (args: string[]) => (await execFileAsync('git', args, { cwd })).stdout;
  try {
    const [sha, status] = await Promise.all([git(['rev-parse', '--short', 'HEAD']), git(['status', '--porcelain', '--untracked-files=no'])]);
    return status.trim().length > 0 ? `${sha.trim()}+dirty` : sha.trim();
  } catch {
    return null;
  }
}

/**
 * Base URLs a user already sets for a provider's SDK. `shadowlap run` replaces them with the sidecar
 * for the agent, so the sidecar forwards to them: an OpenAI-compatible server in OPENAI_BASE_URL
 * stays the upstream. A value that is itself a shadowlap sidecar (a nested run) is ignored. An
 * ANTHROPIC_BASE_URL that ends in /v1, as the Vercel AI SDK's Anthropic provider reads it, is a root
 * plus /v1: the sidecar forwards each Anthropic call under /v1, whichever SDK sent it.
 */
const SDK_BASE_URLS: Array<[string, string, (v: string) => string]> = [
  ['ANTHROPIC_BASE_URL', 'anthropic', (v) => v.replace(/\/v1\/?$/, '')],
  ['OPENAI_BASE_URL', 'openai', (v) => v.replace(/\/v1\/?$/, '')],
  ['GOOGLE_GEMINI_BASE_URL', 'gemini', (v) => v],
];

/** Per-provider upstream overrides from the environment: SHADOWLAP_UPSTREAM_<PROVIDER> (a mock, a local server), else the SDK's own base URL. */
export function upstreamOverrides(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, id, toUpstream] of SDK_BASE_URLS) {
    const value = env[name]?.trim();
    if (!value || /\/t\/[0-9a-f]{32}(\/|$)/.test(value)) continue;
    try {
      new URL(value);
      out[id] = toUpstream(value).replace(/\/+$/, '');
    } catch {
      // not a URL: leave the provider's default
    }
  }
  for (const [k, v] of Object.entries(env)) {
    const m = /^SHADOWLAP_UPSTREAM_([A-Z0-9_]+)$/.exec(k);
    if (m && v) out[m[1]!.toLowerCase()] = v;
  }
  return out;
}
