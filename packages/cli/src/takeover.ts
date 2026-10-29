import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttp2Server, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import {
  anthropicAnswer,
  anthropicBase,
  anthropicMessageToOpenAIChat,
  answerAs,
  chatCompletionOf,
  endpointVia,
  errorAs,
  errorMessage,
  isLoopback,
  isTakeoverCall,
  messageOf,
  modelUnswitchable,
  OFFICIAL,
  openAIBase,
  openAIChatToAnthropic,
  requestFor,
  switchTakeoverModel,
  takeoverMode,
  wantsStream,
  type ChatShape,
  type EncodedAnswer,
  type TakeoverMode,
} from '@shadowlap/engine';
import { BodyTooLarge, MODEL_BODY_LIMIT, readBody as readWholeBody } from '@shadowlap/engine';

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
 * the answer back for the agent, in the recording's own API (Anthropic's, OpenAI's, Bedrock's,
 * Vertex AI's or Gemini's), streamed as its client asked. Anything else the agent sends that provider
 * (an embeddings call, a token count, a model list) goes to the provider unchanged, as the sidecar
 * would have sent it. Each answer to a model call says which model gave it (`x-shadowlap-model`): the
 * sidecar records that as the call's model, and a score checks it. The engine's takeover.ts decides
 * how each call is carried; this module sends it.
 */

/** The response header a takeover upstream answers each model call with: the model that answered. */
export const ANSWERED_BY = 'x-shadowlap-model';

export type { TakeoverMode };
export { modelUnswitchable, takeoverMode };
/** A model call of the recording's own provider, sent to ask `model` instead (the engine's switchTakeoverModel). */
export const switchModel = switchTakeoverModel;

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

const PROVIDER_API: Record<string, string> = { anthropic: 'Anthropic API', openai: 'OpenAI API', gemini: 'Gemini API', bedrock: 'Amazon Bedrock', vertex: 'Vertex AI', azure: 'Azure OpenAI' };

