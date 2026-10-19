/**
 * Strict validation of a telemetry batch. Every field is allowlisted and typed; string fields
 * come from closed sets or narrow patterns. Anything else is rejected, so the collector cannot
 * store free text even if a client is buggy. Mirrors packages/cli/src/telemetry.ts.
 */

export const EVENT_TYPES = ['run', 'replay', 'test', 'ui', 'pack'] as const;
export const DIVERGENCE_TYPES = ['request_changed', 'new_call', 'forced', 'beyond_recording', 'ended_early'] as const;
export const PROVIDERS = ['anthropic', 'openai', 'gemini', 'azure', 'vertex', 'bedrock'] as const;
export const SDKS = ['typescript', 'python', 'mcp', 'other'] as const;
export const CI_SYSTEMS = ['github', 'gitlab', 'circleci', 'buildkite', 'jenkins', 'azure', 'other'] as const;
export const OSES = ['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix', 'android'] as const;
export const ARCHES = ['x64', 'arm64', 'arm', 'ia32', 'ppc64', 's390x', 'riscv64', 'loong64', 'mips', 'mipsel'] as const;
export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_BODY_BYTES = 64 * 1024;

export interface ValidEvent {
  type: (typeof EVENT_TYPES)[number];
  at: number;
  version: string;
  os: (typeof OSES)[number];
  arch: (typeof ARCHES)[number];
  node: string;
  ci: (typeof CI_SYSTEMS)[number] | null;
  providers: Array<(typeof PROVIDERS)[number]>;
  sdks: Array<(typeof SDKS)[number]>;
  calls: number;
  replayed: number;
  live: number;
  blocked: number;
  stubbed: number;
  overridden: number;
  divergence: (typeof DIVERGENCE_TYPES)[number] | null;
  tokensNotRespent: number;
  durationMs: number;
  exitCode: number | null;
}

export interface ValidBatch {
  v: 1;
  installId: string;
  sentAt: number;
  events: ValidEvent[];
}

const EVENT_KEYS = ['type', 'at', 'version', 'os', 'arch', 'node', 'ci', 'providers', 'sdks', 'calls', 'replayed', 'live', 'blocked', 'stubbed', 'overridden', 'divergence', 'tokensNotRespent', 'durationMs', 'exitCode'] as const;
const BATCH_KEYS = ['v', 'installId', 'sentAt', 'events'] as const;
const INSTALL_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ci-[0-9a-f]{32})$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
const NODE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export class ValidationError extends Error {}

function fail(msg: string): never {
  throw new ValidationError(msg);
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`${what}: unexpected field "${k}"`);
}

function count(v: unknown, name: string, max = 10_000_000): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) fail(`${name} must be an integer in [0, ${max}]`);
  return v;
}

function oneOf<T extends string>(v: unknown, set: readonly T[], name: string): T {
  if (typeof v !== 'string' || !(set as readonly string[]).includes(v)) fail(`${name} must be one of ${set.join(', ')}`);
  return v as T;
}

function listOf<T extends string>(v: unknown, set: readonly T[], name: string): T[] {
  if (!Array.isArray(v) || v.length > set.length) fail(`${name} must be a short array`);
  return v.map((x) => oneOf(x, set, name));
}

function timestamp(v: unknown, name: string): number {
  // Milliseconds between 2025-01-01 and 2100-01-01.
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1_735_689_600_000 || v > 4_102_444_800_000) fail(`${name} must be a millisecond timestamp`);
  return v;
}

export function validateEvent(raw: unknown): ValidEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('event must be an object');
  const e = raw as Record<string, unknown>;
  onlyKeys(e, EVENT_KEYS, 'event');
  if (typeof e.version !== 'string' || !VERSION.test(e.version)) fail('version must look like a semantic version');
  if (typeof e.node !== 'string' || !NODE_VERSION.test(e.node)) fail('node must look like a Node version');
  const exitCode = e.exitCode === null || e.exitCode === undefined ? null : count(e.exitCode, 'exitCode', 255);
  return {
    type: oneOf(e.type, EVENT_TYPES, 'type'),
    at: timestamp(e.at, 'at'),
    version: e.version,
    os: oneOf(e.os, OSES, 'os'),
    arch: oneOf(e.arch, ARCHES, 'arch'),
    node: e.node,
    ci: e.ci === null || e.ci === undefined ? null : oneOf(e.ci, CI_SYSTEMS, 'ci'),
    providers: listOf(e.providers ?? [], PROVIDERS, 'providers'),
    sdks: listOf(e.sdks ?? [], SDKS, 'sdks'),
    calls: count(e.calls ?? 0, 'calls'),
    replayed: count(e.replayed ?? 0, 'replayed'),
    live: count(e.live ?? 0, 'live'),
    blocked: count(e.blocked ?? 0, 'blocked'),
    stubbed: count(e.stubbed ?? 0, 'stubbed'),
    overridden: count(e.overridden ?? 0, 'overridden'),
    divergence: e.divergence === null || e.divergence === undefined ? null : oneOf(e.divergence, DIVERGENCE_TYPES, 'divergence'),
    tokensNotRespent: count(e.tokensNotRespent ?? 0, 'tokensNotRespent', 1_000_000_000_000),
    durationMs: count(e.durationMs ?? 0, 'durationMs', 1_000_000_000),
    exitCode,
  };
}

export function validateBatch(raw: unknown): ValidBatch {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('batch must be an object');
  const b = raw as Record<string, unknown>;
  onlyKeys(b, BATCH_KEYS, 'batch');
  if (b.v !== 1) fail('unsupported batch version');
  if (typeof b.installId !== 'string' || !INSTALL_ID.test(b.installId)) fail('installId must be a UUID or a ci- hash');
  if (!Array.isArray(b.events) || b.events.length === 0 || b.events.length > MAX_EVENTS_PER_BATCH) fail(`events must hold 1–${MAX_EVENTS_PER_BATCH} items`);
  return { v: 1, installId: b.installId, sentAt: timestamp(b.sentAt, 'sentAt'), events: b.events.map(validateEvent) };
}
