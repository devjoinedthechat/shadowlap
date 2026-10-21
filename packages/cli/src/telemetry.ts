import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Anonymous, opt-out usage telemetry: counts and versions, never content.
 *
 * What is sent: a random install id, the Shadowlap version, OS, architecture, Node version, the
 * CI system if any, which providers and SDK languages a run used, the event type, and per-run
 * counts (calls by origin, divergence type, tokens not re-spent, duration, exit code).
 * What is never sent: prompts, tool arguments or results, file paths, hostnames, run ids, model
 * names, or anything the agent saw. The collector enforces the same allowlist server-side.
 *
 * Disable with SHADOWLAP_TELEMETRY=0 or DO_NOT_TRACK=1. Point at a collector with
 * SHADOWLAP_TELEMETRY_URL.
 */

/**
 * The collector events go to when SHADOWLAP_TELEMETRY_URL is not set. Empty, and it stays empty:
 * the project runs no collector and does not intend to. Telemetry exists for people who want to
 * measure their own usage, by pointing SHADOWLAP_TELEMETRY_URL at a collector they host
 * (packages/collector). A default here would have to be a domain the project controls, and
 * whoever holds a domain receives what is sent to it.
 */
export const DEFAULT_TELEMETRY_URL = '';
export const TELEMETRY_DOCS_URL = 'https://github.com/devjoinedthechat/shadowlap/blob/main/docs/telemetry.md';
export const TELEMETRY_SCHEMA_VERSION = 1;

export type TelemetryEventType = 'run' | 'replay' | 'test' | 'ui' | 'pack';

export interface TelemetryEvent {
  type: TelemetryEventType;
  at: number;
  version: string;
  os: string;
  arch: string;
  node: string;
  ci: string | null;
  providers: string[];
  sdks: string[];
  calls: number;
  replayed: number;
  live: number;
  blocked: number;
  stubbed: number;
  overridden: number;
  divergence: string | null;
  tokensNotRespent: number;
  durationMs: number;
  exitCode: number | null;
}

export type EventInput = Pick<TelemetryEvent, 'type'> & Partial<Omit<TelemetryEvent, 'type' | 'at' | 'version' | 'os' | 'arch' | 'node' | 'ci'>>;

export interface TelemetryBatch {
  v: typeof TELEMETRY_SCHEMA_VERSION;
  installId: string;
  sentAt: number;
  events: TelemetryEvent[];
}

interface Persisted {
  installId: string;
  noticeShownAt?: number;
}

export function isDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const t = (env.SHADOWLAP_TELEMETRY ?? '').toLowerCase();
  const dnt = (env.DO_NOT_TRACK ?? '').toLowerCase();
  return t === '0' || t === 'false' || t === 'off' || dnt === '1' || dnt === 'true';
}

export function detectCi(env: NodeJS.ProcessEnv): string | null {
  if (env.GITHUB_ACTIONS) return 'github';
  if (env.GITLAB_CI) return 'gitlab';
  if (env.CIRCLECI) return 'circleci';
  if (env.BUILDKITE) return 'buildkite';
  if (env.JENKINS_URL) return 'jenkins';
  if (env.TF_BUILD) return 'azure';
  if (env.CI) return 'other';
  return null;
}

/** In CI, a stable id derived from the repository's numeric id (never its name), so ephemeral runners don't count as new installs. */
function ciInstallId(env: NodeJS.ProcessEnv): string | null {
  const repoId = env.GITHUB_REPOSITORY_ID ?? env.CI_PROJECT_ID;
  if (!repoId) return null;
  return 'ci-' + createHash('sha256').update(`shadowlap:${repoId}`).digest('hex').slice(0, 32);
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'shadowlap');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'shadowlap');
}

