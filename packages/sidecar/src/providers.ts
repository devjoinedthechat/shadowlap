import { ACCOUNT_HEADERS, decodedSegment, eventStreamMessages, isObject, type Usage } from '@shadowlap/engine';
import { PLACEHOLDER_AWS_ACCESS_KEY_ID, PLACEHOLDER_KEY } from './placeholders.js';

/**
 * A provider module is small and declarative: where to forward, which headers
 * take part in the fingerprint, which never get stored, how retries are marked, and how to read
 * usage out of a response. Fingerprinting and matching are provider-agnostic; adding a provider
 * must not touch the engine.
 */
export interface Provider {
  id: string;
  /** Where live calls go. Empty for a provider whose host depends on the account, region or deployment. */
  upstream: string;
  /** Environment to point the provider's official SDKs at the sidecar. `baseUrl` is the sidecar's provider root. */
  env: (baseUrl: string) => Record<string, string>;
  /**
   * The path `env` adds to the provider root for the SDK's base URL (`/v1` for OpenAI): the SDK's own
   * paths (`/chat/completions`) arrive under it. See `sdkBasesFromEnvironment`.
   */
  sdkPath?: string;
  /**
   * A request's path as the provider's API names it, for a client that reads the base URL `env` sets
   * as one that already holds part of the path: the Vercel AI SDK's Anthropic provider takes
   * ANTHROPIC_BASE_URL for an API root ending in `/v1` and sends `/messages`, where the official SDKs
   * send `/v1/messages`. The call is recorded, matched and forwarded under the path this returns.
   */
  apiPath?: (path: string) => string;
  /**
   * A request's path as it identifies the call, when part of it names where the call was made rather
   * than what it asks: Vertex AI's `/projects/<project>/locations/<region>`, so a recording replays
   * in a teammate's project or in CI's. The call keeps its full path as its name.
   */
  matchPath?: (path: string) => string;
  /** Lower-cased request headers that change model behavior and therefore fingerprint. */
  fingerprintHeaders: readonly string[];
  /**
   * The fingerprint headers that are parameters of the call, sent as headers rather than in its
   * body: Bedrock's guardrail, trace, latency profile and service tier. A run made before calls kept
   * them (`RunMeta.headerParameters`), or imported, holds none: a replay of it is matched, and kept,
   * without them.
   */
  headerParameters?: readonly string[];
  /**
   * The fingerprint header every request to the API names its version in (`anthropic-version`), and
   * the version Shadowlap names when it sends a recorded request that names none. A recording whose
   * calls to this provider name none (one imported from a trace, which never keeps the version) is
   * matched whatever version a replay's requests name, and the replay keeps none either.
   */
  apiVersion?: { header: string; default: string };
  /**
   * A request's headers as matching reads them, when part of a fingerprint header says how the call
   * signed in rather than what it asks: Anthropic's `oauth-…` betas, which a profile's sign-in
   * sends and a key doesn't. The headers are kept as sent; only matching leaves that part out.
   */
  matchHeaders?: (headers: Readonly<Record<string, string>>) => Record<string, string>;
  /** Lower-cased headers that are forwarded upstream but never stored. */
  credentialHeaders: readonly string[];
  /**
   * Where its official SDKs take a key from, when they take one from the environment. A replay's
   * agent gets `placeholders` (each variable with its placeholder value, placeholders.ts) when the
   * environment holds none of `credentials`, nor the files the CLI checks besides (AWS's shared
   * files, an Anthropic profile, the Azure CLI's sign-in): see the CLI's placeholder-keys.ts. A live
   * call that would carry one is refused, saying to set `set`. With `onlyWhereRecorded`, a replay
   * gives one only when the recording's own environment held the key, whatever the replay: a client
   * that signs in another way may refuse a key beside it (Azure's token provider). Absent for a
   * provider whose clients fetch a token before they call it (Vertex AI): no placeholder stands in.
   */
  keys?: {
    placeholders: Readonly<Record<string, string>>;
    /** Variables any one of which, set and not empty, is a credential its SDKs use, which a placeholder must not replace. */
    credentials: readonly string[];
    set: string;
    onlyWhereRecorded?: boolean;
  };
  /** Header the official SDKs set to the retry attempt number (0 on the first attempt). */
  retryCountHeader?: string;
  isRetryableStatus(status: number): boolean;
  /** Usage with `inputTokens` as *uncached* input, whatever the provider reports. */
  extractUsage(body: Buffer, contentType: string | undefined): Usage | null;
  /** The provider's stop / finish reason, for the timeline. */
  extractStopReason(body: Buffer, contentType: string | undefined): string | null;
  /** The requested model: in the body for most providers, in the path for Gemini, in a header for Vercel's AI Gateway. */
  extractModel(subpath: string, body: unknown, headers?: Readonly<Record<string, string>>): string | null;
  /**
   * The provider's API hosts. In-process capture sends requests for these hosts to the sidecar with
   * the host they were going to, and the sidecar forwards only to hosts that match, so it is never
   * an open proxy. For Azure, Vertex and Bedrock the host depends on the account and region.
   */
  hosts: RegExp;
  /**
   * The id of the provider whose wire format this one speaks, when it is a host of another's: Claude
   * on Microsoft Foundry speaks Anthropic's, OpenAI's SDK on Bedrock speaks OpenAI's, and a host the
   * config declares speaks the format it names. Its calls are recorded under that id (`meta.provider`),
   * so everything that reads a recording reads them as that provider's (usage, conversations,
   * interventions), and under this one's as `meta.via`, which matching and keys read.
   */
  format?: string;
  /**
   * Whether a captured call may be forwarded to `origin`: by default an https origin whose host
   * `hosts` matches. A host the config declares with a port is taken at that port, over http too.
   */
  accepts?(origin: URL): boolean;
  /**
   * The provider that serves a path of this one's hosts in another wire format: Azure's
   * `services.ai.azure.com` serves Claude under `/anthropic` (Microsoft Foundry).
   */
  forPath?: (path: string) => Provider | undefined;
}

