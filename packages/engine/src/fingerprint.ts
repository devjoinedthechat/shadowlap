import { canonicalize } from './canonical.js';
import { maskClock, maskClockText, type ClockMode, type ClockReference } from './clock.js';
import { matchable } from './json-exact.js';
import { multipartView } from './multipart.js';
import { withoutPrompt } from './prompt.js';
import { sha256 } from './ids.js';
import { applyNormalizers, compilePattern, normalizerApplies, stripKeysDeep } from './normalize.js';
import type { CallKind, Normalizer } from './types.js';

/**
 * A fingerprint answers exactly one question: is this the same request?
 * Fingerprints are computed only here (in the engine); SDKs never reimplement hashing.
 */

/** The one built-in exclusion: documented by the provider as behavior-neutral and moved routinely. */
export const BUILTIN_STRIPPED_KEYS: readonly string[] = ['cache_control'];

/**
 * Bump when fingerprints change meaning; stored fingerprints from another version are recomputed on
 * replay. 6: a model call's query string takes part (`ApiRequestShape.query`).
 */
export const FINGERPRINT_VERSION = 6;

export interface ApiRequestShape {
  method: string;
  /** Path relative to the provider root, e.g. `/v1/messages`, without query string. */
  path: string;
  /** Lower-cased request headers. Only `allowHeaders` take part in the fingerprint. */
  headers: Record<string, string | undefined>;
  /**
   * Parsed JSON body, or a string for non-JSON bodies: the base64 of their bytes, as the proxy
   * stores them. A multipart/form-data body is matched by its parts (multipart.ts).
   */
  body: unknown;
  /**
   * The query string's parameters that make the call what it is, URL-encoded, with or without `?`
   * (`alt=sse&api-version=2024-10-21`): the caller leaves credentials out (the sidecar's
   * `identityQuery`). Their order doesn't count (`queryPairs`).
   */
  query?: string | undefined;
}

/**
 * A query string's parameters as `[name, value]` pairs, decoded, sorted by name as RFC 8785 sorts
 * members (repeated names keep the order they were sent in, as a list's items do).
 */
export function queryPairs(query: string | undefined): Array<[string, string]> {
  if (!query) return [];
  const pairs = [...new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)];
  // Array.prototype.sort is stable: a repeated name's values stay in order.
  return pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A query's pairs as a fingerprint reads them: dates near the run's start masked and the pathless
 * pattern rules applied to each value, as to every string of the body. A rule with a path reaches
 * only the body.
 */
function queryIdentity(query: string | undefined, normalizers: Normalizer[], name: string, clock?: ClockReference): Array<[string, string]> {
  const rules = normalizers.filter((n) => n.path === undefined && n.pattern !== undefined && normalizerApplies(n, 'api', name));
  return queryPairs(query).map(([key, raw]) => {
    let value = clock === undefined ? raw : maskClockText(raw, clock);
    for (const n of rules) {
      const regex = compilePattern(n.pattern!);
      regex.lastIndex = 0;
      value = value.replace(regex, n.replace);
    }
    return [key, value];
  });
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
 * `clock`: the run's start time, to mask dates and timestamps near it (see clock.ts), or for a replay
 * its start and its recording's, which both sides of a match must use; undefined matches them exactly.
 * `opts.matchPath`: the path as it identifies the call, when the provider leaves something out of it
 * (a Vertex AI path without its project and location); normalizers still find the call by its name.
 */
export function fingerprintApi(req: ApiRequestShape, normalizers: Normalizer[], allowHeaders: readonly string[], clock?: ClockReference, opts: { withoutPrompt?: boolean; matchPath?: string | undefined } = {}): Fingerprinted {
  const name = apiCallName(req.method, req.path);
  const headers: Record<string, string> = {};
  for (const h of allowHeaders) {
    const v = req.headers[h.toLowerCase()];
    if (v !== undefined) headers[h.toLowerCase()] = v;
  }
  // A form's parts, not its bytes: its client picks a new boundary for every request.
  const view = multipartView(req.body);
  const stripped = stripKeysDeep(opts.withoutPrompt ? withoutPrompt(view) : view, BUILTIN_STRIPPED_KEYS);
  const body = applyNormalizers(clock === undefined ? stripped : maskClock(stripped, clock), normalizers, 'api', name);
  // Left out when there is none, so a call without a query keeps the fingerprint it always had.
  const query = queryIdentity(req.query, normalizers, name, clock);
  const canonical = canonicalize({ kind: 'api', method: req.method.toUpperCase(), path: opts.matchPath ?? req.path, headers, body, ...(query.length ? { query } : {}) });
  return { fingerprint: sha256(canonical), canonical };
}

/** `args` may hold numbers kept as written (json-exact.ts): an integer past 2^53 matches by its exact digits. */
export function fingerprintTool(name: string, args: unknown, normalizers: Normalizer[], clock?: ClockReference): Fingerprinted {
  const exact = matchable(args);
  // Paths are relative to the stored request, `{ args }`, as in redaction rules and divergence reports: `$.args.path`.
  const normalized = (applyNormalizers({ args: clock === undefined ? exact : maskClock(exact, clock) }, normalizers, 'tool', name) as { args: unknown }).args;
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
