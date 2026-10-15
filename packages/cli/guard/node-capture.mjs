// Shadowlap in-process capture for Node agents. Preloaded with the network guard (NODE_OPTIONS=--import).
//
// Most model clients read a base URL from the environment, and `shadowlap run` points those at the
// sidecar. Some can't be pointed anywhere: Bedrock clients sign each request for its host (a base
// URL would break the signature), Azure and Vertex clients often take their endpoint or region in
// code, and any client may hardcode its base URL. For those, this module sends the request itself,
// byte for byte with every signed header, to the sidecar, and names the host it was going to in
// `x-shadowlap-upstream`. The sidecar records it and forwards it to that host (only hosts a provider
// declares), or serves it from the recording on replay.
//
// Routes arrive in SHADOWLAP_CAPTURE as JSON: { "routes": [[hostRegex, providerId], ...],
// "hosts": { "host:port": providerId }, "http": [[hostRegex, port | null], ...] }. The last are HTTP
// hosts the user declared, recorded as tools; they go to the sidecar's `http` route over either
// scheme. SHADOWLAP_CAPTURE=off disables capture.
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const sidecarUrl = process.env.SHADOWLAP_URL;
const runId = process.env.SHADOWLAP_RUN_ID;
const config = process.env.SHADOWLAP_CAPTURE;