/**
 * Headers without the provider's header parameters (Provider.headerParameters), as a run that holds
 * none is matched: one made before calls kept them, or imported.
 */
export function withoutHeaderParameters(provider: Provider, headers: Readonly<Record<string, string>>): Record<string, string> {
  const left = provider.headerParameters;
  return left?.length ? Object.fromEntries(Object.entries(headers).filter(([h]) => !left.includes(h))) : { ...headers };
}

function modelInBody(body: unknown): string | null {
  const m = isObject(body) ? body.model : undefined;
  return typeof m === 'string' ? m : null;
}

/** `models/gemini-2.5-flash:streamGenerateContent` → `gemini-2.5-flash`. */
export function modelInPath(path: string): string | null {
  const m = /models\/([^:/?]+):/.exec(path);
  return m ? m[1]! : null;
}

const COMMON_CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie'] as const;
const stainlessRetryable = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Yields the parsed `data:` payload of each SSE event. Tolerates partial trailing data and `[DONE]`. */
export function* sseDataObjects(text: string): Generator<Record<string, unknown>> {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const joined = dataLines.join('\n');
    if (joined === '[DONE]') continue;
    try {
      const parsed = JSON.parse(joined) as unknown;
      if (isObject(parsed)) yield parsed;
    } catch {
      // ignore non-JSON data (e.g. a truncated final event)
    }
  }
}

