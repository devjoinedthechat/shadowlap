import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { PassThrough, type Readable } from 'node:stream';
import type { Usage } from '@shadowlap/engine';
import { configuredRegion, resolveAwsCredentials, resolveGoogleToken, signRequest } from '@shadowlap/remote';
import { providers, sdkBasesFromEnvironment, type Provider } from '@shadowlap/sidecar';

/**
 * How `shadowlap decisions` sends a recorded request again: through the upstreams the sidecar uses
 * for any live call (SHADOWLAP_UPSTREAM_<PROVIDER>, an SDK base URL from before Shadowlap, else the
 * provider's own host; a Bedrock or Vertex AI host from the Region the call names), with the
 * credentials this machine has, and read the way the sidecar reads a live answer: usage, stop reason
 * and model through the provider's module. Nothing is stored here and no key is ever kept: a key
 * goes into the request's headers, and only there.
 */

export interface ModelRequest {
  /** The provider the call was recorded through (`meta.provider`). */
  provider: string;
  method: string;
  /** The path under the provider root, as the call is named (`/v1/messages`). */
  path: string;
  /** The query to send, without `?`: the recorded call's (Azure's `api-version=…`, Gemini's `alt=sse`). */
  query?: string;
  /** Headers the call's fingerprint carries (`anthropic-version`, `anthropic-beta`, `openai-beta`). */
  headers: Record<string, string>;
  body: unknown;
}

export interface ModelAnswer {
  status: number;
  contentType: string | undefined;
  bytes: Buffer;
  usage: Usage | null;
  stopReason: string | null;
  /** The model asked: the request's, as the sidecar records it. */
  model: string | null;
  latencyMs: number;
  /** Why there is no answer to read (a refusal, an error, no credentials), or null for a 2xx. */
  error: string | null;
  /** Requests that reached the upstream: retries included. */
  attempts: number;
}

