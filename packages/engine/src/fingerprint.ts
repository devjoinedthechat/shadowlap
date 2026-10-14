import { canonicalize } from './canonical.js';
import { maskClock, type ClockMode } from './clock.js';
import { withoutPrompt } from './prompt.js';
import { sha256 } from './ids.js';
import { applyNormalizers, stripKeysDeep } from './normalize.js';
import type { CallKind, Normalizer } from './types.js';

/**
 * A fingerprint answers exactly one question: is this the same request?
 * Fingerprints are computed only here (in the engine); SDKs never reimplement hashing.
 */

/** The one built-in exclusion: documented by the provider as behavior-neutral and moved routinely. */
export const BUILTIN_STRIPPED_KEYS: readonly string[] = ['cache_control'];

/** Bump when fingerprints change meaning; stored fingerprints from another version are recomputed on replay. */
export const FINGERPRINT_VERSION = 2;

export interface ApiRequestShape {
  method: string;
  /** Path relative to the provider root, e.g. `/v1/messages`, without query string. */
  path: string;
  /** Lower-cased request headers. Only `allowHeaders` take part in the fingerprint. */
  headers: Record<string, string | undefined>;
  /** Parsed JSON body, or a string for non-JSON bodies. */
  body: unknown;
}

export function apiCallName(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export interface Fingerprinted {
  fingerprint: string;
  /** The canonical string that was hashed; useful in tests and for debugging normalizers. */
  canonical: string;
}

/**
 * `clock`: the run's start time, to mask dates and timestamps near it (see clock.ts); undefined
 * matches them exactly.
 */
export function fingerprintApi(req: ApiRequestShape, normalizers: Normalizer[], allowHeaders: readonly string[], clock?: number, opts: { withoutPrompt?: boolean } = {}): Fingerprinted {
  const name = apiCallName(req.method, req.path);
  const headers: Record<string, string> = {};
  for (const h of allowHeaders) {
    const v = req.headers[h.toLowerCase()];
    if (v !== undefined) headers[h.toLowerCase()] = v;
  }
  const stripped = stripKeysDeep(opts.withoutPrompt ? withoutPrompt(req.body) : req.body, BUILTIN_STRIPPED_KEYS);
  const body = applyNormalizers(clock === undefined ? stripped : maskClock(stripped, clock), normalizers, 'api', name);
  const canonical = canonicalize({ kind: 'api', method: req.method.toUpperCase(), path: req.path, headers, body });
  return { fingerprint: sha256(canonical), canonical };
}

export function fingerprintTool(name: string, args: unknown, normalizers: Normalizer[], clock?: number): Fingerprinted {
  // Paths are relative to the stored request, `{ args }`, as in redaction rules and divergence reports: `$.args.path`.
  const normalized = (applyNormalizers({ args: clock === undefined ? args : maskClock(args, clock) }, normalizers, 'tool', name) as { args: unknown }).args;
  const canonical = canonicalize({ kind: 'tool', name, args: normalized });
  return { fingerprint: sha256(canonical), canonical };
}

/** Clock and random reads: identity is the kind plus an optional caller-supplied label. */
export function fingerprintMisc(kind: Exclude<CallKind, 'api' | 'tool'>, label: string): Fingerprinted {
  const canonical = canonicalize({ kind, label });
  return { fingerprint: sha256(canonical), canonical };
}

/** Identifies the fingerprinting a run's stored fingerprints are valid under: the algorithm version, the exact normalizer list and the clock mode. */
export function normalizersHash(normalizers: Normalizer[], clock: ClockMode = 'exact', withoutPromptMask = false): string {
  const basis: Record<string, unknown> = { v: FINGERPRINT_VERSION, normalizers };
  if (clock !== 'exact') basis.clock = clock;
  if (withoutPromptMask) basis.prompt = 'masked';
  return sha256(Buffer.from(canonicalize(basis), 'utf8'));
}