function parseJson(body: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---- Anthropic ----

/** Betas that only say how a call signed in, not what it asks: `oauth-2025-04-20`, which a profile's sign-in sends and an API key doesn't. */
const SIGN_IN_BETA = /^oauth-/i;

/** `anthropic-beta` without the sign-in betas, gone when nothing else is left in it; the other headers as they are. */
function withoutSignInBetas(headers: Readonly<Record<string, string>>): Record<string, string> {
  const beta = headers['anthropic-beta'];
  const betas = beta?.split(',').map((b) => b.trim()) ?? [];
  if (!betas.some((b) => SIGN_IN_BETA.test(b))) return { ...headers };
  const { 'anthropic-beta': _signIn, ...rest } = headers;
  const kept = betas.filter((b) => b && !SIGN_IN_BETA.test(b));
  return kept.length ? { ...rest, 'anthropic-beta': kept.join(',') } : rest;
}

function anthropicUsage(u: unknown): Usage | null {
  if (!isObject(u)) return null;
  const usage: Usage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
  if (u.cache_read_input_tokens !== undefined) usage.cacheReadInputTokens = num(u.cache_read_input_tokens);
  if (u.cache_creation_input_tokens !== undefined) usage.cacheCreationInputTokens = num(u.cache_creation_input_tokens);
  return usage;
}

export const anthropic: Provider = {
  id: 'anthropic',
  upstream: 'https://api.anthropic.com',
  env: (baseUrl) => ({ ANTHROPIC_BASE_URL: baseUrl }),
  // Every path of the API is under /v1: one that isn't comes from a client whose base URL held it.
  apiPath: (path) => (/^\/v1(\/|$)/.test(path) ? path : `/v1${path}`),
  fingerprintHeaders: ['anthropic-version', 'anthropic-beta'],
  apiVersion: { header: 'anthropic-version', default: '2023-06-01' },
  // A golden recorded signed in with a profile replays with a key, in CI, and asks the same.
  matchHeaders: withoutSignInBetas,
  // The key travels as x-api-key, or as a bearer token (anthropic for Python 2.0 and later, a profile's
  // sign-in). A response names the organization the key belongs to, which no recording keeps.
  credentialHeaders: ['x-api-key', ...ACCOUNT_HEADERS, ...COMMON_CREDENTIAL_HEADERS],
  // A profile (ANTHROPIC_PROFILE, or a config file the CLI looks for) and workload identity
  // federation are credentials too: with a key in the environment the SDKs would use the key instead.
  keys: { placeholders: { ANTHROPIC_API_KEY: PLACEHOLDER_KEY }, credentials: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID'], set: 'ANTHROPIC_API_KEY' },
  retryCountHeader: 'x-stainless-retry-count',
  isRetryableStatus: stainlessRetryable,
  extractUsage(body, contentType) {
    if (contentType?.includes('text/event-stream')) {
      let usage: Usage | null = null;
      for (const obj of sseDataObjects(body.toString('utf8'))) {
        if (obj.type === 'message_start') {
          usage = anthropicUsage(isObject(obj.message) ? obj.message.usage : undefined) ?? usage;
        } else if (obj.type === 'message_delta' && isObject(obj.usage)) {
          usage = usage ?? { inputTokens: 0, outputTokens: 0 };
          usage.outputTokens = Math.max(usage.outputTokens, num(obj.usage.output_tokens));
          if (obj.usage.input_tokens !== undefined) usage.inputTokens = Math.max(usage.inputTokens, num(obj.usage.input_tokens));
        }
      }
      return usage;
    }
    return anthropicUsage(parseJson(body)?.usage);
  },
  extractStopReason(body, contentType) {
    if (contentType?.includes('text/event-stream')) {
      let reason: string | null = null;
      for (const obj of sseDataObjects(body.toString('utf8'))) {
        if (obj.type === 'message_delta' && isObject(obj.delta) && typeof obj.delta.stop_reason === 'string') reason = obj.delta.stop_reason;
      }
      return reason;
    }
    const r = parseJson(body)?.stop_reason;
    return typeof r === 'string' ? r : null;
  },
  extractModel: (_subpath, body) => modelInBody(body),
  hosts: /^api\.anthropic\.com$/,
};

// ---- OpenAI and OpenAI-compatible servers (Ollama, vLLM, OpenRouter, Groq, ...) ----

/** Chat Completions (`prompt_tokens`/`completion_tokens`) and the Responses API (`input_tokens`/`output_tokens`). The reported input includes cached tokens; they are split out. */
function openaiUsage(u: unknown): Usage | null {
  if (!isObject(u)) return null;
  const chat = u.prompt_tokens !== undefined || u.completion_tokens !== undefined;
  const usage: Usage = chat
    ? { inputTokens: num(u.prompt_tokens), outputTokens: num(u.completion_tokens) }
    : { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
  const details = isObject(u.prompt_tokens_details) ? u.prompt_tokens_details : isObject(u.input_tokens_details) ? u.input_tokens_details : null;
  if (details && details.cached_tokens !== undefined) {
    usage.cacheReadInputTokens = num(details.cached_tokens);
    usage.inputTokens = Math.max(0, usage.inputTokens - usage.cacheReadInputTokens);
  }
  return usage;
}

function openaiStopReason(obj: Record<string, unknown> | null): string | null {
  if (!obj) return null;
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  for (const ch of choices) if (isObject(ch) && typeof ch.finish_reason === 'string') return ch.finish_reason;
  if (obj.type === 'response.completed' && isObject(obj.response)) {
    const r = obj.response;
    return isObject(r.incomplete_details) && typeof r.incomplete_details.reason === 'string' ? r.incomplete_details.reason : typeof r.status === 'string' ? r.status : null;
  }
  return null;
}

export const openai: Provider = {
  id: 'openai',
  // The official SDK's base URL includes /v1; requests arrive as /openai/v1/... and forward to <upstream>/v1/...
  upstream: 'https://api.openai.com',
  env: (baseUrl) => ({ OPENAI_BASE_URL: `${baseUrl}/v1` }),
  sdkPath: '/v1',
  fingerprintHeaders: ['openai-beta'],
  credentialHeaders: ['openai-organization', 'openai-project', ...COMMON_CREDENTIAL_HEADERS],
  keys: { placeholders: { OPENAI_API_KEY: PLACEHOLDER_KEY }, credentials: ['OPENAI_API_KEY', 'OPENAI_ADMIN_KEY'], set: 'OPENAI_API_KEY' },
  retryCountHeader: 'x-stainless-retry-count',
  isRetryableStatus: stainlessRetryable,
  extractUsage(body, contentType) {
    if (contentType?.includes('text/event-stream')) {
      let usage: Usage | null = null;
      for (const obj of sseDataObjects(body.toString('utf8'))) {
        // Chat Completions: a final chunk carries `usage` when stream_options.include_usage is set.
        if (obj.usage !== undefined && obj.usage !== null) usage = openaiUsage(obj.usage) ?? usage;
        // Responses API: `response.completed` carries the final usage.
        if (obj.type === 'response.completed' && isObject(obj.response)) usage = openaiUsage(obj.response.usage) ?? usage;
      }
      return usage;
    }
    return openaiUsage(parseJson(body)?.usage);
  },
  extractStopReason(body, contentType) {
    if (contentType?.includes('text/event-stream')) {
      let reason: string | null = null;
      for (const obj of sseDataObjects(body.toString('utf8'))) reason = openaiStopReason(obj) ?? reason;
      return reason;
    }
    return openaiStopReason(parseJson(body));
  },
  extractModel: (_subpath, body) => modelInBody(body),
  hosts: /^api\.openai\.com$/,
};

/**
 * Base URLs the agent's SDK was given before Shadowlap that are no root with the provider's SDK path
 * under it: OPENAI_BASE_URL set to a server whose API root doesn't end in `/v1`, such as GitHub
 * Models' `https://models.github.ai/inference` or Gemini's `.../v1beta/openai`, where the SDK sends
 * `/chat/completions` straight under it. `shadowlap run` makes such a URL the upstream as it is, and
 * the agent's base URL is the sidecar's `/openai/v1`, so the sidecar forwards a request's path under
 * it without that `/v1` (`SidecarOptions.sdkBases`). A base that ends in `/v1` is a root plus `/v1`,
 * and a sidecar's own URL (a nested run) is none.
 */
export function sdkBasesFromEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const value = env.OPENAI_BASE_URL?.trim();
  if (!value || /\/t\/[0-9a-f]{32}(\/|$)/.test(value) || /\/v1\/?$/.test(value)) return {};
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return {};
  } catch {
    return {};
  }
  return { openai: value.replace(/\/+$/, '') };
}

// ---- Google Gemini (Generative Language API) ----

/** `promptTokenCount` includes cached content; it is split out. */
function geminiUsage(u: unknown): Usage | null {
  if (!isObject(u)) return null;
  const usage: Usage = { inputTokens: num(u.promptTokenCount), outputTokens: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount) };
  if (u.cachedContentTokenCount !== undefined) {
    usage.cacheReadInputTokens = num(u.cachedContentTokenCount);
    usage.inputTokens = Math.max(0, usage.inputTokens - usage.cacheReadInputTokens);
  }
  return usage;
}

