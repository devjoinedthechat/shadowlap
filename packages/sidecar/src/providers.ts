import { eventStreamMessages, type Usage } from '@shadowlap/engine';

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
  env(baseUrl: string): Record<string, string>;
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
  apiPath?(path: string): string;
  /**
   * A request's path as it identifies the call, when part of it names where the call was made rather
   * than what it asks: Vertex AI's `/projects/<project>/locations/<region>`, so a recording replays
   * in a teammate's project or in CI's. The call keeps its full path as its name.
   */
  matchPath?(path: string): string;
  /** Lower-cased request headers that change model behavior and therefore fingerprint. */
  fingerprintHeaders: readonly string[];
  /** Lower-cased headers that are forwarded upstream but never stored. */
  credentialHeaders: readonly string[];
  /** Header the official SDKs set to the retry attempt number (0 on the first attempt). */
  retryCountHeader?: string;
  isRetryableStatus(status: number): boolean;
  /** Usage with `inputTokens` as *uncached* input, whatever the provider reports. */
  extractUsage(body: Buffer, contentType: string | undefined): Usage | null;
  /** The provider's stop / finish reason, for the timeline. */
  extractStopReason(body: Buffer, contentType: string | undefined): string | null;
  /** The requested model: in the body for most providers, in the path for Gemini. */
  extractModel(subpath: string, body: unknown): string | null;
  /**
   * The provider's API hosts. In-process capture sends requests for these hosts to the sidecar with
   * the host they were going to, and the sidecar forwards only to hosts that match, so it is never
   * an open proxy. For Azure, Vertex and Bedrock the host depends on the account and region.
   */
  hosts: RegExp;
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
  credentialHeaders: ['x-api-key', ...COMMON_CREDENTIAL_HEADERS],
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
  const c = obj && Array.isArray(obj.candidates) ? obj.candidates[0] : null;
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
  return m ? decodeURIComponent(m[1]!) : null;
}

export const azure: Provider = {
  id: 'azure',
  // The endpoint belongs to the customer's resource, and the OpenAI SDK's Azure client prefers
  // OPENAI_BASE_URL over it: calls are captured in the agent's process instead of redirected.
  upstream: '',
  env: () => ({}),
  fingerprintHeaders: ['openai-beta'],
  credentialHeaders: ['api-key', 'openai-organization', 'openai-project', ...COMMON_CREDENTIAL_HEADERS],
  retryCountHeader: 'x-stainless-retry-count',
  isRetryableStatus: stainlessRetryable,
  extractUsage: (body, contentType) => openai.extractUsage(body, contentType),
  extractStopReason: (body, contentType) => openai.extractStopReason(body, contentType),
  extractModel: (subpath, body) => modelInBody(body) ?? deploymentInPath(subpath),
  hosts: /^[a-z0-9-]+\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/,
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

export const bedrock: Provider = {
  id: 'bedrock',
  // bedrock-runtime.<region>.amazonaws.com: every request is signed for that host, so it is captured
  // in the agent's process and forwarded to the host it was signed for.
  upstream: '',
  // No environment: a base URL would break the request's signature.
  env: () => ({}),
  fingerprintHeaders: [],
  credentialHeaders: ['x-amz-security-token', 'x-amz-content-sha256', 'x-amz-date', 'x-amzn-trace-id', ...COMMON_CREDENTIAL_HEADERS],
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
    return m ? decodeURIComponent(m[1]!) : null;
  },
  hosts: /^bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/,
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

export const providers: Provider[] = [anthropic, openai, gemini, azure, vertex, bedrock];
