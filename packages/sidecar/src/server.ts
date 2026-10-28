import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttp2Server, type Http2Server, type ServerHttp2Session } from 'node:http2';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { JudgeSummary, RunMeta, RunRecord, RunStatus } from '@shadowlap/engine';
import { breakConnection, HttpError } from './answers.js';
import { handleApi } from './api.js';
import { proxyHttp } from './capture.js';
import { SidecarCore, type SidecarOptions } from './core.js';
import { matchHttpRule, type HttpRule } from './http.js';
import { closeForJudge, endRun, endWritten, envFor, envForSlot, expectPreloads, openForJudge, startRun, updateRunMeta, type EndRunResult, type StartRunInput } from './lifecycle.js';
import { proxy } from './model-calls.js';
import { carriesPlaceholder, placeholderRefusal } from './placeholders.js';
import type { GuardMode } from './preloads.js';
import { bareHost, decodedSegment, forwardedHeaders, headerValue, lowerHeaders } from './requests.js';
import { refuseUpgrade, tunnelWebSocket } from './websocket.js';

export type { Interventions } from './interventions.js';
export { requestUpstream } from './upstream.js';
export { HttpError } from './answers.js';
export type { ApiRoute, SidecarOptions } from './core.js';
export type { EndRunResult, StartRunInput, WebSocketUse } from './lifecycle.js';
export type { CompleteBody, ResolveBody, ResolveResponse } from './tool-calls.js';

/**
 * The sidecar: a loopback HTTP server that proxies model APIs with record/replay,
 * and resolves tool, clock and random calls for the SDKs. One instance serves one session; a session
 * has one active run at a time, and a request may pin another with `x-shadowlap-run`.
 *
 * This class holds the servers and routes each request; what it does with one is in the modules the
 * sidecar is made of, which share its state through one SidecarCore (core.ts): a run's start and end
 * (lifecycle.ts), the API under /v1/ (api.ts), model calls (model-calls.ts, model-answers.ts), the
 * declared HTTP hosts (capture.ts), the SDKs' tool, clock and random calls (tool-calls.ts) and a
 * parent's calls as a replay matches them (replay-index.ts).
 */
export class Sidecar {
  readonly url: string;
  readonly token: string;
  /** HTTP hosts recorded as tools. */
  readonly httpRules: readonly HttpRule[];
  /**
   * What a judge call carries (`x-shadowlap-judge`) besides the session token: a secret this process
   * alone knows, never in an agent's environment, so no call of the agent's can claim the judge's
   * scope, which replay strictness leaves out.
   */
  readonly judgeToken: string;
  /**
   * The same API over cleartext HTTP/2, for clients that only speak HTTP/2: the AWS SDK's Bedrock
   * runtime client opens every connection with http2.connect. In-process capture redirects those here.
   */
  readonly http2Url: string;
  /** What the modules that handle a request share: the settings, the store and its writer, the runs open. */
  private readonly core: SidecarCore;
  private readonly server: Server;
  private readonly http2Server: Http2Server;
  private readonly http2Sessions = new Set<ServerHttp2Session>();
  /** Takes the writer off the store's queues (Store.queueWrites), once it has made what it holds. */
  private readonly unqueue: () => void;
  /** WebSockets tunnelled and still open: an agent's connections, ended when the sidecar closes. */
  private readonly tunnels = new Set<Duplex>();
  /** The address the server listens on, lower case and without brackets, which a request may name in its Host as a loopback name would be. */
  private readonly listening: string;

  private constructor(opts: SidecarOptions, server: Server, url: string, token: string, http2Server: Http2Server, http2Url: string) {
    this.core = new SidecarCore(opts, url, http2Url);
    this.listening = bareHost(opts.host ?? '127.0.0.1');
    this.server = server;
    this.http2Server = http2Server;
    this.http2Url = http2Url;
    this.url = url;
    this.token = token;
    this.httpRules = this.core.httpRules;
    this.judgeToken = this.core.judgeToken;
    // A read or change of a run in this process makes what the writer holds of it first.
    this.unqueue = opts.store.queueWrites(this.core.writer);
  }