function geminiStopReason(obj: Record<string, unknown> | null): string | null {
  const c = obj && Array.isArray(obj.candidates) ? (obj.candidates as unknown[])[0] : null;
  return isObject(c) && typeof c.finishReason === 'string' ? c.finishReason : null;
}

export const gemini: Provider = {
  id: 'gemini',
  upstream: 'https://generativelanguage.googleapis.com',
  // @google/genai reads GOOGLE_GEMINI_BASE_URL; older clients take httpOptions.baseUrl.
  env: (baseUrl) => ({ GOOGLE_GEMINI_BASE_URL: baseUrl }),
  fingerprintHeaders: [],
  // The API key may also travel in the query string (?key=...); the query is forwarded but never
  // part of the call name, the fingerprint or the stored metadata.
  credentialHeaders: ['x-goog-api-key', ...COMMON_CREDENTIAL_HEADERS],
  // Google's SDKs read either variable (GOOGLE_API_KEY first), and other libraries one or the other.
  // The AI SDK's Google provider (`@ai-sdk/google`, and Mastra's model router, which bundles it)
  // reads GOOGLE_GENERATIVE_AI_API_KEY.
  keys: { placeholders: { GEMINI_API_KEY: PLACEHOLDER_KEY, GOOGLE_API_KEY: PLACEHOLDER_KEY, GOOGLE_GENERATIVE_AI_API_KEY: PLACEHOLDER_KEY }, credentials: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'], set: 'GEMINI_API_KEY' },
  isRetryableStatus: (status) => status === 408 || status === 429 || status >= 500,
  extractUsage(body, contentType) {
    if (contentType?.includes('text/event-stream')) {
      let usage: Usage | null = null;
      for (const obj of sseDataObjects(body.toString('utf8'))) usage = geminiUsage(obj.usageMetadata) ?? usage;
      // Gemini's OpenAI-compatible endpoint (/v1beta/openai/…) answers in OpenAI's format.
      return usage ?? openai.extractUsage(body, contentType);
    }
    return geminiUsage(parseJson(body)?.usageMetadata) ?? openai.extractUsage(body, contentType);
  },
  extractStopReason(body, contentType) {
    if (contentType?.includes('text/event-stream')) {
      let reason: string | null = null;
      for (const obj of sseDataObjects(body.toString('utf8'))) reason = geminiStopReason(obj) ?? reason;
      return reason ?? openai.extractStopReason(body, contentType);
    }
    return geminiStopReason(parseJson(body)) ?? openai.extractStopReason(body, contentType);
  },
  extractModel: (subpath, body) => modelInPath(subpath) ?? modelInBody(body),
  hosts: /^generativelanguage\.googleapis\.com$/,
};

// ---- Azure OpenAI ----

/** `…/openai/deployments/gpt-4o/chat/completions` → `gpt-4o`. Azure names the deployment, not the model. */
function deploymentInPath(path: string): string | null {
  const m = /deployments\/([^/?]+)/.exec(path);
  return m ? decodedSegment(m[1]!) : null;
}

export const azure: Provider = {
  id: 'azure',
  // The endpoint belongs to the customer's resource, and the OpenAI SDK's Azure client prefers
  // OPENAI_BASE_URL over it: calls are captured in the agent's process instead of redirected.
  upstream: '',
  env: () => ({}),
  fingerprintHeaders: ['openai-beta'],
  credentialHeaders: ['api-key', 'openai-organization', 'openai-project', ...COMMON_CREDENTIAL_HEADERS],
  // Microsoft Entra ID is a credential too. The Node client refuses a key beside a token provider,
  // which the environment can't show: only a recording whose environment held the key gets one, in
  // the variable it held it in. The AI SDK's Azure provider (`@ai-sdk/azure`, and Mastra's model
  // router) and LiteLLM read AZURE_API_KEY.
  keys: { placeholders: { AZURE_OPENAI_API_KEY: PLACEHOLDER_KEY, AZURE_API_KEY: PLACEHOLDER_KEY }, credentials: ['AZURE_OPENAI_API_KEY', 'AZURE_API_KEY', 'AZURE_OPENAI_AD_TOKEN', 'AZURE_CLIENT_ID', 'AZURE_FEDERATED_TOKEN_FILE', 'IDENTITY_ENDPOINT', 'MSI_ENDPOINT'], set: 'AZURE_OPENAI_API_KEY', onlyWhereRecorded: true },
  retryCountHeader: 'x-stainless-retry-count',
  isRetryableStatus: stainlessRetryable,
  extractUsage: (body, contentType) => openai.extractUsage(body, contentType),
  extractStopReason: (body, contentType) => openai.extractStopReason(body, contentType),
  extractModel: (subpath, body) => modelInBody(body) ?? deploymentInPath(subpath),
  hosts: /^[a-z0-9-]+\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/,
  // Microsoft Foundry serves Claude in Anthropic's format under /anthropic of the same hosts.
  forPath: (path) => (/^\/anthropic(\/|$)/.test(path) ? foundry : undefined),
};

// ---- Google Vertex AI (Anthropic and Gemini models) ----

export const vertex: Provider = {
  id: 'vertex',
  // https://<region>-aiplatform.googleapis.com, a multi-region or the global endpoint. Clients often
  // take the region in code, so calls are captured in the agent's process instead of redirected.
  upstream: '',
  env: () => ({}),
  fingerprintHeaders: ['anthropic-beta'],
  credentialHeaders: ['x-goog-api-key', 'x-goog-user-project', ...COMMON_CREDENTIAL_HEADERS],
  retryCountHeader: 'x-stainless-retry-count',
  isRetryableStatus: stainlessRetryable,
  // Vertex serves both wire formats: Anthropic messages on :rawPredict, Gemini on :generateContent.
  extractUsage: (body, contentType) => anthropic.extractUsage(body, contentType) ?? gemini.extractUsage(body, contentType),
  extractStopReason: (body, contentType) => anthropic.extractStopReason(body, contentType) ?? gemini.extractStopReason(body, contentType),
  extractModel: (subpath, body) => modelInPath(subpath) ?? modelInBody(body),
  // `/v1/projects/<project>/locations/<region>/publishers/anthropic/models/<model>:rawPredict`: the
  // publisher, model and method say what the call asks; the project and region come from the
  // environment (ANTHROPIC_VERTEX_PROJECT_ID, GOOGLE_CLOUD_PROJECT), which differs per developer and in CI.
  matchPath: (path) => path.replace(/^(\/v1[^/]*)\/projects\/[^/]+\/locations\/[^/]+(?=\/)/, '$1'),
  hosts: /^([a-z0-9-]+-)?aiplatform(\.[a-z]+\.rep)?\.googleapis\.com$/,
};

// ---- Amazon Bedrock ----

const isEventStream = (contentType: string | undefined) => !!contentType?.includes('vnd.amazon.eventstream');

/** Converse reports `usage: { inputTokens, outputTokens, cacheReadInputTokens }`. */
function converseUsage(u: unknown): Usage | null {
  if (!isObject(u) || u.inputTokens === undefined) return null;
  const usage: Usage = { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens) };
  if (u.cacheReadInputTokens !== undefined) usage.cacheReadInputTokens = num(u.cacheReadInputTokens);
  if (u.cacheWriteInputTokens !== undefined) usage.cacheCreationInputTokens = num(u.cacheWriteInputTokens);
  return usage;
}

