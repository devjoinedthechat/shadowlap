// shadowlap in-process capture for Node agents. Preloaded with the network guard (NODE_OPTIONS=--import).
//
// Most model clients read a base URL from the environment, and `shadowlap run` points those at the
// sidecar. Some can't be pointed anywhere: Bedrock clients sign each request for its host (a base
// URL would break the signature), Azure and Vertex clients often take their endpoint or region in
// code, and any client may hardcode its base URL. For those, this module sends the request itself,
// byte for byte with every signed header, to the sidecar, and names the host it was going to in
// `x-shadowlap-upstream`. The sidecar records it and forwards it to that host (only hosts a provider
// declares), or serves it from the recording on replay.
//
// Whatever goes to the sidecar, a captured call or one a base URL already points there, goes on a
// connection of its own to this machine's loopback: never through a proxy the agent set up (a
// dispatcher for fetch, a replaced http.globalAgent), which would see the call, its key and the
// session token, and never over TLS, which the sidecar doesn't speak. A WebSocket for the sidecar
// (`wss://` from an OpenAI Realtime client whose base URL is the sidecar) opens as `ws://`.
//
// Routes arrive in SHADOWLAP_CAPTURE as JSON: { "routes": [[hostRegex, providerId], ...],
// "hosts": { "host:port": providerId }, "http": [[hostRegex, port | null], ...] }. The last are HTTP
// hosts the user declared, recorded as tools; they go to the sidecar's `http` route over either
// scheme. SHADOWLAP_CAPTURE=off disables capture.
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import zlib from 'node:zlib';

const sidecarUrl = process.env.SHADOWLAP_URL;
const runId = process.env.SHADOWLAP_RUN_ID;
const config = process.env.SHADOWLAP_CAPTURE;

/**
 * globalThis as the preloads share it: whether each set itself up, and what they hand each other
 * under registered symbols (the request functions taken here, the SDK's scope, capture's state).
 * @type {typeof globalThis & { __shadowlapCapture?: boolean } & Record<symbol, unknown>}
 */
const shared = globalThis;

/** @typedef {{ getStore?: () => unknown } | undefined} Store What the SDK keeps for the call in progress (an AsyncLocalStorage), under a registered symbol. */
/** @typedef {http.RequestOptions & { protocol?: string | null; agent?: (http.Agent & { protocol?: string }) | boolean; headers?: unknown }} RequestOptions A request's options, as http(s).request takes them. */