  static async start(opts: SidecarOptions): Promise<Sidecar> {
    const host = opts.host ?? '127.0.0.1';
    const token = randomBytes(16).toString('hex');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port ?? 0, host, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    const http2Server = createHttp2Server();
    await new Promise<void>((resolve, reject) => {
      http2Server.once('error', reject);
      http2Server.listen(0, host, () => resolve());
    });
    const http2Port = (http2Server.address() as AddressInfo).port;
    const sidecar = new Sidecar(opts, server, `http://${host}:${port}/t/${token}`, token, http2Server, `http://${host}:${http2Port}/t/${token}`);
    http2Server.on('session', (session) => {
      sidecar.http2Sessions.add(session);
      session.on('close', () => sidecar.http2Sessions.delete(session));
    });
    // The HTTP/2 compatibility API gives request and response objects the HTTP/1 handler understands.
    http2Server.on('request', (req, res) => server.emit('request', req as unknown as IncomingMessage, res as unknown as ServerResponse));
    server.on('request', (req, res) => {
      sidecar
        .handle(req, res)
        .catch((err: unknown) => {
          const status = err instanceof HttpError ? err.status : 500;
          const message = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'shadowlap_error', message } }));
          } else {
            breakConnection(res, message);
          }
          sidecar.core.log(`error: ${message}`);
        })
        // The call is answered: a divergence it made is compared with the recording now, off its path.
        .finally(() => sidecar.core.explainWaiting());
    });
    // A WebSocket under a provider (OpenAI Realtime), tunnelled to it.
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => sidecar.upgrade(req, socket, head));
    return sidecar;
  }

  async close(): Promise<void> {
    for (const session of this.core.upstreamHttp2.values()) session.destroy();
    for (const session of this.http2Sessions) session.destroy();
    for (const socket of this.tunnels) socket.destroy();
    await Promise.all([new Promise<void>((resolve) => this.server.close(() => resolve())), new Promise<void>((resolve) => this.http2Server.close(() => resolve()))]);
    this.server.closeAllConnections?.();
    // What the calls answered so far is written before the store may close.
    this.core.writer.stop();
    this.unqueue();
    // The servers close once every agent still connected has had its answer, so a request still
    // upstream now is one whose agent left before its answer came (stopped by Ctrl-C mid-call):
    // nobody is left to read it, and a slow model would keep this process running after it is done.
    // Nothing more of it is recorded (`closed`), nor of a body still being stored for one.
    this.core.closed = true;
    for (const req of this.core.upstreamRequests) req.destroy();
    await this.core.bodies.close();
  }

  /** The environment for a process whose calls belong to `runId`, or to whichever run started last (lifecycle.ts). */
  envFor(runId?: string): Record<string, string> {
    return envFor(this.core, runId);
  }

  /** The environment for processes whose runs take a slot over in turn (`startRun({ slot })`, lifecycle.ts). */
  envForSlot(slot: string): Record<string, string> {
    return envForSlot(this.core, slot);
  }

  /** Starts a run, its record written through the store writer (lifecycle.ts). */
  startRun(input: StartRunInput): RunRecord {
    return startRun(this.core, input);
  }

  /** Opens an ended run again for its judge's calls alone (lifecycle.ts). */
  openForJudge(runId: string): void {
    openForJudge(this.core, runId);
  }

  /** Closes a run openForJudge opened: what the judge's calls made through it did and cost (lifecycle.ts). */
  closeForJudge(runId: string): JudgeSummary | null {
    return closeForJudge(this.core, runId);
  }

  /** Says the CLI starts this run's agent with Shadowlap's preloads, under `guard` (lifecycle.ts). */
  expectPreloads(runId: string, guard: GuardMode, accept: readonly string[] = []): void {
    expectPreloads(this.core, runId, guard, accept);
  }

  /** Keeps `patch` on a run's metadata, through the store writer for a run this sidecar has open (lifecycle.ts). */
  updateRunMeta(runId: string, patch: Partial<RunMeta>): void {
    updateRunMeta(this.core, runId, patch);
  }

  /**
   * Resolves once every write this sidecar queued for the run (or, without one, for any run) has been
   * made or given up, waiting on the store writer's timer, never on the thread the agents' answers
   * stream on. A caller that waits for it before reading the run never waits on the thread for
   * another process's lock (endRun reads nothing from the store).
   */
  settled(runId?: string): Promise<void> {
    return this.core.writer.settled(runId);
  }

  /** Waits for a run this sidecar ended to be written, and gives what could not be (lifecycle.ts). */
  endWritten(runId: string): Promise<string[]> {
    return endWritten(this.core, runId);
  }

  /** Ends a run: its summary from its calls as this process kept them (lifecycle.ts). */
  endRun(runId: string, status: Exclude<RunStatus, 'running'>): EndRunResult {
    return endRun(this.core, runId, status);
  }

  get activeRun(): RunRecord | null {
    return this.core.activeRunId ? (this.core.runs.get(this.core.activeRunId)?.run ?? null) : null;
  }

  // ---- HTTP ----

  /** Where a request under the session token goes: the path after the token and any pin, and the run a pin names. */
  private routeOf(rawUrl: string | undefined): { url: URL; rest: string; pinned: string | undefined } {
    const url = new URL(rawUrl ?? '/', 'http://sidecar');
    const prefix = `/t/${this.token}/`;
    if (!url.pathname.startsWith(prefix)) throw new HttpError(404, 'not found');
    let rest = url.pathname.slice(prefix.length);
    // /r/<runId>/… pins the request to a run, as the base URLs from envFor do; /s/<slot>/… to the
    // run that holds the slot now, as the base URLs from envForSlot do.
    let pinned: string | undefined;
    const pin = /^([rs])\/([^/]+)\/(.*)$/.exec(rest);
    if (pin) {
      const id = decodeURIComponent(pin[2]!);
      rest = pin[3]!;
      if (pin[1] === 'r') pinned = id;
      else {
        pinned = this.core.slots.get(id);
        if (!pinned) throw new HttpError(409, `no run holds slot ${id}: a call arrived outside a recorded test`);
      }
    }
    return { url, rest, pinned };
  }

  /**
   * DNS rebinding: a page in a browser on some other name that resolves to 127.0.0.1 must get
   * nothing here, token or no token, as the dashboard refuses it. A browser names the host it thinks
   * it reaches in `Host` and can't change it, so a request must name this server by a loopback name
   * or address, or be one in-process capture redirected here: that keeps the Host of the host it was
   * for (Python's httpx does) and names the same host in `x-shadowlap-upstream`, which must be a host
   * this sidecar captures (a provider's, a declared format host or HTTP host). A request without a
   * Host is no browser's, and HTTP/2 here is cleartext, which no browser speaks (AWS clients'
   * capture uses it).
   */
  private refuseForeignHost(req: IncomingMessage): void {
    if (req.httpVersionMajor >= 2) return;
    const raw = req.headers.host;
    if (raw === undefined) return;
    let named: string;
    try {
      named = bareHost(new URL(`http://${raw}`).hostname);
    } catch {
      throw new HttpError(403, 'shadowlap answers requests to its loopback address only');
    }
    if (named === 'localhost' || named === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(named) || named === this.listening) return;
    let upstream: URL | null = null;
    try {
      upstream = new URL(headerValue(req, 'x-shadowlap-upstream') ?? '');
    } catch {
      // names no host it was redirected from
    }
    const captured = upstream !== null && bareHost(upstream.hostname) === named && (matchHttpRule(this.core.httpRules, upstream) !== undefined || [...this.core.byId.values()].some((p) => p.accepts?.(upstream) ?? p.hosts.test(upstream.hostname)));
    if (!captured) throw new HttpError(403, `shadowlap answers requests to its loopback address only, not to ${named}`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.refuseForeignHost(req);
    const { url, rest, pinned } = this.routeOf(req.url);
    const head = rest.split('/', 1)[0] ?? '';

    if (head === 'v1') return handleApi(this.core, req, res, rest, url, pinned);
    if (head === 'http') return proxyHttp(this.core, req, res, rest.slice(head.length) || '/', url.search, pinned);
    // A declared host's route (`*.example.com`) as a client may have percent-encoded it.
    const route = head ? (this.core.providers.get(head) ?? this.core.providers.get(decodedSegment(head))) : undefined;
    if (!route) throw new HttpError(404, `unknown route ${rest}`);
    const sent = rest.slice(head.length) || '/';
    // A host that serves another wire format under part of its paths (Claude on Foundry, under Azure's).
    const provider = route.forPath?.(sent) ?? route;
    return proxy(this.core, req, res, provider, provider.apiPath?.(sent) ?? sent, url.search, pinned);
  }

  /**
   * A WebSocket under a provider's prefix (OpenAI Realtime, `…/openai/v1/realtime`), tunnelled to the
   * provider as an HTTP call is forwarded: to the upstream configured here (a mock, through
   * SHADOWLAP_UPSTREAM_<PROVIDER>), else to the host a captured request names when its provider
   * vouches for it, else to the provider's own. Nothing that goes over it is recorded, so the run's
   * summary names it; an offline replay refuses it, saying why in one line.
   */
  private upgrade(req: IncomingMessage, socket: Duplex, early: Buffer): void {
    socket.on('error', () => {});
    try {
      this.refuseForeignHost(req);
      const { url, rest, pinned } = this.routeOf(req.url);
      const head = rest.split('/', 1)[0] ?? '';
      const provider = head ? this.core.providers.get(head) : undefined;
      if (!provider) throw new HttpError(404, `unknown route ${rest}`);
      if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') throw new HttpError(400, `shadowlap tunnels WebSocket upgrades only; send this request without "Upgrade: ${String(req.headers.upgrade ?? '')}"`);
      const ctx = this.core.contextFor(req, pinned);
      if (ctx.judgeOnly) throw new HttpError(409, `run ${ctx.run.runId} has ended; it is open for its judge's calls only`);
      const sent = rest.slice(head.length) || '/';
      const path = provider.apiPath?.(sent) ?? sent;
      const target = `${provider.id} ${path}`;
      const note = (action: 'tunnelled' | 'refused') => {
        const seen = ctx.websockets.get(target);
        ctx.websockets.set(target, { count: (seen?.count ?? 0) + 1, action: seen?.action === 'tunnelled' ? 'tunnelled' : action });
      };
      if (ctx.offline || this.core.upstreams[provider.id] === 'offline') {
        note('refused');
        return refuseUpgrade(socket, 503, `shadowlap is offline: the WebSocket ${target} would need the network, and a recording holds no WebSocket to answer it from`);
      }
      const requested = this.core.requestedUpstream(req, provider, ctx, true);
      const upstream = (this.core.upstreams[provider.id] || requested || provider.upstream).replace(/\/$/, '');
      if (!upstream) throw new HttpError(400, `no upstream for ${provider.id}: set SHADOWLAP_UPSTREAM_${provider.id.toUpperCase()}, or let Shadowlap capture the connection in the agent's process`);
      const headers = lowerHeaders(req.headers);
      if (carriesPlaceholder(headers, url.search)) throw new HttpError(401, placeholderRefusal(provider.keys?.set ?? `a key for ${provider.id}`, `the WebSocket ${target}`));
      const forward = forwardedHeaders(headers, true);
      note('tunnelled');
      this.core.log(`run ${ctx.run.runId}: WebSocket ${target} tunnelled, not recorded`);
      this.tunnels.add(socket);
      socket.once('close', () => this.tunnels.delete(socket));
      tunnelWebSocket(socket, early, new URL(`${upstream}${this.core.upstreamPath(provider, upstream, path)}${url.search}`), forward);
    } catch (err) {
      refuseUpgrade(socket, err instanceof HttpError ? err.status : 500, err instanceof Error ? err.message : String(err));
    }
  }
}