/**
 * What InvokeModel, streamed or not, takes as headers beside its body, each of which changes the
 * answer: the guardrail and its version, the trace that shows what the guardrail did, the latency
 * profile and the service tier. Bedrock's Chat Completions takes its guardrail the same way.
 */
const BEDROCK_PARAMETERS = ['x-amzn-bedrock-guardrailidentifier', 'x-amzn-bedrock-guardrailversion', 'x-amzn-bedrock-trace', 'x-amzn-bedrock-performanceconfig-latency', 'x-amzn-bedrock-service-tier'];

export const bedrock: Provider = {
  id: 'bedrock',
  // bedrock-runtime.<region>.amazonaws.com: every request is signed for that host, so it is captured
  // in the agent's process and forwarded to the host it was signed for.
  upstream: '',
  // No environment: a base URL would break the request's signature.
  env: () => ({}),
  fingerprintHeaders: BEDROCK_PARAMETERS,
  headerParameters: BEDROCK_PARAMETERS,
  credentialHeaders: ['x-amz-security-token', 'x-amz-content-sha256', 'x-amz-date', 'x-amzn-trace-id', ...COMMON_CREDENTIAL_HEADERS],
  // Every source of the AWS SDKs' default credential chain the environment can name (the CLI checks
  // the shared files too), and a Bedrock API key. An instance role the metadata service hands out
  // is named by none: a recording made with one keeps no AWS key in its note (keyEnv), so
  // `shadowlap replay` gives none and leaves the role to the agent.
  keys: {
    placeholders: { AWS_ACCESS_KEY_ID: PLACEHOLDER_AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: PLACEHOLDER_KEY },
    credentials: ['AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_BEARER_TOKEN_BEDROCK'],
    set: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
  },
  isRetryableStatus: (status) => status === 408 || status === 429 || status >= 500,
  extractUsage(body, contentType) {
    if (isEventStream(contentType)) {
      let usage: Usage | null = null;
      for (const { payload } of eventStreamMessages(body)) {
        if (!payload) continue;
        usage = converseUsage(payload.usage) ?? anthropicStreamUsage(payload, usage) ?? usage;
      }
      return usage;
    }
    const json = parseJson(body);
    return converseUsage(json?.usage) ?? anthropicUsage(json?.usage);
  },
  extractStopReason(body, contentType) {
    if (isEventStream(contentType)) {
      let reason: string | null = null;
      for (const { payload } of eventStreamMessages(body)) {
        if (!payload) continue;
        if (typeof payload.stopReason === 'string') reason = payload.stopReason;
        else if (isObject(payload.delta) && typeof payload.delta.stop_reason === 'string') reason = payload.delta.stop_reason;
      }
      return reason;
    }
    const json = parseJson(body);
    const r = json?.stopReason ?? json?.stop_reason;
    return typeof r === 'string' ? r : null;
  },
  extractModel: (subpath) => {
    const m = /\/model\/([^/]+)\//.exec(subpath);
    return m ? decodedSegment(m[1]!) : null;
  },
  // bedrock-runtime.<region>.amazonaws.com, and bedrock-mantle.<region>.api.aws, where OpenAI's SDK
  // reaches Bedrock in OpenAI's format (bedrockMantle, by its /openai paths).
  hosts: /^(bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?|bedrock-mantle\.[a-z0-9-]+\.api\.aws)$/,
  forPath: (path) => (/^\/openai(\/|$)/.test(path) ? bedrockMantle : undefined),
};

