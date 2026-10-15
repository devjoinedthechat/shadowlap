import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  anthropicBase,
  anthropicMessageEvents,
  anthropicMessageToOpenAIChat,
  anthropicToOpenAIChat,
  chatCompletionChunks,
  endpointVia,
  errorBody,
  errorMessage,
  isLoopback,
  OFFICIAL,
  openAIBase,
  openAIChatToAnthropic,
  openAIChatToAnthropicMessage,
  type ChatShape,
} from '@shadowlap/engine';

/**
 * The model under test, and how a recorded conversation reaches it. `--model <name>` asks the
 * recording's own provider for another model. `--model anthropic:<name>` and `--model openai:<name>`
 * ask that provider's API, and `--base-url` an OpenAI-compatible server (Ollama, vLLM, the server of
 * a model being trained).
 *
 * Whichever it is, a takeover upstream on 127.0.0.1 sits where the recording's provider would be.
 * The sidecar replays every call before the takeover from the recording, so the first request that
 * reaches the upstream is the takeover call itself, and every model call from there goes to the model
 * under test: no call has to be counted to know where the takeover is. For the recording's own API it
 * changes the model the request names (its `model` field, or the model in a Gemini URL) and sends it
 * on with the agent's own headers; for another API it translates the conversation for the model and
 * the answer back for the agent. Anything else the agent sends that provider (an embeddings call, a
 * token count, a model list) goes to the provider unchanged, as the sidecar would have sent it. Each
 * answer to a model call says which model gave it (`x-shadowlap-model`): the sidecar records that as
 * the call's model, and a score checks it.
 */

/** The response header a takeover upstream answers each model call with: the model that answered. */
export const ANSWERED_BY = 'x-shadowlap-model';

/**
 * How a recorded model call reaches the model under test:
 * - `same`: the recording's own provider and API, asked for another model, with the agent's own key;
 * - `endpoint`: an OpenAI chat recording, asked at another OpenAI-compatible endpoint, with its key;
 * - `to-openai`: an Anthropic recording, translated for an OpenAI-compatible endpoint and back;
 * - `to-anthropic`: an OpenAI chat recording, translated for Anthropic's API and back.
 */
export type TakeoverMode = 'same' | 'endpoint' | 'to-openai' | 'to-anthropic';

export interface ModelTarget {
  /** The model name the API is asked for. */
  model: string;
  /** `same`: the recording's provider. `openai-chat`: an OpenAI-compatible endpoint. `anthropic`: Anthropic's API. */
  route: 'same' | 'openai-chat' | 'anthropic';
  /** The endpoint: with `/v1` for OpenAI-compatible ones, the API root for Anthropic's. */
  baseUrl: string | null;
  /** The environment variable the endpoint's key is read from; the key itself is never stored. */
  keyEnv: string | null;
  /** On this machine: not a paid API. */
  local: boolean;
  /** The endpoint scores are kept under: the base URL given, or null for a provider's own API. */
  scoreBase: string | null;
  /** Where it runs, in words, when that doesn't depend on the recording. */
  via: string | null;
}

const NAME = /^[\w.:/@+-]{1,200}$/;