// Without a run id (a test worker whose runs change from test to test), SHADOWLAP_URL names a slot
// and the sidecar resolves the run.
if (sidecarUrl && config && config !== 'off' && !shared.__shadowlapCapture) {
  shared.__shadowlapCapture = true;
  /** @type {Array<[RegExp, string]>} */
  let routes = [];
  /** @type {Record<string, string>} */
  let exactHosts = {};
  /** @type {Array<[RegExp, string | null]>} */
  let httpHosts = [];
  try {
    const parsed = /** @type {{ routes?: Array<[string, string]>; hosts?: Record<string, string>; http?: Array<[string, string | null]> }} */ (JSON.parse(config));
    routes = (parsed.routes ?? []).map(([source, provider]) => [new RegExp(source), provider]);
    exactHosts = parsed.hosts ?? {};
    httpHosts = (parsed.http ?? []).map(([source, port]) => [new RegExp(source), port]);
  } catch {
    process.stderr.write('[shadowlap] SHADOWLAP_CAPTURE is not valid JSON; in-process capture is off\n');
  }
  const sidecar = new URL(sidecarUrl);
  const sidecarKey = `${sidecar.hostname}:${sidecar.port}`;

  // The originals, taken before anything below replaces them, and left for the guard, recorded input
  // and the hello, which reach the sidecar on agents of their own: through the wrapper below they
  // would share the sidecar's pooled connections with the agent's own calls.
  const httpRequest = http.request;
  const httpsRequest = https.request;
  const originalFetch = globalThis.fetch;
  shared[Symbol.for('shadowlap.request')] = { 'http:': httpRequest, 'https:': httpsRequest };

  /** A URL, or null for what doesn't read as one. */
  const parseUrl = (/** @type {unknown} */ value) => {
    try {
      return new URL(/** @type {string} */ (value));
    } catch {
      return null;
    }
  };
  const defaultPort = (/** @type {URL} */ url) => (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
  const toSidecar = (/** @type {URL | null} */ url) => url !== null && `${url.hostname}:${url.port || defaultPort(url)}` === sidecarKey;

  // On unless a test runner turns it off between recorded tests (@shadowlap/test sets `active`), so
  // a test without a recording calls its model where it was going, as the Python module's `active`.
  const state = /** @type {{ active: boolean }} */ ((shared[Symbol.for('shadowlap.capture')] ??= { active: true }));

  /**
   * The provider a URL belongs to, or null to leave the request alone.
   * @param {URL} url
   * @returns {string | null}
   */
  function providerFor(url) {
    if (!state.active) return null;
    const port = url.port || defaultPort(url);
    const key = `${url.hostname}:${port}`;
    if (key === sidecarKey) return null;
    if (exactHosts[key]) return exactHosts[key];
    if (url.protocol === 'https:') for (const [re, provider] of routes) if (re.test(url.hostname)) return provider;
    if (url.protocol === 'http:' || url.protocol === 'https:') for (const [re, p] of httpHosts) if (re.test(url.hostname.toLowerCase()) && (p === null || p === port)) return 'http';
    return null;
  }

  const runSegment = runId ? `/r/${encodeURIComponent(runId)}` : '';
  // The SDK's scope() (see @shadowlap/sdk): the store is shared through a global symbol. Outside one,
  // the scope the process starts in, from SHADOWLAP_SCOPE (a sub-agent run as its own process), with
  // the limits the sidecar accepts. Returned as x-shadowlap-scope carries it, with % and anything
  // outside printable ASCII percent-encoded, as the SDK sends it: a header holds Latin-1 at most, and
  // a scope can have any name.
  const baseScope = () => {
    const raw = process.env.SHADOWLAP_SCOPE?.trim();
    return !raw || raw.length > 200 || /[\u0000-\u001f\u007f]/.test(raw) ? undefined : raw;
  };
  const currentScope = () => {
    const scope = /** @type {string | undefined} */ (/** @type {Store} */ (shared[Symbol.for('shadowlap.scope')])?.getStore?.() ?? baseScope());
    if (!scope) return undefined;
    return scope.replace(/[^\x20-\x24\x26-\x7e]/gu, (c) => {
      try {
        return encodeURIComponent(c);
      } catch {
        return '%EF%BF%BD';
      }
    });
  };

  /**
   * Where a call for `provider` goes on the sidecar: its route, under the run's.
   * @param {string} provider
   * @param {URL} url
   * @returns {string}
   */
  function sidecarPath(provider, url) {
    return `${sidecar.pathname.replace(/\/$/, '')}${runSegment}/${provider}${url.pathname}${url.search}`;
  }

  // ---- OPENAI_BASE_URL, as the OpenAI SDK reads it ----
  // `shadowlap run` points OPENAI_BASE_URL at the sidecar, and agents rely on that, often through
  // `process.env.OPENAI_BASE_URL ?? '<a server of their own>'`, so the variable stays as it is. The
  // OpenAI SDK's AzureOpenAI takes its baseURL default from the same variable, though, and throws
  // when it also gets an endpoint. Every OpenAI client here is captured by the host it calls, which
  // needs no base URL: so the openai package's own read of the variable, the default of a client
  // built without a baseURL, gets what the person had, nothing, and the client calls its own host,
  // which says what it is: api.openai.com is captured as openai, an Azure endpoint as azure. The
  // reader is told apart by where its code is (V8's structured stack, the file it runs from), and
  // only in a process that can load the openai package: anywhere else process.env stays itself.
  const openaiBase = process.env.OPENAI_BASE_URL;
  if (process.env.SHADOWLAP_OPENAI_BASE_URL_WAS === '' && openaiBase && toSidecar(parseUrl(openaiBase)) && providerFor(new URL('https://api.openai.com/v1')) === 'openai' && canLoad('openai')) {
    const env = process.env;
    /** @type {(target: NodeJS.ProcessEnv, key: string | symbol) => unknown} */
    const get = (target, key) => (key === 'OPENAI_BASE_URL' && target.OPENAI_BASE_URL === openaiBase && readByOpenAI(get) ? undefined : Reflect.get(target, key));
    process.env = new Proxy(env, {
      get,
      // Set on process.env itself. Without this, setting a variable that is already there goes
      // through the proxy as a bare define, which process.env refuses (ERR_INVALID_OBJECT_DEFINE_PROPERTY):
      // npm and npx set their own variables as they start and exit 1 without a word, and so would
      // an agent that sets one.
      set: (target, key, value) => Reflect.set(target, key, value),
    });
  }

  /**
   * Whether a package resolves from where the agent runs: its working folder, or its main script's.
   * @param {string} name
   * @returns {boolean}
   */
  function canLoad(name) {
    for (const from of [process.cwd(), process.argv[1] ? dirname(resolve(process.argv[1])) : null]) {
      if (!from) continue;
      try {
        createRequire(join(from, 'noop.js')).resolve(name);
        return true;
      } catch {
        // not from here
      }
    }
    return false;
  }

  /**
   * Whether the code reading a variable now (the frame below `trap`) is the openai package's own:
   * code in its folder, or, in an agent bundled with its dependencies, the constructor of an OpenAI
   * or AzureOpenAI client that kept its name.
   * @param {Function} trap
   * @returns {boolean}
   */
  function readByOpenAI(trap) {
    const prepare = Error.prepareStackTrace;
    const limit = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 4;
      Error.prepareStackTrace = (_, sites) => sites;
      /** @type {{ stack?: unknown }} */
      const holder = {};
      Error.captureStackTrace(holder, trap);
      const sites = /** @type {NodeJS.CallSite[]} */ (Array.isArray(holder.stack) ? holder.stack : []);
      if (/[\\/]node_modules[\\/]openai[\\/]/.test(sites[0]?.getFileName?.() ?? '')) return true;
      return sites.some((site) => site.isConstructor?.() && /^(Azure)?OpenAI$/.test(site.getFunctionName?.() ?? ''));
    } catch {
      return false;
    } finally {
      Error.prepareStackTrace = prepare;
      Error.stackTraceLimit = limit;
    }
  }

  // A replay can fail a captured HTTP call with a timeout or an error (--fail-at <call>=timeout). The
  // sidecar answers a request that says it can take one (x-shadowlap-failures: raise) by naming the
  // failure, and the agent gets the error its HTTP client raises for the real thing: its error path runs.
  const decodeMessage = (/** @type {unknown} */ value) => {
    if (typeof value !== 'string' || !value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  /** The error a connection reset reaches a Node client with: `read ECONNRESET`, or the message --fail-at gave. */
  const resetError = (/** @type {string | undefined} */ message) => Object.assign(new Error(message ?? 'read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' });

  /**
   * fetch: a timeout rejects as AbortSignal.timeout() makes it; an error as undici's "fetch failed".
   * @param {Response} response
   * @returns {Promise<Response>}
   */
  async function failedFetch(response) {
    const kind = response.headers.get('x-shadowlap-injected');
    if (!kind) return response;
    try {
      await response.body?.cancel();
    } catch {
      // nothing to read
    }
    const message = decodeMessage(response.headers.get('x-shadowlap-injected-message'));
    if (kind === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    throw new TypeError('fetch failed', { cause: resetError(message) });
  }

  /**
   * http.request: the response never reaches the agent. A timeout is the request's own 'timeout' event,
   * where clients that set one raise their timeout error, then the socket's ETIMEDOUT if nothing ended
   * the request; an error is a connection reset.
   * @param {http.ClientRequest} req
   * @returns {http.ClientRequest}
   */
  function failOnInjected(req) {
    const emit = req.emit;
    /**
     * @this {http.ClientRequest}
     * @param {string | symbol} event
     * @param {unknown[]} args
     * @returns {boolean}
     */
    req.emit = function (event, ...args) {
      const res = event === 'response' ? /** @type {http.IncomingMessage | undefined} */ (args[0]) : undefined;
      const kind = res?.headers?.['x-shadowlap-injected'];
      if (!res || !kind) return emit.call(this, event, ...args);
      res.resume();
      const message = decodeMessage(res.headers['x-shadowlap-injected-message']);
      if (kind === 'timeout') {
        emit.call(this, 'timeout');
        if (!this.destroyed) this.destroy(Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'read' }));
      } else this.destroy(resetError(message));
      return true;
    };
    return req;
  }

  // The sidecar is reached directly: an agent a client was given was for the host it named, and
  // http.globalAgent may be a proxy package's, which would send the request to its proxy.
  const sidecarAgent = new http.Agent({ keepAlive: true });

  // ---- fetch: the Anthropic, OpenAI and Google SDKs, and the Anthropic Bedrock and Vertex clients ----
  // Sent with http.request on the sidecar's own agent, not with fetch: an agent that routes fetch
  // through a proxy of its own (undici's ProxyAgent set with setGlobalDispatcher, which ignores
  // NO_PROXY) would send the proxy the call, its key and the session token. The request and its
  // answer are fetch's all the same: its default headers, its body types, redirects, an AbortSignal,
  // a decoded body, and its errors.
  /**
   * A fetch, captured or left to fetch itself; `redirects` is how many it followed to get here.
   * @param {string | URL | Request} input
   * @param {RequestInit | undefined} init
   * @param {number} redirects
   * @returns {Promise<Response>}
   */
  function routedFetch(input, init, redirects) {
    const url = parseUrl(typeof input === 'string' || input instanceof URL ? input : input?.url);
    if (!url) return originalFetch(input, init);
    const provider = providerFor(url);
    if (!provider && !toSidecar(url)) return originalFetch(input, init);
    return fetchViaSidecar(input, init, url, provider, redirects).then((response) => (provider === 'http' ? failedFetch(response) : response));
  }
  if (typeof originalFetch === 'function') {
    globalThis.fetch = /** @type {typeof fetch} */ (
      /**
       * @param {string | URL | Request} input
       * @param {RequestInit} [init]
       */
      function capturedFetch(input, init) {
        return routedFetch(input, init, 0);
      }
    );
  }

  /**
   * fetch's own default request headers, which it adds to a request that has none of them.
   * @param {Headers} headers
   * @param {URL} url
   */
  function fetchDefaults(headers, url) {
    if (!headers.has('accept')) headers.set('accept', '*/*');
    if (!headers.has('accept-language')) headers.set('accept-language', '*');
    if (!headers.has('sec-fetch-mode')) headers.set('sec-fetch-mode', 'cors');
    if (!headers.has('user-agent')) headers.set('user-agent', 'node');
    if (!headers.has('accept-encoding')) headers.set('accept-encoding', url.protocol === 'https:' ? 'br, gzip, deflate' : 'gzip, deflate');
  }

  /** A body fetch can send again for a redirect, which it holds whole: anything but a stream. */
  const replayable = (/** @type {unknown} */ body) => body === undefined || body === null || typeof body === 'string' || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof URLSearchParams || body instanceof Blob || body instanceof FormData;

  /**
   * A fetch sent to the sidecar with http.request, and its answer as fetch gives one.
   * @param {string | URL | Request} input
   * @param {RequestInit | undefined} init
   * @param {URL} url
   * @param {string | null} provider
   * @param {number} redirects
   * @returns {Promise<Response>}
   */
  async function fetchViaSidecar(input, init, url, provider, redirects) {
    // Built as fetch builds it: the arguments merged, a body of any kind read, content-type set.
    const request = new Request(input, init);
    const { signal } = request;
    if (signal.aborted) throw signal.reason;
    const headers = new Headers(request.headers);
    // A Host of the agent's own (one passed on from a request it was answering) goes nowhere, as
    // fetch sends none: the sidecar is named by its loopback address, as its Host check asks, and
    // takes the host a call is for from x-shadowlap-upstream.
    headers.delete('host');
    fetchDefaults(headers, url);
    if (provider) {
      headers.set('x-shadowlap-upstream', url.origin);
      if (provider === 'http') headers.set('x-shadowlap-failures', 'raise');
    }
    const scoped = currentScope();
    if (scoped) headers.set('x-shadowlap-scope', scoped);
    const source = init !== undefined && init !== null && 'body' in init ? init.body : input instanceof Request ? input.body : undefined;
    const whole = request.body !== null && replayable(source) ? Buffer.from(await request.arrayBuffer()) : null;
    const path = provider ? sidecarPath(provider, url) : `${url.pathname}${url.search}`;
    /** @type {http.IncomingMessage} */
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({ protocol: 'http:', hostname: sidecar.hostname, port: sidecar.port, path, method: request.method, headers: Object.fromEntries(headers), agent: sidecarAgent }, resolve);
      const abort = () => req.destroy(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      req.once('response', () => signal.removeEventListener('abort', abort));
      req.on('error', (err) => {
        signal.removeEventListener('abort', abort);
        reject(signal.aborted ? signal.reason : new TypeError('fetch failed', { cause: err }));
      });
      if (whole) req.end(whole);
      else if (request.body) Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (request.body)).on('error', (err) => req.destroy(err)).pipe(req);
      else req.end();
    });
    const status = res.statusCode ?? 502;
    const location = res.headers.location;
    // Redirects are followed as fetch follows them, unless the request said otherwise.
    if ([301, 302, 303, 307, 308].includes(status) && typeof location === 'string' && request.redirect !== 'manual') {
      res.resume();
      if (request.redirect === 'error' || redirects >= 20) throw new TypeError('fetch failed', { cause: new Error(request.redirect === 'error' ? 'unexpected redirect' : 'redirect count exceeded') });
      const next = new URL(location, url);
      const asGet = (status === 303 && request.method !== 'HEAD') || ((status === 301 || status === 302) && request.method === 'POST');
      if (!asGet && request.body !== null && !whole) throw new TypeError('fetch failed', { cause: new Error('a streamed body cannot be sent again for a redirect') });
      if (asGet) for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
      for (const name of ['x-shadowlap-upstream', 'x-shadowlap-failures', 'x-shadowlap-scope']) headers.delete(name);
      // Off the origin the agent sent it to, its credentials go no further, as fetch's own redirects
      // drop them: an answer that moves the request elsewhere never takes its key or session along.
      if (next.origin !== url.origin) for (const name of ['authorization', 'proxy-authorization', 'cookie']) headers.delete(name);
      // Counted across every hop, as fetch counts them: a loop of redirects ends at the twentieth.
      const followed = await routedFetch(next, /** @type {RequestInit} */ ({ method: asGet ? 'GET' : request.method, headers, body: asGet ? undefined : whole ?? undefined, redirect: request.redirect, signal }), redirects + 1);
      Object.defineProperty(followed, 'redirected', { value: true });
      return followed;
    }
    return toResponse(res, request, url, signal);
  }

  /**
   * What fetch makes of an answer: its headers as sent, its body decoded, and an error in it "terminated".
   * @param {http.IncomingMessage} res
   * @param {Request} request
   * @param {URL} url
   * @param {AbortSignal} signal
   * @returns {Response}
   */
  function toResponse(res, request, url, signal) {
    const headers = new Headers();
    for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(/** @type {string} */ (res.rawHeaders[i]), /** @type {string} */ (res.rawHeaders[i + 1]));
    const status = res.statusCode ?? 502;
    /** @type {ReadableStream | null} */
    let body = null;
    if (request.method === 'HEAD' || status === 204 || status === 205 || status === 304) res.resume();
    else {
      const out = new PassThrough();
      /** @type {NodeJS.ReadableStream[]} */
      const chain = [res, ...decoders(headers.get('content-encoding'))];
      const terminated = (/** @type {unknown} */ cause) => out.destroy(new TypeError('terminated', { cause }));
      for (let i = 0; i < chain.length; i++) {
        const from = /** @type {NodeJS.ReadableStream} */ (chain[i]);
        from.on('error', terminated);
        from.pipe(/** @type {NodeJS.WritableStream} */ (i + 1 < chain.length ? chain[i + 1] : out));
      }
      res.on('close', () => {
        if (!res.complete) terminated(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }));
      });
      const abort = () => {
        out.destroy(signal.reason);
        res.destroy();
      };
      signal.addEventListener('abort', abort, { once: true });
      out.on('close', () => {
        signal.removeEventListener('abort', abort);
        // A body read no further leaves the connection with nothing to wait for.
        if (!res.complete) res.destroy();
      });
      body = /** @type {ReadableStream} */ (Readable.toWeb(out));
    }
    const response = new Response(body, { status, statusText: res.statusMessage ?? '', headers });
    // The URL the agent asked for, as fetch gives it, never the sidecar's with its token.
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  }

  /**
   * The decoders fetch puts a body through for its content-encoding; none for one it doesn't decode.
   * @param {string | null} encoding
   * @returns {import('node:stream').Transform[]}
   */
  function decoders(encoding) {
    const codings = (encoding ?? '').toLowerCase().split(',').map((c) => c.trim()).filter(Boolean).reverse();
    /** @type {import('node:stream').Transform[]} */
    const out = [];
    for (const coding of codings) {
      if (coding === 'gzip' || coding === 'x-gzip') out.push(zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH }));
      else if (coding === 'deflate') out.push(zlib.createInflate({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH }));
      else if (coding === 'br') out.push(zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }));
      else return [];
    }
    return out;
  }

  // ---- http(s).request: the AWS SDK's Node handler, the ws package, and older clients ----
  /**
   * http(s).request's arguments as one URL, its options and its callback.
   * @param {unknown[]} args
   * @returns {{ url: URL; options: RequestOptions; callback: ((res: http.IncomingMessage) => void) | undefined }}
   */
  function normalize(args) {
    /** @type {URL | null} */
    let url = null;
    /** @type {RequestOptions} */
    let options = {};
    /** @type {((res: http.IncomingMessage) => void) | undefined} */
    let callback;
    let i = 0;
    if (typeof args[i] === 'string' || args[i] instanceof URL) url = new URL(/** @type {string | URL} */ (args[i++]));
    if (args[i] && typeof args[i] === 'object') options = /** @type {RequestOptions} */ (args[i++]);
    if (typeof args[i] === 'function') callback = /** @type {(res: http.IncomingMessage) => void} */ (args[i]);
    if (!url) {
      const protocol = options.protocol ?? (typeof options.agent === 'object' ? options.agent.protocol : undefined) ?? null;
      const host = options.hostname ?? options.host ?? 'localhost';
      const port = options.port ? `:${options.port}` : '';
      url = new URL(`${protocol ?? 'http:'}//${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${port}${options.path ?? '/'}`);
    } else if (options.path) {
      url = new URL(options.path, url);
    }
    return { url, options, callback };
  }

  /**
   * A request's headers as an object, from an object or a flat list of names and values.
   * @param {unknown} given
   * @returns {Record<string, unknown>}
   */
  function headerObject(given) {
    if (!Array.isArray(given)) return { .../** @type {Record<string, unknown>} */ (given ?? {}) };
    /** @type {Record<string, unknown>} */
    const out = {};
    for (let i = 0; i + 1 < given.length; i += 2) {
      const name = String(given[i]);
      out[name] = name in out ? /** @type {unknown[]} */ ([]).concat(out[name], given[i + 1]) : given[i + 1];
    }
    return out;
  }

  /**
   * What of a request's options still holds on the way to the sidecar: not the host, the agent or
   * anything TLS (the ws package's own TLS connect among them), which were for the host it named.
   */
  const FOR_THE_HOST = new Set(['agent', 'protocol', 'host', 'hostname', 'port', 'path', 'headers', 'createConnection', 'defaultPort', '_defaultAgent', 'servername', 'ca', 'cert', 'key', 'pfx', 'passphrase', 'rejectUnauthorized', 'checkServerIdentity', 'ALPNProtocols', 'secureContext', 'secureOptions', 'secureProtocol', 'ciphers', 'ecdhCurve', 'minVersion', 'maxVersion', 'session', 'socketPath', 'lookup', 'family', 'hints', 'localAddress', 'localPort']);
  const keptOptions = (/** @type {object} */ options) => Object.fromEntries(Object.entries(options).filter(([k]) => !FOR_THE_HOST.has(k)));

  /**
   * http(s).request, captured: a request for a provider's host, or the sidecar's, goes to the sidecar; any other as it was going.
   * @param {typeof http.request} original
   * @param {string} defaultProtocol
   * @returns {typeof http.request}
   */
  function wrap(original, defaultProtocol) {
    return /** @type {typeof http.request} */ (
      /**
       * @this {unknown}
       * @param {unknown[]} args
       * @returns {http.ClientRequest}
       */
      function capturedRequest(...args) {
      let parsed;
      try {
        parsed = normalize(args);
        if (!args.some((a) => typeof a === 'string' || a instanceof URL) && !parsed.options.protocol) parsed.url.protocol = defaultProtocol;
      } catch {
        return Reflect.apply(original, this, args);
      }
      const provider = providerFor(parsed.url);
      if (!provider && !toSidecar(parsed.url)) return Reflect.apply(original, this, args);
      const { url, options, callback } = parsed;
      const headers = headerObject(options.headers);
      // The sidecar tunnels a model provider's WebSocket and no other: a declared HTTP service's
      // handshake (the ws package's) goes where it was going, as the guard then says.
      if (provider === 'http' && Object.keys(headers).some((k) => k.toLowerCase() === 'upgrade')) return Reflect.apply(original, this, args);
      const scoped = currentScope();
      if (scoped) headers['x-shadowlap-scope'] = scoped;
      if (provider) {
        headers['x-shadowlap-upstream'] = url.origin;
        if (provider === 'http') headers['x-shadowlap-failures'] = 'raise';
      }
      // A client already pointed at the sidecar by its base URL (node-fetch, axios, the ws package)
      // goes there all the same, on the sidecar's agent and as plain HTTP.
      const path = provider ? sidecarPath(provider, url) : `${url.pathname}${url.search}`;
      const req = httpRequest({ ...keptOptions(options), protocol: 'http:', hostname: sidecar.hostname, port: sidecar.port, path, headers: /** @type {http.OutgoingHttpHeaders} */ (headers), agent: sidecarAgent }, callback);
      return provider === 'http' ? failOnInjected(req) : req;
      }
    );
  }

  http.request = wrap(httpRequest, 'http:');
  https.request = wrap(httpsRequest, 'https:');
  http.get = /** @type {typeof http.get} */ (
    /** @param {unknown[]} args */
    function capturedGet(...args) {
      const req = /** @type {http.ClientRequest} */ (Reflect.apply(http.request, http, args));
      req.end();
      return req;
    }
  );
  https.get = /** @type {typeof https.get} */ (
    /** @param {unknown[]} args */
    function capturedGet(...args) {
      const req = /** @type {http.ClientRequest} */ (Reflect.apply(https.request, https, args));
      req.end();
      return req;
    }
  );

  // ---- WebSocket: Node's own, as the OpenAI SDK's Realtime client opens it ----
  // A client whose base URL is the sidecar makes a `wss://` URL of it, for a sidecar that speaks no
  // TLS: it opens as `ws://`. One for a model provider's host opens on the sidecar's route for it,
  // the host named in x-shadowlap-upstream, as a captured HTTP call does. The sidecar tunnels no
  // other, so one for a declared HTTP service goes where it was going.
  const NativeWebSocket = globalThis.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    globalThis.WebSocket = class WebSocket extends NativeWebSocket {
      /**
       * @param {string | URL} address
       * @param {ConstructorParameters<typeof NativeWebSocket>[1]} [protocols]
       */
      constructor(address, protocols) {
        const url = parseUrl(address instanceof URL ? address.href : String(address));
        const asHttp = url && (url.protocol === 'wss:' || url.protocol === 'ws:') ? new URL(`${url.protocol === 'wss:' ? 'https:' : 'http:'}${url.href.slice(url.protocol.length)}`) : null;
        const found = asHttp ? providerFor(asHttp) : null;
        const provider = found === 'http' ? null : found;
        if (url && toSidecar(url) && url.protocol === 'wss:') {
          url.protocol = 'ws:';
          super(url.href, protocols);
        } else if (provider && asHttp) {
          const headers = { 'x-shadowlap-upstream': asHttp.origin, ...(currentScope() ? { 'x-shadowlap-scope': currentScope() } : {}) };
          const options = protocols !== null && typeof protocols === 'object' && !Array.isArray(protocols) ? protocols : null;
          // A client's own headers, as an object: Node's WebSocket takes them so beside the protocols.
          const own = /** @type {Record<string, string>} */ (options?.headers ?? {});
          const init = options ? { ...options, headers: { ...own, ...headers } } : { protocols: protocols ?? [], headers };
          super(`ws://${sidecar.host}${sidecarPath(provider, asHttp)}`, /** @type {ConstructorParameters<typeof NativeWebSocket>[1]} */ (init));
        } else super(address, protocols);
      }
    };
  }

  // ---- http2.connect: the AWS SDK's Bedrock runtime client speaks only HTTP/2 ----
  const http2Url = process.env.SHADOWLAP_HTTP2_URL ? new URL(process.env.SHADOWLAP_HTTP2_URL) : null;
  const originalConnect = http2.connect;
  // Raw headers, as http2 also takes a request's: [name, value, name, value, ...].
  /** @type {(headers: unknown) => headers is readonly string[]} */
  const isRawHeaders = (headers) => Array.isArray(headers);
  const rawHeader = (/** @type {readonly string[]} */ raw, /** @type {string} */ name) => {
    for (let i = 0; i + 1 < raw.length; i += 2) if (String(raw[i]).toLowerCase() === name) return raw[i + 1];
    return undefined;
  };
  const rawHeadersWithout = (/** @type {readonly string[]} */ raw, /** @type {string[]} */ names) => {
    /** @type {string[]} */
    const kept = [];
    for (let i = 0; i + 1 < raw.length; i += 2) if (!names.includes(String(raw[i]).toLowerCase())) kept.push(String(raw[i]), String(raw[i + 1]));
    return kept;
  };
  http2.connect = /** @type {typeof http2.connect} */ (
    /**
     * @this {unknown}
     * @param {string | URL | { protocol?: string; hostname?: string; host?: string; port?: number | string }} authority
     * @param {(http2.SecureClientSessionOptions & Record<string, unknown>) | ((session: http2.ClientHttp2Session) => void)} [options]
     * @param {(session: http2.ClientHttp2Session) => void} [listener]
     * @returns {http2.ClientHttp2Session}
     */
    function capturedConnect(authority, options, listener) {
    let url;
    try {
      url = new URL(typeof authority === 'string' || authority instanceof URL ? authority : `${authority.protocol ?? 'https:'}//${String(authority.hostname ?? authority.host)}${authority.port ? `:${authority.port}` : ''}`);
    } catch {
      return /** @type {http2.ClientHttp2Session} */ (Reflect.apply(originalConnect, this, arguments));
    }
    const provider = http2Url ? providerFor(url) : null;
    if (!http2Url || !provider) return /** @type {http2.ClientHttp2Session} */ (Reflect.apply(originalConnect, this, arguments));
    if (typeof options === 'function') {
      listener = options;
      options = undefined;
    }
    // TLS settings for the real host mean nothing to the sidecar's cleartext listener.
    const { ALPNProtocols: _alpn, servername: _servername, createConnection: _createConnection, ca: _ca, rejectUnauthorized: _reject, ...rest } = options ?? {};
    const session = /** @type {http2.ClientHttp2Session} */ (Reflect.apply(originalConnect, this, [http2Url.origin, rest, listener]));
    const request = session.request;
    session.request = /** @type {typeof request} */ (
      /**
       * @this {http2.ClientHttp2Session}
       * @param {http2.OutgoingHttpHeaders | readonly string[]} [headers]
       * @param {http2.ClientSessionRequestOptions} [streamOptions]
       */
      function capturedStream(headers = {}, streamOptions) {
      // A raw list keeps its order and repeats, with the sidecar's headers in place of its own of the
      // same names; spread into an object, it would become numbered keys and lose its method and path.
      const raw = isRawHeaders(headers);
      const target = new URL(String((raw ? rawHeader(headers, ':path') : headers[':path']) ?? '/'), url);
      const sidecarHeaders = { ...(currentScope() ? { 'x-shadowlap-scope': currentScope() } : {}), ':scheme': 'http', ':path': `${http2Url.pathname.replace(/\/$/, '')}${runSegment}/${provider}${target.pathname}${target.search}`, 'x-shadowlap-upstream': url.origin };
      const redirected = raw ? [...rawHeadersWithout(headers, Object.keys(sidecarHeaders)), ...Object.entries(sidecarHeaders).flat()] : { ...headers, ...sidecarHeaders };
      return Reflect.apply(request, this, [redirected, streamOptions]);
      }
    );
    return session;
    }
  );

  // ES modules that `import { request } from 'node:https'` (the AWS SDK's ESM build) see the patch only after this.
  syncBuiltinESMExports();
}