/** A message_start / message_delta event of an Anthropic model served through Bedrock. */
function anthropicStreamUsage(payload: Record<string, unknown>, current: Usage | null): Usage | null {
  if (payload.type === 'message_start' && isObject(payload.message)) return anthropicUsage(payload.message.usage);
  if (payload.type === 'message_delta' && isObject(payload.usage)) {
    const usage: Usage = current ?? { inputTokens: 0, outputTokens: 0 };
    usage.outputTokens = Math.max(usage.outputTokens, num(payload.usage.output_tokens));
    if (payload.usage.input_tokens !== undefined) usage.inputTokens = Math.max(usage.inputTokens, num(payload.usage.input_tokens));
    return usage;
  }
  return null;
}

// ---- Hosts of another provider's wire format ----

/**
 * Where a host serves a format's API (`root`, the path of the base URL its SDK is given there), as
 * the format's own API names its calls: `/api/v1/chat/completions` at a root of `/api/v1` matches as
 * OpenAI's `/v1/chat/completions`. The call keeps its full path as its name and is forwarded so.
 */
function underRoot(root: string, format: Provider): (path: string) => string {
  return (path) => (path === root || path.startsWith(`${root}/`) ? `${format.sdkPath ?? ''}${path.slice(root.length)}` || '/' : path);
}

/** A provider for a host of `format`'s wire format: its reading of requests and answers, with the host's own id, hosts, keys and root. */
function hostOf(format: Provider, own: Pick<Provider, 'id' | 'hosts' | 'credentialHeaders'> & Partial<Provider> & { root?: string }): Provider {
  const { root, ...rest } = own;
  // The format's reading of requests and answers, and nothing a client of its own API needs: no base
  // URL, no sign-in betas, no keys, nothing read from the path. The host's own say comes after.
  const { upstream: _upstream, env: _env, sdkPath: _sdkPath, apiPath: _apiPath, matchHeaders: _matchHeaders, keys: _keys, matchPath: _matchPath, forPath: _forPath, ...reading } = format;
  return { ...reading, upstream: '', env: () => ({}), ...(root ? { matchPath: underRoot(root, format) } : {}), ...rest, format: format.id };
}

/**
 * Claude on Microsoft Foundry (`AnthropicFoundry`): Anthropic's Messages API at
 * `https://<resource>.services.ai.azure.com/anthropic/`, its key in ANTHROPIC_FOUNDRY_API_KEY sent as
 * x-api-key, or a Microsoft Entra token. Reached through Azure's hosts (`azure.forPath`).
 */
