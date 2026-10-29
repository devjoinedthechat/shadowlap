import { canonicalize } from './canonical.js';
import { maskClock, maskClockText, type ClockMode, type ClockReference } from './clock.js';
import { asParsed, matchable } from './json-exact.js';
import { multipartView } from './multipart.js';
import { withoutPrompt } from './prompt.js';
import { sha256 } from './ids.js';
import { applyNormalizers, compilePattern, normalizerApplies, stripKeysDeep } from './normalize.js';
import type { CallKind, Normalizer } from './types.js';

/**
 * A fingerprint answers exactly one question: is this the same request?
 * Fingerprints are computed only here (in the engine); SDKs never reimplement hashing.
 */

/** The one built-in exclusion of a key: documented by the provider as behavior-neutral and moved routinely. */
export const BUILTIN_STRIPPED_KEYS: readonly string[] = ['cache_control'];

/**
 * Bump when fingerprints change meaning; stored fingerprints from another version are recomputed on
 * replay. 6: a model call's query string takes part (`ApiRequestShape.query`). 7: Claude Code's
 * session identifier in `metadata.user_id` is masked (`maskClaudeCodeSession`). 8: a clock or random
 * read's name takes part (`fingerprintMisc`), so `random()` is never `uuid()`. 9: a Gemini
 * conversation's function call ids count by the order they first appear in (`maskGeminiCallIds`).
 */
export const FINGERPRINT_VERSION = 9;

/**
 * A Gemini request body (`contents`, on the Gemini API and Vertex AI) with each function call's id
 * read as `<call-n>`, numbered in the order the ids first appear: Gemini's answers usually carry no id,
 * so a client that pairs calls with results by id makes its own up (the AI SDK, and Mastra on it, a
 * random one each run), and sends it back with the call and its result in every later request. Which
 * result answers which call still counts; the spelling of a made-up id doesn't. The body itself when
 * it has no such id.
 */
export function maskGeminiCallIds(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const given = (body as Record<string, unknown>).contents;
  if (!Array.isArray(given)) return body;
  const contents = given as unknown[];
  const numbered = new Map<string, string>();
  const masked = (id: unknown) => {
    if (typeof id !== 'string') return id;
    if (!numbered.has(id)) numbered.set(id, `<call-${numbered.size + 1}>`);
    return numbered.get(id);
  };
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const withId = (part: Record<string, unknown>, key: 'functionCall' | 'functionResponse') => {
    const inner = part[key];
    return isRecord(inner) && typeof inner.id === 'string' ? { ...part, [key]: { ...inner, id: masked(inner.id) } } : part;
  };
  let changed = false;
  const out = contents.map((turn) => {
    if (!isRecord(turn) || !Array.isArray(turn.parts)) return turn;
    const before = turn.parts as unknown[];
    const parts = before.map((p) => (isRecord(p) ? withId(withId(p, 'functionCall'), 'functionResponse') : p));
    if (parts.some((p, i) => p !== before[i])) {
      changed = true;
      return { ...turn, parts };
    }
    return turn;
  });
  // Spread defines its keys, so a `__proto__` key in the body stays a key.
  return changed ? { ...body, contents: out } : body;
}

// ---- Claude Code's session identifier ----