// Without a run id (a test worker whose runs change from test to test), SHADOWLAP_URL names a slot
// and the sidecar resolves the run.
if (sidecarUrl && config && config !== 'off' && !globalThis.__shadowlapCapture) {
  globalThis.__shadowlapCapture = true;
  let routes = [];
  let exactHosts = {};
  let httpHosts = [];
  try {
    const parsed = JSON.parse(config);
    routes = (parsed.routes ?? []).map(([source, provider]) => [new RegExp(source), provider]);
    exactHosts = parsed.hosts ?? {};
    httpHosts = (parsed.http ?? []).map(([source, port]) => [new RegExp(source), port]);
  } catch {
    process.stderr.write('[shadowlap] SHADOWLAP_CAPTURE is not valid JSON; in-process capture is off\n');
  }
  const sidecar = new URL(sidecarUrl);
  const sidecarKey = `${sidecar.hostname}:${sidecar.port}`;

  // `shadowlap run` points OPENAI_BASE_URL at the sidecar, and agents rely on that, often through
  // `process.env.OPENAI_BASE_URL ?? '<their default>'`. The OpenAI SDK's AzureOpenAI takes its baseURL
  // default from the same variable, though, and throws when it also gets an endpoint. So the Azure
  // constructor alone sees the value the user had; its endpoint's host is captured here.
  if ('SHADOWLAP_OPENAI_BASE_URL_WAS' in process.env) {
    const was = process.env.SHADOWLAP_OPENAI_BASE_URL_WAS || undefined;
    const env = process.env;
    const insideAzureClient = () => {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 30;
      try {
        return /\bnew AzureOpenAI\b/.test(String(new Error().stack));
      } finally {
        Error.stackTraceLimit = limit;
      }
    };
    process.env = new Proxy(env, {
      get: (target, key) => (key === 'OPENAI_BASE_URL' && insideAzureClient() ? was : Reflect.get(target, key)),
    });
  }

  /** The provider a URL belongs to, or null to leave the request alone. */
  function providerFor(url) {
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const key = `${url.hostname}:${port}`;
    if (key === sidecarKey) return null;
    if (exactHosts[key]) return exactHosts[key];
    if (url.protocol === 'https:') for (const [re, provider] of routes) if (re.test(url.hostname)) return provider;
    if (url.protocol === 'http:' || url.protocol === 'https:') for (const [re, p] of httpHosts) if (re.test(url.hostname.toLowerCase()) && (p === null || p === port)) return 'http';
    return null;
  }

  const runSegment = runId ? `/r/${encodeURIComponent(runId)}` : '';
  // The SDK's scope() (see @shadowlap/sdk): the store is shared through a global symbol.
  const currentScope = () => globalThis[Symbol.for('shadowlap.scope')]?.getStore?.();

  function sidecarPath(provider, url) {
    return `${sidecar.pathname.replace(/\/$/, '')}${runSegment}/${provider}${url.pathname}${url.search}`;
  }

  // A replay can fail a captured HTTP call with a timeout or an error (--fail-at <call>=timeout). The
  // sidecar answers a request that says it can take one (x-shadowlap-failures: raise) by naming the
  // failure, and the agent gets the error its HTTP client raises for the real thing: its error path runs.
  const decodeMessage = (value) => {
    if (typeof value !== 'string' || !value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  /** The error a connection reset reaches a Node client with: `read ECONNRESET`, or the message --fail-at gave. */
  const resetError = (message) => Object.assign(new Error(message ?? 'read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' });

  /** fetch: a timeout rejects as AbortSignal.timeout() makes it; an error as undici's "fetch failed". */
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
   */
  function failOnInjected(req) {
    const emit = req.emit;
    req.emit = function (event, ...args) {
      const res = event === 'response' ? args[0] : undefined;
      const kind = res?.headers?.['x-shadowlap-injected'];
      if (!kind) return emit.call(this, event, ...args);
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

  // ---- fetch: the Anthropic, OpenAI and Google SDKs, and the Anthropic Bedrock and Vertex clients ----
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function capturedFetch(input, init) {
      let url;
      try {
        url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      } catch {
        return originalFetch(input, init);
      }
      const provider = providerFor(url);
      const scoped = currentScope();
      if (!provider) {
        // A client already pointed at the sidecar by its base URL: only the scope needs adding.
        if (!scoped || `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}` !== sidecarKey) return originalFetch(input, init);
        const headers = new Headers(init?.headers ?? (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined));
        headers.set('x-shadowlap-scope', scoped);
        if (typeof input === 'object' && !(input instanceof URL)) return originalFetch(new Request(input, { ...init, headers }));
        return originalFetch(input, { ...init, headers });
      }
      const request = typeof input === 'object' && !(input instanceof URL) ? input : null;
      const headers = new Headers(init?.headers ?? request?.headers ?? undefined);
      headers.set('x-shadowlap-upstream', url.origin);
      if (scoped) headers.set('x-shadowlap-scope', scoped);
      if (provider === 'http') headers.set('x-shadowlap-failures', 'raise');
      const target = `${sidecar.origin}${sidecarPath(provider, url)}`;
      const method = init?.method ?? request?.method ?? 'GET';
      const body = init?.body !== undefined ? init.body : request?.body ?? undefined;
      const sent = originalFetch(target, {
        method,
        headers,
        ...(body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD' ? { body, duplex: 'half' } : {}),
        ...(init?.signal ?? request?.signal ? { signal: init?.signal ?? request?.signal } : {}),
        redirect: init?.redirect ?? request?.redirect ?? 'follow',
      });
      return provider === 'http' ? sent.then(failedFetch) : sent;
    };
  }

  // ---- http(s).request: the AWS SDK's Node handler, and older clients ----
  function normalize(args) {
    let url = null;
    let options = {};
    let callback;
    let i = 0;
    if (typeof args[i] === 'string' || args[i] instanceof URL) url = new URL(args[i++]);
    if (args[i] && typeof args[i] === 'object') options = args[i++];
    if (typeof args[i] === 'function') callback = args[i];
    if (!url) {
      const protocol = options.protocol ?? (options.agent?.protocol) ?? null;
      const host = options.hostname ?? options.host ?? 'localhost';
      const port = options.port ? `:${options.port}` : '';
      url = new URL(`${protocol ?? 'http:'}//${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${port}${options.path ?? '/'}`);
    } else if (options.path) {
      url = new URL(options.path, url);
    }
    return { url, options, callback };
  }

  function wrap(original, defaultProtocol) {
    return function capturedRequest(...args) {
      let parsed;
      try {
        parsed = normalize(args);
        if (!args.some((a) => typeof a === 'string' || a instanceof URL) && !parsed.options.protocol) parsed.url.protocol = defaultProtocol;
      } catch {
        return original.apply(this, args);
      }
      const provider = providerFor(parsed.url);
      if (!provider) return original.apply(this, args);
      const { url, options, callback } = parsed;
      const headers = { ...(options.headers ?? {}) };
      headers['x-shadowlap-upstream'] = url.origin;
      if (currentScope()) headers['x-shadowlap-scope'] = currentScope();
      if (provider === 'http') headers['x-shadowlap-failures'] = 'raise';
      const { agent: _agent, protocol: _protocol, host: _host, hostname: _hostname, port: _port, path: _path, servername: _servername, ...rest } = options;
      const req = http.request(
        { ...rest, protocol: sidecar.protocol, hostname: sidecar.hostname, port: sidecar.port, path: sidecarPath(provider, url), headers },
        callback,
      );
      return provider === 'http' ? failOnInjected(req) : req;
    };
  }

  const httpRequest = http.request;
  const httpsRequest = https.request;
  http.request = wrap(httpRequest, 'http:');
  https.request = wrap(httpsRequest, 'https:');
  http.get = function capturedGet(...args) {
    const req = http.request(...args);
    req.end();
    return req;
  };
  https.get = function capturedGet(...args) {
    const req = https.request(...args);
    req.end();
    return req;
  };
  // ---- http2.connect: the AWS SDK's Bedrock runtime client speaks only HTTP/2 ----
  const http2Url = process.env.SHADOWLAP_HTTP2_URL ? new URL(process.env.SHADOWLAP_HTTP2_URL) : null;
  const originalConnect = http2.connect;
  http2.connect = function capturedConnect(authority, options, listener) {
    let url;
    try {
      url = new URL(typeof authority === 'string' || authority instanceof URL ? authority : `${authority.protocol ?? 'https:'}//${authority.hostname ?? authority.host}${authority.port ? `:${authority.port}` : ''}`);
    } catch {
      return originalConnect.apply(this, arguments);
    }
    const provider = http2Url ? providerFor(url) : null;
    if (!provider) return originalConnect.apply(this, arguments);
    if (typeof options === 'function') {
      listener = options;
      options = undefined;
    }
    // TLS settings for the real host mean nothing to the sidecar's cleartext listener.
    const { ALPNProtocols: _alpn, servername: _servername, createConnection: _createConnection, ca: _ca, rejectUnauthorized: _reject, ...rest } = options ?? {};
    const session = originalConnect.call(this, http2Url.origin, rest, listener);
    const request = session.request;
    session.request = function capturedStream(headers = {}, streamOptions) {
      const target = new URL(headers[':path'] ?? '/', url);
      const redirected = { ...headers, ...(currentScope() ? { 'x-shadowlap-scope': currentScope() } : {}), ':scheme': 'http', ':path': `${http2Url.pathname.replace(/\/$/, '')}${runSegment}/${provider}${target.pathname}${target.search}`, 'x-shadowlap-upstream': url.origin };
      return request.call(this, redirected, streamOptions);
    };
    return session;
  };

  // ES modules that `import { request } from 'node:https'` (the AWS SDK's ESM build) see the patch only after this.
  syncBuiltinESMExports();
}