export const foundry: Provider = hostOf(anthropic, {
  id: 'foundry',
  root: '/anthropic',
  hosts: /^[a-z0-9-]+\.services\.ai\.azure\.com$/,
  credentialHeaders: ['x-api-key', 'api-key', ...ACCOUNT_HEADERS, ...COMMON_CREDENTIAL_HEADERS],
  // The client refuses a key beside a token provider, which no variable shows: as for Azure OpenAI,
  // only a recording whose environment held the key gets one.
  keys: { placeholders: { ANTHROPIC_FOUNDRY_API_KEY: PLACEHOLDER_KEY }, credentials: ['ANTHROPIC_FOUNDRY_API_KEY', 'AZURE_CLIENT_ID', 'AZURE_FEDERATED_TOKEN_FILE', 'IDENTITY_ENDPOINT', 'MSI_ENDPOINT'], set: 'ANTHROPIC_FOUNDRY_API_KEY', onlyWhereRecorded: true },
});

/**
 * OpenAI's SDK on Amazon Bedrock (`bedrock()` from openai/providers/bedrock, `BedrockOpenAI`):
 * OpenAI's API at `https://bedrock-mantle.<region>.api.aws/openai/v1`, signed with SigV4 or sent
 * with a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK). Reached through Bedrock's hosts (`bedrock.forPath`).
 */
export const bedrockMantle: Provider = hostOf(openai, {
  id: 'bedrock-mantle',
  root: '/openai/v1',
  hosts: /^bedrock-mantle\.[a-z0-9-]+\.api\.aws$/,
  // OpenAI's, and what Bedrock takes as headers: its Chat Completions' guardrail.
  fingerprintHeaders: [...openai.fingerprintHeaders, ...BEDROCK_PARAMETERS],
  headerParameters: BEDROCK_PARAMETERS,
  credentialHeaders: ['x-amz-security-token', 'x-amz-content-sha256', 'x-amz-date', 'x-amzn-trace-id', ...COMMON_CREDENTIAL_HEADERS],
  // The Bedrock API key the bearer clients read; one signing with SigV4 reads the AWS credentials.
  keys: { placeholders: { AWS_BEARER_TOKEN_BEDROCK: PLACEHOLDER_KEY }, credentials: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'], set: 'AWS_BEARER_TOKEN_BEDROCK', onlyWhereRecorded: true },
});

// ---- Vercel's AI Gateway ----

/**
 * The AI SDK's usage, as the gateway returns it: from version 3 of its spec, `inputTokens` and
 * `outputTokens` are objects (`{ total, noCache, cacheRead, cacheWrite }`); before, numbers, with
 * `cachedInputTokens` beside them.
 */
function gatewayUsage(u: unknown): Usage | null {
  if (!isObject(u)) return null;
  const input = u.inputTokens;
  const output = u.outputTokens;
  const total = (v: unknown) => num(isObject(v) ? v.total : v);
  const usage: Usage = { inputTokens: 0, outputTokens: total(output) };
  if (isObject(input)) {
    const cacheRead = num(input.cacheRead);
    const cacheWrite = num(input.cacheWrite);
    usage.inputTokens = input.noCache !== undefined ? num(input.noCache) : Math.max(0, num(input.total) - cacheRead - cacheWrite);
    if (input.cacheRead !== undefined) usage.cacheReadInputTokens = cacheRead;
    if (input.cacheWrite !== undefined) usage.cacheCreationInputTokens = cacheWrite;
  } else {
    const cached = num(u.cachedInputTokens);
    usage.inputTokens = Math.max(0, num(input) - cached);
    if (u.cachedInputTokens !== undefined) usage.cacheReadInputTokens = cached;
  }
  return usage;
}

/** `{ unified, raw }` from version 3 of the spec on, a string before. */
const gatewayFinish = (v: unknown): string | null => (typeof v === 'string' ? v : isObject(v) && typeof v.unified === 'string' ? v.unified : null);

/**
 * Vercel's AI Gateway, where the AI SDK sends a model named by a string (`model: 'openai/gpt-5'`):
 * `POST <base>/language-model` (and `/embedding-model`) with the SDK's own call options as the body,
 * the model and the spec's version in headers, and the SDK's own results back, as JSON or a stream of
 * its parts. Its client takes no base URL from the environment, so its calls are captured in the
 * process. The model, the spec version and whether the call streams are headers, so they match.
 */
export const aiGateway: Provider = {
  id: 'ai-gateway',
  upstream: '',
  env: () => ({}),
  fingerprintHeaders: ['ai-language-model-id', 'ai-language-model-specification-version', 'ai-language-model-streaming', 'ai-embedding-model-id', 'ai-embedding-model-specification-version'],
  credentialHeaders: ['ai-gateway-auth-method', ...COMMON_CREDENTIAL_HEADERS],
  // An API key, or the OIDC token a Vercel deployment and `vercel env pull` give.
  keys: { placeholders: { AI_GATEWAY_API_KEY: PLACEHOLDER_KEY }, credentials: ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'], set: 'AI_GATEWAY_API_KEY' },
  isRetryableStatus: (status) => status === 408 || status === 429 || status >= 500,
  extractUsage(body, contentType) {
    if (contentType?.includes('text/event-stream')) {
      let usage: Usage | null = null;
      for (const obj of sseDataObjects(body.toString('utf8'))) if (obj.type === 'finish') usage = gatewayUsage(obj.usage) ?? usage;
      return usage;
    }
    return gatewayUsage(parseJson(body)?.usage);
  },
  extractStopReason(body, contentType) {
    if (contentType?.includes('text/event-stream')) {
      let reason: string | null = null;
      for (const obj of sseDataObjects(body.toString('utf8'))) if (obj.type === 'finish') reason = gatewayFinish(obj.finishReason) ?? reason;
      return reason;
    }
    return gatewayFinish(parseJson(body)?.finishReason);
  },
  extractModel: (_subpath, body, headers) => headers?.['ai-language-model-id'] ?? headers?.['ai-embedding-model-id'] ?? modelInBody(body),
  hosts: /^ai-gateway\.vercel\.sh$/,
};

/** The providers the sidecar routes to, `/<id>/…`: each provider's own hosts. */
export const providers: Provider[] = [anthropic, openai, gemini, azure, vertex, bedrock, aiGateway];

/**
 * Hosts of another provider's format that are built in, each reached through the route of the
 * provider whose hosts serve it (`forPath`): matching reads a call through one by its `meta.via`,
 * and a replay gives its key a placeholder.
 */
export const hostedProviders: Provider[] = [foundry, bedrockMantle];

// ---- Hosts the config declares (`providers` in shadowlap.config.json) ----

/** A host the config declares, and the wire format it speaks: `{ "host": "openrouter.ai", "format": "openai", "root": "/api/v1" }`. */
export interface FormatHost {
  /** `api.example.com` or `*.example.com` (any subdomain), either with an optional `:port`. */
  host: string;
  format: 'openai' | 'anthropic' | 'gemini';
  /** The path of the base URL the format's SDK is given at that host: `/api/v1` for OpenRouter. Calls under it match as the format's own API names them. */
  root?: string;
}

const FORMATS: Readonly<Record<FormatHost['format'], Provider>> = { openai, anthropic, gemini };
const FORMAT_HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
/** Route names the sidecar keeps for itself (its API, captured HTTP, a run's and a slot's prefixes) or a provider: no declared host may take one. */
const RESERVED = new Set(['v1', 'http', 'r', 's', 't', ...providers.map((p) => p.id), ...hostedProviders.map((p) => p.id)]);

/** Why `raw` is no host to declare, or null when it is one. `where` names it in the message. */
export function formatHostProblem(raw: unknown, where: string): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `${where} must be an object, such as { "host": "openrouter.ai", "format": "openai", "root": "/api/v1" }`;
  const { host, format, root, ...rest } = raw as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) return `${where} has ${extra.map((k) => `"${k}"`).join(', ')}, which a provider doesn't take: host, format and root`;
  if (typeof host !== 'string' || !FORMAT_HOST.test(host)) return `${where}.host must be a host like api.example.com or *.example.com, with an optional :port, in lower case`;
  if (host.startsWith('*.') && host.includes(':')) return `${where}.host: a host with a port is one host, so it takes no *.`;
  if (RESERVED.has(host)) return `${where}.host "${host}" is a name Shadowlap uses itself`;
  if (format !== 'openai' && format !== 'anthropic' && format !== 'gemini') return `${where}.format must be openai, anthropic or gemini`;
  if (root !== undefined && (typeof root !== 'string' || !/^(\/[A-Za-z0-9._~-]+)+$/.test(root))) return `${where}.root must be a path such as /api/v1`;
  return null;
}