/** What a request's Claude Code session identifier reads as when it is matched. */
export const CLAUDE_CODE_SESSION = '<claude-code-session>';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE = /^[0-9a-f]{16,128}$/i;
/** The form earlier versions of Claude Code sent: `user_<device>_account_<account>_session_<session>`. */
const UNDERSCORED = /^user_[0-9a-f]{16,128}_account_[0-9a-f-]{0,64}_session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` is the identifier Claude Code sends as `metadata.user_id` in every model request,
 * the Claude Agent SDK's too, which runs Claude Code: a JSON object naming the device, the account
 * and the session (`{"device_id":"…","account_uuid":"","session_id":"…"}`, with keys of
 * `CLAUDE_CODE_EXTRA_METADATA` and a parent session beside them), or, as earlier versions sent it,
 * `user_<device>_account_<account>_session_<session>`. Nothing else sends either form, so no other
 * agent's metadata reads as one.
 */
export function isClaudeCodeSession(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 8192) return false;
  if (UNDERSCORED.test(value)) return true;
  if (!value.startsWith('{')) return false;
  let id: unknown;
  try {
    id = JSON.parse(value);
  } catch {
    return false;
  }
  if (typeof id !== 'object' || id === null || Array.isArray(id)) return false;
  const { device_id, account_uuid, session_id } = id as Record<string, unknown>;
  return typeof device_id === 'string' && DEVICE.test(device_id) && typeof account_uuid === 'string' && typeof session_id === 'string' && UUID.test(session_id);
}

/**
 * A request body with Claude Code's session identifier masked, as matching reads it: it changes with
 * every session, machine and account, and is no part of the prompt (the API takes `user_id` as an
 * opaque id of the user, which Anthropic may use to help detect abuse), so a recording made in one
 * session replays in the next. The body itself when it holds none.
 */
export function maskClaudeCodeSession(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const metadata = (body as Record<string, unknown>).metadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return body;
  if (!isClaudeCodeSession((metadata as Record<string, unknown>).user_id)) return body;
  // Spread defines its keys, so a `__proto__` key in the body stays a key.
  return { ...body, metadata: { ...metadata, user_id: CLAUDE_CODE_SESSION } };
}

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
 * The body's numbers count as they were sent, read with parseJsonExact (an integer past 2^53 by its
 * exact digits, so two ids that round alike are two requests), or with `opts.roundNumbers` as the
 * doubles JSON.parse reads: how a recording made before requests kept their numbers stored them.
 */
export function fingerprintApi(req: ApiRequestShape, normalizers: Normalizer[], allowHeaders: readonly string[], clock?: ClockReference, opts: { withoutPrompt?: boolean; matchPath?: string | undefined; roundNumbers?: boolean } = {}): Fingerprinted {
  const name = apiCallName(req.method, req.path);
  const headers: Record<string, string> = {};
  for (const h of allowHeaders) {
    const v = req.headers[h.toLowerCase()];
    if (v !== undefined) headers[h.toLowerCase()] = v;
  }
  // A form's parts, not its bytes: its client picks a new boundary for every request.
  const view = multipartView(apiNumbers(req.body, opts.roundNumbers === true));
  const stripped = maskGeminiCallIds(maskClaudeCodeSession(stripKeysDeep(opts.withoutPrompt ? withoutPrompt(view) : view, BUILTIN_STRIPPED_KEYS)));
  const body = applyNormalizers(clock === undefined ? stripped : maskClock(stripped, clock), normalizers, 'api', name);
  // Left out when there is none, so a call without a query keeps the fingerprint it always had.
  const query = queryIdentity(req.query, normalizers, name, clock);
  const canonical = canonicalize({ kind: 'api', method: req.method.toUpperCase(), path: opts.matchPath ?? req.path, headers, body, ...(query.length ? { query } : {}) });
  return { fingerprint: sha256(canonical), canonical };
}

/**
 * A model request's body as its fingerprint reads its numbers: an integer past 2^53 by its digits,
 * any other number as the double it reads as (`20.0` is `20`); or, `rounded`, every one as the double
 * JSON.parse reads. What the sidecar reads a request's dates from, as its fingerprint masks them.
 */
export function apiNumbers(body: unknown, rounded = false): unknown {
  return rounded ? asParsed(body) : matchable(body);
}

/** `args` may hold numbers kept as written (json-exact.ts): an integer past 2^53 matches by its exact digits. */
export function fingerprintTool(name: string, args: unknown, normalizers: Normalizer[], clock?: ClockReference): Fingerprinted {
  const exact = matchable(args);
  // Paths are relative to the stored request, `{ args }`, as in redaction rules and divergence reports: `$.args.path`.
  const normalized = (applyNormalizers({ args: clock === undefined ? exact : maskClock(exact, clock) }, normalizers, 'tool', name) as { args: unknown }).args;
  const canonical = canonicalize({ kind: 'tool', name, args: normalized });
  return { fingerprint: sha256(canonical), canonical };
}

/**
 * Clock and random reads: identity is the kind, the read's name (`now`, `random`, `uuid`) and an
 * optional caller-supplied label. The SDKs label none by default, so without the name a `random()`
 * the agent now makes first would take the recording's `uuid()`.
 */
export function fingerprintMisc(kind: Exclude<CallKind, 'api' | 'tool'>, name: string, label: string): Fingerprinted {
  const canonical = canonicalize({ kind, name, label });
  return { fingerprint: sha256(canonical), canonical };
}

/**
 * Identifies the fingerprinting a run's stored fingerprints are valid under: the algorithm version,
 * the exact normalizer list, the clock mode, and whether model requests' numbers were read rounded
 * (as a replay of a recording made before requests kept them reads them).
 */
export function normalizersHash(normalizers: Normalizer[], clock: ClockMode = 'exact', withoutPromptMask = false, roundedNumbers = false): string {
  const basis: Record<string, unknown> = { v: FINGERPRINT_VERSION, normalizers };
  if (clock !== 'exact') basis.clock = clock;
  if (withoutPromptMask) basis.prompt = 'masked';
  if (roundedNumbers) basis.numbers = 'rounded';
  return sha256(Buffer.from(canonicalize(basis), 'utf8'));
}