export interface TelemetryOptions {
  version: string;
  env?: NodeJS.ProcessEnv;
  /** Where the install id and notice flag live. */
  dir?: string;
  /** Where to POST. Empty disables sending. */
  url?: string;
  notice?: (line: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The collector rejects a whole batch over one value outside its allowlist, so values are mapped
 * onto the lists it knows before sending: an unknown SDK family becomes "other", an unknown
 * provider is dropped. Keep these in step with packages/collector/src/schema.ts.
 */
export const KNOWN_PROVIDERS = ['anthropic', 'openai', 'gemini', 'azure', 'vertex', 'bedrock'] as const;
export const KNOWN_SDKS = ['typescript', 'python', 'mcp', 'other'] as const;

function allowed(values: readonly string[] | undefined, known: readonly string[], fallback: string | null): string[] {
  const out = new Set<string>();
  for (const v of values ?? []) {
    if (known.includes(v)) out.add(v);
    else if (fallback) out.add(fallback);
  }
  return [...out].sort();
}

export class Telemetry {
  readonly enabled: boolean;
  readonly installId: string;
  readonly url: string;
  private readonly events: TelemetryEvent[] = [];
  private readonly version: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: TelemetryOptions) {
    this.version = opts.version;
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.url = opts.url ?? this.env.SHADOWLAP_TELEMETRY_URL ?? DEFAULT_TELEMETRY_URL;
    this.enabled = !isDisabledByEnv(this.env) && this.url !== '';
    const dir = opts.dir ?? configDir(this.env);
    const persisted = this.enabled ? loadPersisted(dir) : null;
    this.installId = ciInstallId(this.env) ?? persisted?.installId ?? randomUUID();
    if (this.enabled && persisted && !persisted.noticeShownAt && !detectCi(this.env)) {
      (opts.notice ?? ((line) => process.stderr.write(line + '\n')))(
        `Shadowlap collects anonymous usage statistics (counts and versions, never prompts or tool data). Disable with SHADOWLAP_TELEMETRY=0. Details: ${TELEMETRY_DOCS_URL}`,
      );
      savePersisted(dir, { ...persisted, noticeShownAt: Date.now() });
    }
  }

  record(input: EventInput): TelemetryEvent | null {
    if (!this.enabled) return null;
    const event: TelemetryEvent = {
      type: input.type,
      at: Date.now(),
      version: this.version,
      os: process.platform,
      arch: process.arch,
      node: process.versions.node,
      ci: detectCi(this.env),
      providers: allowed(input.providers, KNOWN_PROVIDERS, null),
      sdks: allowed(input.sdks, KNOWN_SDKS, 'other'),
      calls: input.calls ?? 0,
      replayed: input.replayed ?? 0,
      live: input.live ?? 0,
      blocked: input.blocked ?? 0,
      stubbed: input.stubbed ?? 0,
      overridden: input.overridden ?? 0,
      divergence: input.divergence ?? null,
      tokensNotRespent: input.tokensNotRespent ?? 0,
      durationMs: input.durationMs ?? 0,
      exitCode: input.exitCode ?? null,
    };
    this.events.push(event);
    return event;
  }

  /** Sends buffered events. Never throws, never blocks longer than the timeout. */
  async flush(): Promise<boolean> {
    if (!this.enabled || this.events.length === 0) return false;
    const batch: TelemetryBatch = { v: TELEMETRY_SCHEMA_VERSION, installId: this.installId, sentAt: Date.now(), events: this.events.splice(0) };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch), signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function loadPersisted(dir: string): Persisted {
  const file = join(dir, 'telemetry.json');
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Persisted>;
      if (typeof parsed.installId === 'string' && parsed.installId) return { installId: parsed.installId, ...(parsed.noticeShownAt ? { noticeShownAt: parsed.noticeShownAt } : {}) };
    }
  } catch {
    // unreadable: start over
  }
  const fresh: Persisted = { installId: randomUUID() };
  savePersisted(dir, fresh);
  return fresh;
}

function savePersisted(dir: string, value: Persisted): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telemetry.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // read-only home: telemetry still works for this session with an ephemeral id
  }
}