/** What `--model`, `--base-url` and `--key-env` ask for. */
export function resolveTarget(spec: { model: string; baseUrl?: string | undefined; keyEnv?: string | undefined }, env: NodeJS.ProcessEnv = process.env): ModelTarget {
  const raw = spec.model.trim();
  if (!NAME.test(raw)) throw new Error(`"${spec.model}" is not a model name`);
  if (spec.keyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(spec.keyEnv)) throw new Error(`--key-env takes the name of an environment variable, such as VLLM_API_KEY`);
  if (spec.baseUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(spec.baseUrl.trim());
    } catch {
      throw new Error(`--base-url must be a URL, such as http://127.0.0.1:8000/v1`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--base-url must be an http or https URL');
    // A key in the URL would be kept with every score, run and log line that names the endpoint.
    if (url.username || url.password) throw new Error('--base-url must not carry credentials: put the key in an environment variable and name it with --key-env');
    const base = url.toString().replace(/\/+$/, '');
    const model = raw.replace(/^openai:/, '');
    return { model, route: 'openai-chat', baseUrl: base, keyEnv: spec.keyEnv ?? (url.origin === new URL(OFFICIAL.openai).origin ? 'OPENAI_API_KEY' : null), local: isLoopback(base), scoreBase: base, via: endpointVia(base) };
  }
  const prefixed = /^(anthropic|openai):(.+)$/.exec(raw);
  if (prefixed?.[1] === 'anthropic') return { model: prefixed[2]!, route: 'anthropic', baseUrl: anthropicBase(env), keyEnv: spec.keyEnv ?? 'ANTHROPIC_API_KEY', local: false, scoreBase: null, via: 'Anthropic API' };
  if (prefixed?.[1] === 'openai') {
    const base = openAIBase(env);
    const official = base === OFFICIAL.openai;
    return { model: prefixed[2]!, route: 'openai-chat', baseUrl: base, keyEnv: spec.keyEnv ?? 'OPENAI_API_KEY', local: isLoopback(base), scoreBase: official ? null : base, via: official ? 'OpenAI API' : endpointVia(base) };
  }
  return { model: raw, route: 'same', baseUrl: null, keyEnv: null, local: false, scoreBase: null, via: null };
}

/** Where a target runs, given the provider the recording spoke. */
export function targetVia(target: ModelTarget, provider: string | null): string {
  if (target.via) return target.via;
  return provider === 'anthropic' ? 'Anthropic API' : provider === 'openai' ? 'OpenAI API' : provider ? `${provider} API` : 'the recorded provider';
}

/**
 * How a model call the recording made with `provider`, in `shape`, reaches the target; null when it
 * can't (an API that doesn't translate). `anthropic:<name>` on an Anthropic recording, and
 * `openai:<name>` on an OpenAI one, ask the recording's own provider, as `<name>` does.
 */
export function takeoverMode(provider: string | null, shape: ChatShape | null, target: ModelTarget): TakeoverMode | null {
  if (target.route === 'same') return 'same';
  if (target.route === 'anthropic') return provider === 'anthropic' ? 'same' : shape === 'openai-chat' ? 'to-anthropic' : null;
  if (provider === 'openai' && target.scoreBase === null) return 'same';
  return shape === 'openai-chat' ? 'endpoint' : shape === 'anthropic' ? 'to-openai' : null;
}

/**
 * A model call of the recording's own provider, sent to ask `model` instead: the same path with the
 * request's `model` field changed (Anthropic, OpenAI's chat completions, completions and Responses
 * API), or the path with the model in it changed (Gemini). Null for a request that isn't a model call
 * of that provider, which goes on unchanged.
 */
export function switchModel(provider: string, method: string, path: string, model: string): { path: string; field: boolean } | null {
  if (method.toUpperCase() !== 'POST') return null;
  if (provider === 'anthropic') return /\/messages$/.test(path) ? { path, field: true } : null;
  if (provider === 'openai') return /\/(chat\/completions|completions|responses)$/.test(path) ? { path, field: true } : null;
  if (provider === 'gemini') {
    const m = /^(.*\/)(?:models|tunedModels)\/[^/:]+(:(?:stream)?generateContent)$/i.exec(path);
    return m ? { path: `${m[1]}${model.includes('/') ? model : `models/${model}`}${m[2]}`, field: false } : null;
  }
  return null;
}

/**
 * Why a model call of the recording's own provider can't be sent to another model, or null when it
 * can: Bedrock signs the URL its model is in, Vertex AI is reached at the agent's own regional
 * address, and an Azure deployment picks its model.
 */
export function modelUnswitchable(provider: string | null, callName: string): string | null {
  if (provider === 'bedrock') return 'its takeover call goes through Amazon Bedrock, whose request signature covers the model in its URL';
  if (provider === 'vertex') return "its takeover call goes through Vertex AI, at the agent's own regional address";
  if (provider === 'azure') return 'its takeover call goes through Azure OpenAI, where the deployment in the URL picks the model';
  const m = /^([A-Z]+)\s+(\S+)/.exec(callName);
  const path = (m?.[2] ?? callName).split('?')[0] ?? '';
  if (!provider || !switchModel(provider, m?.[1] ?? 'POST', path, 'm')) return `scoring can't change the model of ${provider ? `${/^[aeiou]/i.test(provider) ? 'an' : 'a'} ${provider}` : 'this'} request (${path})`;
  return null;
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * A request to the model under test with no time limit of its own, as the sidecar's to a provider:
 * a local model writing a long answer may take minutes, and the agent's own client decides when to
 * give up.
 */
function post(url: string, headers: Record<string, string>, body: unknown): Promise<Reply> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = send(target, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(bytes.length), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out[k] = v;
        resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

/** The path of the recorded API's model call: the one request the model under test answers. */
function isModelCall(recorded: ChatShape, path: string): boolean {
  return recorded === 'anthropic' ? /^\/(v1\/)?messages$/.test(path) : /\/chat\/completions$/.test(path);
}

function parse(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return bytes.toString('utf8');
  }
}

export interface TakeoverOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Where the recording's provider is. A request that isn't the model under test's (an embeddings
   * call, a token count) goes there unchanged, with the agent's own headers, and so does the model
   * call itself when the model under test is the provider's. Null: they are refused, naming the
   * endpoint.
   */
  upstream?: string | null;
}

