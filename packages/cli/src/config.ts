import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { ClockMode, Effect, Normalizer, Price } from '@shadowlap/engine';
import { validHttpHost, type HttpRule } from '@shadowlap/sidecar';
import { parseTests, type TestEntry } from './checks.js';

export const CONFIG_FILE = 'shadowlap.config.json';

/**
 * The published schema for {@link CONFIG_FILE}. A new config points at it so an editor offers
 * completion and flags a typo before a run does. It is a raw GitHub URL rather than a domain,
 * because it has to resolve for anyone who opens the file today.
 */
export const CONFIG_SCHEMA_URL = 'https://raw.githubusercontent.com/devjoinedthechat/shadowlap/main/shadowlap.config.schema.json';

export interface ShadowlapConfig {
  /** Masked before fingerprinting; stored content is untouched. */
  normalize: Normalizer[];
  /** Applied to stored content on `shadowlap pack`; a redacted pack replays with these as normalizers. */
  redact: Normalizer[];
  /** USD per million tokens by model name prefix, for cost estimates; extends and overrides the built-in table. */
  prices?: Record<string, Price>;
  /** `shadowlap mcp`: effects by tool name, overriding the server's annotations. */
  mcp?: { effects: Record<string, Effect> };
  /** `auto` (default): dates and timestamps near each run's start match across days. `exact`: they must be equal. */
  clock?: ClockMode;
  /** HTTP hosts recorded as tools, from `"http": { "<host>": "<effect>" }`. */
  http?: HttpRule[];
  /** `shadowlap repair`: the model that proposes fixes (`provider:model`) and its base URL. */
  repair?: { repairer?: string; baseUrl?: string };
  // ---- Team store ----
  /** The team store, a bucket URL (`shadowlap store set`). Parsed in full by the commands that use it. */
  store?: string;
  /** False stops `test --push` from pushing in CI (Settings → Store, Push from CI). */
  ciPush?: boolean;
}

/** The project's config file. */
export function configPath(cwd: string): string {
  return join(cwd, CONFIG_FILE);
}

export function loadConfig(cwd: string): ShadowlapConfig {
  const path = configPath(cwd);
  if (!existsSync(path)) return { normalize: [], redact: [] };
  const file = basename(path);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ShadowlapConfig>;
  const config: ShadowlapConfig = { normalize: Array.isArray(parsed.normalize) ? parsed.normalize : [], redact: Array.isArray(parsed.redact) ? parsed.redact : [] };
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
  if (parsed.repair !== undefined) {
    const r = parsed.repair as unknown;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new Error(`${file}: repair must be an object, e.g. { "repairer": "anthropic:claude-opus-5-5" }`);
    const { repairer, baseUrl } = r as Record<string, unknown>;
    if (repairer !== undefined && typeof repairer !== 'string') throw new Error(`${file}: repair.repairer must be a string such as "anthropic:claude-opus-5-5"`);
    if (baseUrl !== undefined && typeof baseUrl !== 'string') throw new Error(`${file}: repair.baseUrl must be a URL`);
    config.repair = { ...(repairer ? { repairer } : {}), ...(baseUrl ? { baseUrl } : {}) };
  }
  // Team store: taken as written. A typo in the URL can't stop a recording: push, pull and the store
  // commands parse it and say what is wrong.
  if (parsed.store !== undefined) {
    if (typeof parsed.store !== 'string') throw new Error(`${file}: store must be a bucket URL such as s3://bucket/folder (set it with shadowlap store set)`);
    config.store = parsed.store;
  }
  if (parsed.ciPush !== undefined) {
    if (typeof parsed.ciPush !== 'boolean') throw new Error(`${file}: ciPush must be true or false (set it with shadowlap store push-from-ci on|off)`);
    config.ciPush = parsed.ciPush;
  }
  const prices = parsePrices(parsed.prices, file);
  if (prices) config.prices = prices;
  const mcp = parsed.mcp as { effects?: unknown } | undefined;
  if (mcp && typeof mcp === 'object' && mcp.effects && typeof mcp.effects === 'object') {
    const effects: Record<string, Effect> = {};
    for (const [name, effect] of Object.entries(mcp.effects as Record<string, unknown>)) {
      if (effect !== 'pure' && effect !== 'read' && effect !== 'write') throw new Error(`${file}: mcp.effects["${name}"] must be pure, read or write`);
      effects[name] = effect;
    }
    config.mcp = { effects };
  }
  return config;
}

function parsePrices(raw: unknown, file = CONFIG_FILE): Record<string, Price> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, Price> = {};
  for (const [model, p] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof p !== 'object' || p === null) continue;
    const { input, output, cacheRead, cacheWrite } = p as Record<string, unknown>;
    if (typeof input !== 'number' || typeof output !== 'number') throw new Error(`${file}: prices["${model}"] needs numeric "input" and "output" (USD per million tokens)`);
    out[model] = { input, output, ...(typeof cacheRead === 'number' ? { cacheRead } : {}), ...(typeof cacheWrite === 'number' ? { cacheWrite } : {}) };
  }
  return out;
}

/**
 * Writes the rules commands edit (normalizers and redaction) into the file, keeping everything else
 * as the user wrote it: tests, prices, and keys this version doesn't know.
 */
export function saveConfig(cwd: string, config: Pick<ShadowlapConfig, 'normalize' | 'redact'>): void {
  const path = configPath(cwd);
  const existing = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  writeFileSync(path, JSON.stringify({ ...existing, normalize: config.normalize, redact: config.redact }, null, 2) + '\n');
}

/** `shadowlap test` outcome checks, read only by that command so a mistake in them can't stop a recording. */
export function loadTests(cwd: string): TestEntry[] {
  const path = configPath(cwd);
  if (!existsSync(path)) return [];
  return parseTests((JSON.parse(readFileSync(path, 'utf8')) as { tests?: unknown }).tests);
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

/**
 * Base URLs a user already sets for a provider's SDK. `shadowlap run` replaces them with the sidecar
 * for the agent, so the sidecar forwards to them: an OpenAI-compatible server in OPENAI_BASE_URL
 * stays the upstream. A value that is itself a Shadowlap sidecar (a nested run) is ignored.
 */
const SDK_BASE_URLS: Array<[string, string, (v: string) => string]> = [
  ['ANTHROPIC_BASE_URL', 'anthropic', (v) => v],
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