/** A provider for a host the config declares: the format's reading of requests and answers, at that host. */
export function formatHostProvider(h: FormatHost): Provider {
  const [hostname, port] = h.host.split(':') as [string, string | undefined];
  const escaped = hostname.replace(/^\*\./, '').replace(/[.]/g, '\\.');
  const hosts = new RegExp(hostname.startsWith('*.') ? `^([a-z0-9-]+\\.)+${escaped}$` : `^${escaped}$`);
  const format = FORMATS[h.format];
  return hostOf(format, {
    id: h.host,
    ...(h.root ? { root: h.root } : {}),
    hosts,
    // Its key, whatever it is called, is the format's: a header the format's SDK sends it in.
    credentialHeaders: [...new Set([...format.credentialHeaders, 'x-api-key', 'api-key'])],
    // With a port, the host's own server, as the agent named it: over http too. Without, https only.
    accepts: (origin) => hosts.test(origin.hostname) && (port !== undefined ? origin.port === port && (origin.protocol === 'http:' || origin.protocol === 'https:') : origin.protocol === 'https:'),
  });
}

/** The hosts the project's config declares, which every sidecar this process starts serves, and which capture sends there. */
let declared: Provider[] = [];

/**
 * Takes the hosts the project's config declares (`providers` in shadowlap.config.json, read when a
 * command loads it): every sidecar this process starts serves them besides the built-in providers,
 * unless it is given its own list, and in-process capture sends their calls to it.
 */
export function declareFormatHosts(hosts: readonly FormatHost[]): void {
  declared = hosts.map(formatHostProvider);
}

/** The built-in providers, then the hosts the config declares (declareFormatHosts). */
export function activeProviders(): Provider[] {
  return [...providers, ...declared];
}