export interface TakeoverSpec {
  /** The provider the recording made the takeover call with. */
  provider: string;
  /** The API it spoke, when it is one that translates. */
  shape: ChatShape | null;
  mode: TakeoverMode;
}

export interface Takeover {
  /** The upstream to give the sidecar for the recording's provider. */
  url: string;
  /** What the translation dropped, once each across the attempts. */
  readonly dropped: Set<string>;
  /** Requests the model under test answered. */
  readonly answered: number;
  close(): Promise<void>;
}

/**
 * Starts the upstream for one target, for the recording's provider at the takeover call. It listens
 * on this machine, under a random path. Model calls go to the model under test, and everything else
 * to the provider's own upstream.
 */
export async function startTakeover(spec: TakeoverSpec, target: ModelTarget, options: TakeoverOptions = {}): Promise<Takeover> {
  const { mode, provider } = spec;
  const env = options.env ?? process.env;
  const upstream = options.upstream ? options.upstream.replace(/\/+$/, '') : null;
  if (mode === 'same' && !upstream) throw new Error(`there is nowhere to send ${provider}'s calls to ${target.model}: set SHADOWLAP_UPSTREAM_${provider.toUpperCase()}`);
  if (mode !== 'same' && (!target.baseUrl || !spec.shape)) throw new Error(`${target.model} has no endpoint to translate a ${provider} conversation for`);
  // The recording's API: what the agent's SDK parses, errors included.
  const recorded: ChatShape = spec.shape ?? (provider === 'anthropic' ? 'anthropic' : 'openai-chat');
  const base = target.baseUrl ?? '';
  // The agent's own key goes to its own provider; a key from the environment only to the endpoint it is for.
  const key = mode !== 'same' && target.keyEnv ? env[target.keyEnv]?.trim() : undefined;
  if (mode !== 'same' && target.keyEnv && !key && !target.local) throw new Error(`${target.keyEnv} is not set: ${target.model} at ${base} needs its key in the environment`);
  const token = randomBytes(16).toString('hex');
  const dropped = new Set<string>();
  let answered = 0;
  const official = (() => {
    try {
      return new URL(base).origin === new URL(OFFICIAL.openai).origin;
    } catch {
      return false;
    }
  })();
  const by = { [ANSWERED_BY]: target.model };

  const reply = (res: ServerResponse, status: number, contentType: string, body: string | Buffer, extra: Record<string, string> = {}) => {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    res.writeHead(status, { 'content-type': contentType, 'content-length': String(bytes.length), ...extra });
    res.end(bytes);
  };
  const fail = (res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}) => reply(res, status, 'application/json', JSON.stringify(errorBody(recorded, status, message)), extra);

  /**
   * A request sent on to the provider as the agent made it (or with `body` in its place), and the
   * answer back as it came, streamed. `answer`: it is the model under test's, and says so.
   */
  const relay = async (req: IncomingMessage, res: ServerResponse, rest: string, o: { body?: Buffer; answer?: boolean } = {}) => {
    const name = `${req.method ?? 'GET'} ${rest.split('?')[0]}`;
    if (!upstream) return fail(res, 501, `${name} isn't sent anywhere while ${target.model} takes over: only the model call is`);
    const body = o.body ?? (await readBody(req));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !HOP_BY_HOP.has(k)) headers[k] = v;
    const url = new URL(`${upstream}${rest}`);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    await new Promise<void>((resolve) => {
      const out = send(url, { method: req.method ?? 'GET', headers: { ...headers, ...(body.length ? { 'content-length': String(body.length) } : {}) } }, (up) => {
        const back: Record<string, string> = {};
        for (const [k, v] of Object.entries(up.headers)) if (typeof v === 'string' && !HOP_BY_HOP.has(k)) back[k] = v;
        const status = up.statusCode ?? 502;
        if (o.answer && status < 400) answered++;
        res.writeHead(status, { ...back, ...(o.answer ? by : {}) });
        up.pipe(res);
        up.on('end', resolve);
        up.on('error', () => {
          res.destroy();
          resolve();
        });
      });
      out.on('error', (err) => {
        if (!res.headersSent) fail(res, 502, `${name} couldn't reach ${url.origin}: ${err.message}`, o.answer ? by : {});
        else res.destroy();
        resolve();
      });
      out.end(body.length ? body : undefined);
    });
  };

  /** The recording's own API, another model: the request names it, and the provider answers as it would have. */
  const same = async (req: IncomingMessage, res: ServerResponse, rest: string, search: string) => {
    const at = switchModel(provider, req.method ?? 'GET', rest, target.model);
    if (!at) return relay(req, res, `${rest}${search}`);
    const raw = await readBody(req);
    if (!at.field) return relay(req, res, `${at.path}${search}`, { body: raw, answer: true });
    const request = parse(raw);
    // Not JSON: nothing to name a model in, so it goes on as it is, and is no answer of the model under test.
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return relay(req, res, `${rest}${search}`, { body: raw });
    return relay(req, res, `${rest}${search}`, { body: Buffer.from(JSON.stringify({ ...(request as Record<string, unknown>), model: target.model }), 'utf8'), answer: true });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://takeover');
    const prefix = `/t/${token}`;
    if (!url.pathname.startsWith(`${prefix}/`)) return fail(res, 404, 'not found');
    const rest = url.pathname.slice(prefix.length);
    if (mode === 'same') return same(req, res, rest, url.search);
    // Only the recorded API's model call is the model under test's; an embeddings call or a token count is the provider's, as recorded.
    if (req.method !== 'POST' || !isModelCall(recorded, rest)) return relay(req, res, `${rest}${url.search}`);
    const request = parse(await readBody(req));
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return fail(res, 400, 'the request is not JSON');
    const body = request as Record<string, unknown>;
    const stream = body.stream === true;
    const includeUsage = typeof body.stream_options === 'object' && body.stream_options !== null && (body.stream_options as { include_usage?: unknown }).include_usage === true;
    try {
      if (mode === 'to-openai') {
        const t = anthropicToOpenAIChat(body, { model: target.model, maxTokensField: official ? 'max_completion_tokens' : 'max_tokens' });
        t.dropped.forEach((d) => dropped.add(d));
        const r = await post(`${base}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, { ...t.body, stream: false });
        const answer = parse(r.body);
        if (r.status >= 400) return fail(res, r.status, `${target.model} at ${base}: ${errorMessage(answer, `HTTP ${r.status}`)}`, by);
        const message = openAIChatToAnthropicMessage(answer, { model: target.model });
        answered++;
        return stream ? reply(res, 200, 'text/event-stream; charset=utf-8', anthropicMessageEvents(message), by) : reply(res, 200, 'application/json', JSON.stringify(message), by);
      }
      if (mode === 'endpoint') {
        // The same API: only the model, the endpoint and its key change.
        const r = await post(`${base}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, { ...body, model: target.model });
        if (r.status < 400) answered++;
        return reply(res, r.status, r.headers['content-type'] ?? 'application/json', r.body, by);
      }
      const t = openAIChatToAnthropic(body, { model: target.model });
      t.dropped.forEach((d) => dropped.add(d));
      const r = await post(`${base}/v1/messages`, { ...(key ? { 'x-api-key': key } : {}), 'anthropic-version': '2023-06-01' }, { ...t.body, stream: false });
      const answer = parse(r.body);
      if (r.status >= 400) return fail(res, r.status, `${target.model}: ${errorMessage(answer, `HTTP ${r.status}`)}`, by);
      const completion = anthropicMessageToOpenAIChat(answer, { model: target.model });
      answered++;
      return stream ? reply(res, 200, 'text/event-stream; charset=utf-8', chatCompletionChunks(completion, { includeUsage }), by) : reply(res, 200, 'application/json', JSON.stringify(completion), by);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code;
      return fail(res, 502, code === 'ECONNREFUSED' ? `${target.model} at ${base} isn't reachable: nothing is listening there` : `${target.model} at ${base}: ${message}`, by);
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) fail(res, 500, err instanceof Error ? err.message : String(err));
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/t/${token}`,
    dropped,
    get answered() {
      return answered;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