export interface SenderOptions {
  /** Per-provider upstream overrides, as the sidecar takes them (`upstreamOverrides`). */
  upstreams: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  /** Stop a request after this long; null waits as long as the provider takes. */
  timeoutMs?: number | null;
  /** Retries of a 408, 409, 429 or 5xx, or a broken connection, as the official SDKs make them. */
  retries?: number;
  /** For tests: what a retry waits, in ms, given the attempt and what the provider asked for. */
  wait?: (attempt: number, retryAfterMs: number | null) => number;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function providerById(id: string | null | undefined): Provider | null {
  return providers.find((p) => p.id === id) ?? null;
}

/** An Azure OpenAI call to a deployment (`/openai/deployments/<name>/…`), which needs its `api-version`. */
export const azureDeploymentCall = (provider: string, path: string): boolean => provider === 'azure' && /^\/openai\/deployments\//.test(path);

/**
 * The `api-version` to send an Azure OpenAI deployment call with when its recording kept no query
 * (one made before recordings kept it): as the AzureOpenAI SDKs read it, `OPENAI_API_VERSION`, or
 * `AZURE_OPENAI_API_VERSION`. Null when neither is set.
 */
export function azureApiVersion(env: NodeJS.ProcessEnv): string | null {
  return env.AZURE_OPENAI_API_VERSION?.trim() || env.OPENAI_API_VERSION?.trim() || null;
}

/** The Region a Bedrock call names in its model ARN, if it names one. */
function arnRegion(path: string): string | null {
  const m = /\/model\/([^/]+)\//.exec(path);
  if (!m) return null;
  let id = m[1]!;
  try {
    id = decodeURIComponent(id);
  } catch {
    // as it is
  }
  return /^arn:aws[\w-]*:bedrock:([a-z0-9-]+):/.exec(id)?.[1] ?? null;
}

/** Where a request goes: the configured upstream, else the provider's host for this call; or why there is none. */
export function upstreamOf(provider: Provider, path: string, o: Pick<SenderOptions, 'upstreams' | 'env'>): { base: string; official: boolean } | { error: string } {
  const env = o.env ?? process.env;
  const configured = o.upstreams[provider.id];
  const official = (base: string) => {
    try {
      return provider.hosts.test(new URL(base).hostname);
    } catch {
      return false;
    }
  };
  if (configured) return { base: configured.replace(/\/+$/, ''), official: official(configured) };
  if (provider.id === 'bedrock') {
    const region = arnRegion(path) ?? (configuredRegion({ env }) || null);
    if (!region) return { error: 'no AWS Region to send the Bedrock call to: set AWS_REGION' };
    return { base: `https://bedrock-runtime.${region}.amazonaws.com`, official: true };
  }
  if (provider.id === 'vertex') {
    const location = /\/locations\/([^/]+)\//.exec(path)?.[1];
    if (!location) return { error: 'the Vertex AI call names no location to send it to' };
    return { base: location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`, official: true };
  }
  if (provider.id === 'azure') {
    const endpoint = env.AZURE_OPENAI_ENDPOINT?.trim();
    if (!endpoint) return { error: 'no Azure OpenAI endpoint to send the call to: set AZURE_OPENAI_ENDPOINT, or SHADOWLAP_UPSTREAM_AZURE' };
    try {
      return { base: new URL(endpoint).origin, official: official(endpoint) };
    } catch {
      return { error: `AZURE_OPENAI_ENDPOINT is not a URL: ${endpoint}` };
    }
  }
  if (!provider.upstream) return { error: `no upstream for ${provider.id}: set SHADOWLAP_UPSTREAM_${provider.id.toUpperCase()}` };
  return { base: provider.upstream, official: true };
}

/** What credentials a provider's requests need here, and whether this machine has them; null when it does. */
export function missingCredentials(provider: Provider, official: boolean, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!official) return null;
  switch (provider.id) {
    case 'anthropic':
      return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? null : 'no Anthropic key: set ANTHROPIC_API_KEY';
    case 'openai':
      return env.OPENAI_API_KEY ? null : 'no OpenAI key: set OPENAI_API_KEY';
    case 'gemini':
      return env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? null : 'no Gemini key: set GEMINI_API_KEY';
    case 'azure':
      return env.AZURE_OPENAI_API_KEY ? null : 'no Azure OpenAI key: set AZURE_OPENAI_API_KEY';
    default:
      // Bedrock and Vertex AI find their credentials as their SDKs do, when the request is signed.
      return null;
  }
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The headers that carry this machine's credentials for one request, signed where the provider signs. */
async function credentialHeaders(provider: Provider, url: URL, method: string, body: Buffer, env: NodeJS.ProcessEnv, official: boolean): Promise<Record<string, string>> {
  switch (provider.id) {
    case 'anthropic':
      if (env.ANTHROPIC_API_KEY) return { 'x-api-key': env.ANTHROPIC_API_KEY };
      return env.ANTHROPIC_AUTH_TOKEN ? { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` } : {};
    case 'openai':
      return {
        ...(env.OPENAI_API_KEY ? { authorization: `Bearer ${env.OPENAI_API_KEY}` } : {}),
        ...(env.OPENAI_ORG_ID ? { 'openai-organization': env.OPENAI_ORG_ID } : {}),
        ...(env.OPENAI_PROJECT_ID ? { 'openai-project': env.OPENAI_PROJECT_ID } : {}),
      };
    case 'gemini': {
      const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
      return key ? { 'x-goog-api-key': key } : {};
    }
    case 'azure':
      return env.AZURE_OPENAI_API_KEY ? { 'api-key': env.AZURE_OPENAI_API_KEY } : {};
    case 'vertex': {
      if (!official && !env.GOOGLE_OAUTH_ACCESS_TOKEN) return {};
      const token = await resolveGoogleToken({ env });
      return { authorization: `Bearer ${token.accessToken}` };
    }
    case 'bedrock': {
      if (!official && !env.AWS_ACCESS_KEY_ID) return {};
      const credentials = await resolveAwsCredentials({ env });
      const region = /bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com/.exec(url.hostname)?.[1] ?? arnRegion(url.pathname) ?? (configuredRegion({ env }) || 'us-east-1');
      // Signed for the AWS host it is meant for: a gateway or a mock in front of Bedrock gets it signed as
      // the agent's SDK signs it, which is how the sidecar forwards a captured call there too.
      const host = /\.amazonaws\.com(\.cn)?$/.test(url.hostname) ? url.host : `bedrock-runtime.${region}.amazonaws.com`;
      const headers = { host, 'content-type': 'application/json', 'x-amz-content-sha256': sha256(body) };
      // Bedrock, like every AWS service but S3, signs each path segment encoded once more than it is sent.
      const signed = signRequest({ method, path: url.pathname.split('/').map(rfc3986).join('/'), query: url.search.replace(/^\?/, ''), headers, payloadHash: sha256(body) }, { region, service: 'bedrock', date: new Date(), credentials });
      return { 'x-amz-content-sha256': sha256(body), ...signed.add };
    }
    default:
      return {};
  }
}

function decoded(res: Readable, encoding: string): Readable {
  const e = encoding.trim().toLowerCase();
  const d = e === 'gzip' || e === 'x-gzip' ? createGunzip() : e === 'deflate' ? createInflate() : e === 'br' ? createBrotliDecompress() : new PassThrough();
  res.pipe(d);
  return d;
}

/** One HTTP exchange, with no time limit but the one given. */
function exchange(url: URL, method: string, headers: Record<string, string>, body: Buffer, timeoutMs: number | null): Promise<{ status: number; headers: Record<string, string>; bytes: Buffer }> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method, headers: { ...headers, 'content-length': String(body.length) } }, (res) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      const chunks: Buffer[] = [];
      const stream = decoded(res, out['content-encoding'] ?? '');
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve({ status: res.statusCode ?? 502, headers: out, bytes: Buffer.concat(chunks) }));
      stream.on('error', reject);
      res.on('error', reject);
    });
    const timer = timeoutMs ? setTimeout(() => req.destroy(new Error(`no answer after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs) : null;
    req.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    req.on('close', () => timer && clearTimeout(timer));
    req.end(body);
  });
}

/** What an error answer says, in its provider's shape: `error.message`, a top-level `message`, or its first line. */
export function errorText(status: number, bytes: Buffer): string {
  const text = bytes.toString('utf8');
  let message: string;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown } | Array<{ error?: { message?: unknown } }>;
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    const err = one?.error;
    message = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : typeof (one as { message?: unknown })?.message === 'string' ? String((one as { message: string }).message) : '';
  } catch {
    message = text.split('\n')[0] ?? '';
  }
  message = message.replace(/\s+/g, ' ').trim().slice(0, 300);
  return `HTTP ${status}${message ? `: ${message}` : ''}`;
}

/**
 * Sends model requests as the sidecar forwards a live call: to the same upstream, with the
 * provider's own retry rule, read with the provider's own module.
 */
export class ModelSender {
  private readonly env: NodeJS.ProcessEnv;
  private readonly sdkBases: Record<string, string>;

  constructor(private readonly o: SenderOptions) {
    this.env = o.env ?? process.env;
    this.sdkBases = sdkBasesFromEnvironment(this.env);
  }

  /** Why requests to this provider can't be sent from here, or null: for refusing before anything is spent. */
  problem(providerId: string, path: string): string | null {
    const provider = providerById(providerId);
    if (!provider) return `${providerId} is not a provider Shadowlap sends to`;
    const up = upstreamOf(provider, path, this.o);
    if ('error' in up) return up.error;
    return missingCredentials(provider, up.official, this.env);
  }

  async send(req: ModelRequest): Promise<ModelAnswer> {
    const provider = providerById(req.provider);
    const started = Date.now();
    const none = (error: string): ModelAnswer => ({ status: 0, contentType: undefined, bytes: Buffer.alloc(0), usage: null, stopReason: null, model: null, latencyMs: 0, error, attempts: 0 });
    if (!provider) return none(`${req.provider} is not a provider Shadowlap sends to`);
    const up = upstreamOf(provider, req.path, this.o);
    if ('error' in up) return none(up.error);
    const missing = missingCredentials(provider, up.official, this.env);
    if (missing) return none(missing);
    // An upstream that is the SDK's own base URL, with no `/v1` under it: the SDK's path goes straight under it, as in the sidecar.
    const sdkBase = this.sdkBases[provider.id];
    const sdkRelative = sdkBase !== undefined && provider.sdkPath !== undefined && up.base === sdkBase.replace(/\/+$/, '') && (req.path === provider.sdkPath || req.path.startsWith(`${provider.sdkPath}/`));
    const path = sdkRelative ? req.path.slice(provider.sdkPath!.length) : req.path;
    const url = new URL(`${up.base}${path}${req.query ? `?${req.query}` : ''}`);
    const body = Buffer.from(JSON.stringify(req.body), 'utf8');
    const stream = typeof req.body === 'object' && req.body !== null && (req.body as { stream?: unknown }).stream === true;
    const model = provider.extractModel(req.path, req.body);
    // A call imported from a trace names no API version, which the API asks every request for.
    const version = provider.apiVersion && req.headers[provider.apiVersion.header] === undefined ? { [provider.apiVersion.header]: provider.apiVersion.default } : {};
    const retries = this.o.retries ?? 2;
    let attempts = 0;
    for (let attempt = 0; ; attempt++) {
      let headers: Record<string, string>;
      try {
        // Bedrock's streaming operations answer in AWS event stream frames, Gemini's alt=sse and the rest with `stream` in server-sent events.
        const accept = /\/(invoke-with-response-stream|converse-stream)$/.test(req.path) ? 'application/vnd.amazon.eventstream' : stream || req.query?.includes('alt=sse') ? 'text/event-stream' : 'application/json';
        headers = { 'content-type': 'application/json', accept, 'accept-encoding': 'gzip, br, deflate', ...version, ...req.headers, ...(await credentialHeaders(provider, url, req.method, body, this.env, up.official)) };
      } catch (err) {
        return { ...none(`${provider.id} credentials: ${(err as Error).message}`), latencyMs: Date.now() - started };
      }
      attempts++;
      try {
        const res = await exchange(url, req.method, headers, body, this.o.timeoutMs ?? null);
        if (RETRYABLE.has(res.status) && attempt < retries) {
          const after = Number(res.headers['retry-after']);
          await new Promise((r) => setTimeout(r, this.wait(attempt, Number.isFinite(after) ? after * 1000 : null)));
          continue;
        }
        const contentType = res.headers['content-type'];
        const ok = res.status >= 200 && res.status < 300;
        return {
          status: res.status,
          contentType,
          bytes: res.bytes,
          usage: provider.extractUsage(res.bytes, contentType),
          stopReason: ok ? provider.extractStopReason(res.bytes, contentType) : null,
          model: res.headers['x-shadowlap-model'] || model,
          latencyMs: Date.now() - started,
          error: ok ? null : errorText(res.status, res.bytes),
          attempts,
        };
      } catch (err) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, this.wait(attempt, null)));
          continue;
        }
        return { ...none(`${url.origin} could not be reached: ${(err as Error).message}`), latencyMs: Date.now() - started, attempts };
      }
    }
  }

  private wait(attempt: number, retryAfterMs: number | null): number {
    if (this.o.wait) return this.o.wait(attempt, retryAfterMs);
    if (retryAfterMs !== null) return Math.min(30_000, Math.max(0, retryAfterMs));
    return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
  }
}