/** Where a target runs, given the provider the recording spoke. */
export function targetVia(target: ModelTarget, provider: string | null): string {
  if (target.via) return target.via;
  return provider ? (PROVIDER_API[provider] ?? `${provider} API`) : 'the recorded provider';
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

type AnyRequest = IncomingMessage | Http2ServerRequest;
type AnyResponse = ServerResponse | Http2ServerResponse;

/** A model request's whole body, at most MODEL_BODY_LIMIT, as the sidecar reads one (body.ts in the engine). */
const readBody = (req: AnyRequest): Promise<Buffer> => readWholeBody(req, { limit: MODEL_BODY_LIMIT });

/** Headers that belong to one connection, never carried across: HTTP/2 refuses them outright. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'http2-settings']);

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
 * One listener for both HTTP/1.1 and HTTP/2 without TLS: the sidecar forwards a request the way it
 * arrived, and an AWS SDK that signs over HTTP/2 arrives that way. The connection's first bytes say
 * which: HTTP/2 opens with `PRI * HTTP/2.0`.
 */
function listenBoth(handle: (req: AnyRequest, res: AnyResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const h1 = createServer(handle);
  const h2 = createHttp2Server(handle);
  const sockets = new Set<Socket>();
  const front = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const sniff = () => {
      const head = socket.read() as Buffer | null;
      if (!head) return socket.once('readable', sniff);
      if (head.length < 2 && head[0] === 0x50) {
        socket.unshift(head);
        return socket.once('readable', sniff);
      }
      socket.unshift(head);
      (head.subarray(0, 2).toString('latin1') === 'PR' ? h2 : h1).emit('connection', socket);
    };
    socket.once('readable', sniff);
  });
  return new Promise((resolve, reject) => {
    front.once('error', reject);
    front.listen(0, '127.0.0.1', () =>
      resolve({
        port: (front.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            front.close(() => done());
          }),
      }),
    );
  });
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

  // Either protocol's response takes the same status and headers; their typings just don't overlap.
  const head = (res: AnyResponse, status: number, headers: Record<string, string>) => (res as ServerResponse).writeHead(status, headers);
  const send = (res: AnyResponse, a: EncodedAnswer, extra: Record<string, string> = {}) => {
    head(res, a.status, { 'content-type': a.contentType, 'content-length': String(a.body.length), ...a.headers, ...extra });
    res.end(a.body);
  };
  const fail = (res: AnyResponse, status: number, message: string, extra: Record<string, string> = {}) => send(res, errorAs(provider, recorded, status, message), extra);

  /**
   * A request sent on to the provider as the agent made it (or with `body` in its place), and the
   * answer back as it came, streamed. `answer`: it is the model under test's, and says so.
   */
  const relay = async (req: AnyRequest, res: AnyResponse, rest: string, o: { body?: Buffer; answer?: boolean } = {}) => {
    const name = `${req.method ?? 'GET'} ${rest.split('?')[0]!}`;
    if (!upstream) return fail(res, 501, `${name} isn't sent anywhere while ${target.model} takes over: only the model call is`);
    const body = o.body ?? (await readBody(req));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !k.startsWith(':') && !HOP_BY_HOP.has(k)) headers[k] = v;
    const url = new URL(`${upstream}${rest}`);
    const out_ = url.protocol === 'https:' ? httpsRequest : httpRequest;
    await new Promise<void>((resolve) => {
      const out = out_(url, { method: req.method ?? 'GET', headers: { ...headers, ...(body.length ? { 'content-length': String(body.length) } : {}) } }, (up) => {
        const back: Record<string, string> = {};
        for (const [k, v] of Object.entries(up.headers)) if (typeof v === 'string' && !HOP_BY_HOP.has(k)) back[k] = v;
        const status = up.statusCode ?? 502;
        if (o.answer && status < 400) answered++;
        head(res, status, { ...back, ...(o.answer ? by : {}) });
        up.pipe(res as NodeJS.WritableStream);
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
  const same = async (req: AnyRequest, res: AnyResponse, rest: string, search: string) => {
    const at = switchTakeoverModel(provider, req.method ?? 'GET', rest, target.model);
    // A model call no switch reaches (a cloud's signed URL, regional address or deployment) is scored
    // only for the model it recorded (cannotScore): it goes on as the agent made it, and is the answer.
    if (!at) return relay(req, res, `${rest}${search}`, isTakeoverCall(provider, recorded, req.method ?? 'GET', rest) ? { answer: true } : {});
    const raw = await readBody(req);
    if (!at.field) return relay(req, res, `${at.path}${search}`, { body: raw, answer: true });
    const request = parse(raw);
    // Not JSON: nothing to name a model in, so it goes on as it is, and is no answer of the model under test.
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return relay(req, res, `${rest}${search}`, { body: raw });
    return relay(req, res, `${rest}${search}`, { body: Buffer.from(JSON.stringify({ ...(request as Record<string, unknown>), model: target.model }), 'utf8'), answer: true });
  };

  /** Asks an OpenAI-compatible endpoint for a whole answer to an OpenAI chat request, as a chat completion. */
  const askEndpoint = async (res: AnyResponse, body: Record<string, unknown>) => {
    const r = await post(`${base}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, { ...body, stream: false });
    const answer = parse(r.body);
    if (r.status >= 400) {
      fail(res, r.status, `${target.model} at ${base}: ${errorMessage(answer, `HTTP ${r.status}`)}`, by);
      return null;
    }
    return chatCompletionOf(answer, { model: target.model });
  };

  /** Asks Anthropic's API for a whole answer to an Anthropic request, as a message. */
  const askAnthropic = async (res: AnyResponse, body: Record<string, unknown>) => {
    const r = await post(`${base}/v1/messages`, { ...(key ? { 'x-api-key': key } : {}), 'anthropic-version': '2023-06-01' }, { ...body, stream: false });
    const answer = parse(r.body);
    if (r.status >= 400) {
      fail(res, r.status, `${target.model}: ${errorMessage(answer, `HTTP ${r.status}`)}`, by);
      return null;
    }
    if (typeof answer !== 'object' || answer === null || !Array.isArray((answer as { content?: unknown }).content)) {
      fail(res, 502, `${target.model}: the answer is not an Anthropic message`, by);
      return null;
    }
    return answer as Record<string, unknown> & { content: unknown[] };
  };

  const handle = async (req: AnyRequest, res: AnyResponse) => {
    const url = new URL(req.url ?? '/', 'http://takeover');
    const prefix = `/t/${token}`;
    if (!url.pathname.startsWith(`${prefix}/`)) return fail(res, 404, 'not found');
    const rest = url.pathname.slice(prefix.length);
    if (mode === 'same') return same(req, res, rest, url.search);
    // Only the recorded API's model call is the model under test's; an embeddings call or a token count is the provider's, as recorded.
    if (!isTakeoverCall(provider, recorded, req.method ?? 'GET', rest)) return relay(req, res, `${rest}${url.search}`);
    const request = parse(await readBody(req));
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return fail(res, 400, 'the request is not JSON');
    const body = request as Record<string, unknown>;
    const stream = wantsStream(provider, recorded, rest, body);
    try {
      if (mode === 'endpoint') {
        // The same API: only the model, the endpoint and its key change, and the answer comes back as the endpoint gave it.
        const r = await post(`${base}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, { ...body, model: target.model });
        if (r.status < 400) answered++;
        return send(res, { status: r.status, contentType: r.headers['content-type'] ?? 'application/json', body: r.body, headers: {} }, by);
      }
      if (mode === 'anthropic-api') {
        const t = requestFor('anthropic-api', recorded, body, { model: target.model });
        t.dropped.forEach((d) => dropped.add(d));
        const message = await askAnthropic(res, t.body);
        if (!message) return;
        answered++;
        return send(res, anthropicAnswer(provider, message, stream), by);
      }
      // Into OpenAI's chat first; for Anthropic's API, from there into its messages.
      const chat = recorded === 'openai-chat' ? { body, dropped: [] as string[] } : requestFor('to-openai', recorded, body, { model: target.model, maxTokensField: official ? 'max_completion_tokens' : 'max_tokens' });
      chat.dropped.forEach((d) => dropped.add(d));
      let completion;
      if (mode === 'to-openai') {
        completion = await askEndpoint(res, chat.body);
      } else {
        const t = openAIChatToAnthropic(chat.body, { model: target.model });
        t.dropped.forEach((d) => dropped.add(d));
        const message = await askAnthropic(res, t.body);
        completion = message ? anthropicMessageToOpenAIChat(message, { model: target.model }) : null;
      }
      if (!completion) return;
      answered++;
      return send(res, answerAs(provider, recorded, completion, { model: target.model, stream, search: url.search, request: body }), by);
    } catch (err) {
      const message = messageOf(err);
      const code = (err as { code?: string }).code;
      return fail(res, 502, code === 'ECONNREFUSED' ? `${target.model} at ${base} isn't reachable: nothing is listening there` : `${target.model} at ${base}: ${message}`, by);
    }
  };

  const server = await listenBoth((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) fail(res, err instanceof BodyTooLarge ? 413 : 500, messageOf(err));
      else res.destroy();
    });
  });
  return {
    url: `http://127.0.0.1:${server.port}/t/${token}`,
    dropped,
    get answered() {
      return answered;
    },
    close: server.close,
  };
}
