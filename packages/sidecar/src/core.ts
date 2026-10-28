/**
 * What the sidecar's parts share: its settings, the store and the writer every write of a run goes
 * through, the runs it has open and the slots that name them, the connections it holds upstream, and
 * the steps every kind of call takes, whichever module handles it: finding its run and its scope,
 * where it goes upstream, recording an attempt's end, keeping where a run diverged, and saying what
 * could not be written. Sidecar (server.ts) holds one, and passes it to the modules that handle a
 * request: the run's start and end (lifecycle.ts), the API under /v1/ (api.ts), model calls
 * (model-calls.ts, model-answers.ts), declared HTTP hosts (capture.ts), the SDKs' tool, clock and
 * random calls (tool-calls.ts) and the parent's calls as a replay matches them (replay-index.ts).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { connect as connectHttp2, type ClientHttp2Session } from 'node:http2';
import { JUDGE_SCOPE, messageOf, parseJsonExact, RESERVED_SCOPE_PREFIX, unmaskedHints, type CallEndRow, type CallMeta, type CallStartRow, type ClockMode, type DivergenceReport, type Normalizer, type Price, type Store, type ToolTrust } from '@shadowlap/engine';
import { HttpError } from './answers.js';
import { BodyThreads } from './body-threads.js';
import type { HttpRule } from './http.js';
import { activeProviders, formatHostProvider, hostedProviders, providers as defaultProviders, sdkBasesFromEnvironment, type FormatHost, type Provider } from './providers.js';
import { decodeHeader, headerValue, scopeOf } from './requests.js';
import type { CallIdentity, RunContext } from './run-context.js';
import { credentialsFromEnvironment, type CredentialsFor } from './sigv4.js';
import { asResponse } from './upstream.js';
import { StoreWriter, type StoreWrites } from './writer.js';

export interface SidecarOptions {
  store: Store;
  host?: string;
  port?: number;
  providers?: Provider[];
  /**
   * Hosts of another provider's wire format to serve besides the built-in providers (`providers` in
   * shadowlap.config.json). Defaults to those the config declared (declareFormatHosts).
   */
  formats?: FormatHost[];
  normalizers?: Normalizer[];
  /** Per-provider upstream overrides, e.g. `{ anthropic: 'http://127.0.0.1:9999' }` for a mock. */
  upstreams?: Record<string, string>;
  /**
   * A provider's SDK base URL from before Shadowlap that is no root with the provider's SDK path
   * under it (`OPENAI_BASE_URL=https://models.github.ai/inference`). While it is also that provider's
   * upstream, a request is forwarded under it without the SDK path the agent's base URL adds:
   * `/v1/chat/completions` goes to `<base>/chat/completions`. Calls keep their names (`POST
   * /v1/chat/completions`), so a recording replays the same wherever its server was. Defaults to the
   * environment's (`sdkBasesFromEnvironment`).
   */
  sdkBases?: Record<string, string>;
  /** Cost estimates in summaries: USD per million tokens by model prefix, on top of the built-in table. */
  prices?: Record<string, Price>;
  /** `auto` (default): dates and timestamps near each run's start match whatever day the run happens on. `exact`: they must be equal. */
  clock?: ClockMode;
  /** HTTP hosts recorded as tools (see http.ts). The sidecar forwards captured HTTP calls only to these. */
  http?: HttpRule[];
  /**
   * The config's `tools`: each tool's trust, by its name or a captured HTTP call's host. Stamped on
   * every call of such a tool as it is made (`meta.trust`, `meta.trustFrom: 'config'`), so the run
   * keeps it wherever it is opened later; it never enters a fingerprint.
   */
  trust?: ToolTrust;
  log?: (line: string) => void;
  /**
   * More routes under `/v1/`, behind the same session token: a host that manages runs for other
   * processes (the test-suite recordings API) adds its endpoints here. Return undefined to fall
   * through to "unknown route".
   */
  api?: (route: ApiRoute) => Promise<{ status: number; body: unknown } | undefined>;
  /**
   * Credentials for signing a Bedrock request again after an intervention changed it, by the access
   * key the agent signed with. Defaults to the environment and the shared AWS files (sigv4.ts).
   */
  awsCredentials?: CredentialsFor;
  /**
   * How long the calls' writes wait for a store another process holds (writer.ts): at most `waitMs`
   * (50) at a time, on the thread the answers stream on, and `deadlineMs` (10,000) in all, retried
   * on a timer, before a write counts as failed.
   */
  storeWrites?: StoreWrites;
}

export interface ApiRoute {
  method: string;
  /** The path after the token, e.g. `v1/recordings/start`. */
  path: string;
  body: () => Promise<unknown>;
}

/** How many ended runs' late store trouble is kept for endWritten: a caller that never asks leaves no more than these. */
const LATE_RUNS = 256;

/**
 * What a judge's call asked for, besides its scope: `offline`, to be answered from the recording or
 * not at all, when there is no way to ask the judge live; and the check it answers, kept on the call
 * (`CallMeta.judge`).
 */
export interface JudgeAccess {
  offline: boolean;
  /** Where to ask the judge live, when it may be: its provider's upstream as the environment names it, or the provider's own. */
  upstream?: string;
  meta?: { check: string; ask: string; v?: number };
}

/** An attempt's end as it is recorded: the answer the agent got (`response`, stored when written), or one already stored. */
export interface AttemptEnd {
  attempt: number;
  outcome: 'ok' | 'error';
  meta: CallStartRow['meta'];
  response?: Buffer;
  responseRef?: string | null;
}

export class SidecarCore {
  readonly store: Store;
  /** The sidecar's base URL, the session token in it, and the same over cleartext HTTP/2 (Sidecar.http2Url). */
  readonly url: string;
  readonly http2Url: string;
  /** The providers calls are routed to, `/<id>/…`. */
  readonly providers: Map<string, Provider>;
  /** Every provider by id, the hosts reached through another's route among them (hostedProviders), for reading a recorded call's `via`. */
  readonly byId: Map<string, Provider>;
  readonly normalizers: Normalizer[];
  readonly upstreams: Record<string, string>;
  readonly sdkBases: Record<string, string>;
  readonly prices: Record<string, Price> | undefined;
  readonly clock: ClockMode;
  /** HTTP hosts recorded as tools. */
  readonly httpRules: readonly HttpRule[];
  /** The config's trust marks, by tool name or host. */
  readonly trust: ToolTrust | undefined;
  readonly log: (line: string) => void;
  readonly runs = new Map<string, RunContext>();
  /** Store trouble said of a run after its summary was made, for endWritten, by run: the newest LATE_RUNS runs'. */
  readonly lateTrouble = new Map<string, string[]>();
  activeRunId: string | null = null;
  /** The run each slot's traffic belongs to. */
  readonly slots = new Map<string, string>();
  readonly api: SidecarOptions['api'];
  readonly awsCredentials: CredentialsFor;
  /**
   * What a judge call carries (`x-shadowlap-judge`) besides the session token: a secret this process
   * alone knows, never in an agent's environment, so no call of the agent's can claim the judge's
   * scope, which replay strictness leaves out.
   */
  readonly judgeToken = randomBytes(16).toString('hex');
  /** Upstream HTTP/2 connections, one per origin, for requests that arrived over HTTP/2. */
  readonly upstreamHttp2 = new Map<string, ClientHttp2Session>();
  /** Requests upstream over HTTP/1.1 that have not ended yet: a model call still waiting for its answer, a body still streaming. */
  readonly upstreamRequests = new Set<ClientRequest>();
  /** Every write of the runs and their calls to the store, in order, never holding up an answer (writer.ts). */
  readonly writer: StoreWriter;
  /** Where a captured call's long body is masked and stored, so the thread every agent's answers stream on goes on meanwhile (body-threads.ts). */
  readonly bodies = new BodyThreads();
  /**
   * Set by Sidecar.close() once no agent is connected. A call still being handled then is one whose
   * agent left before its answer came: it records and reports nothing more, since nobody is left to
   * read it and the store may close as soon as close() returns.
   */
  closed = false;

  constructor(opts: SidecarOptions, url: string, http2Url: string) {
    this.store = opts.store;
    this.url = url;
    this.http2Url = http2Url;
    this.providers = new Map((opts.providers ?? (opts.formats ? [...defaultProviders, ...opts.formats.map(formatHostProvider)] : activeProviders())).map((p) => [p.id, p]));
    this.byId = new Map([...hostedProviders, ...this.providers.values()].map((p) => [p.id, p]));
    this.normalizers = opts.normalizers ?? [];
    this.upstreams = opts.upstreams ?? {};
    this.sdkBases = opts.sdkBases ?? sdkBasesFromEnvironment(process.env);
    this.prices = opts.prices;
    this.clock = opts.clock ?? 'auto';
    this.httpRules = opts.http ?? [];
    this.trust = opts.trust;
    this.log = opts.log ?? (() => {});
    this.api = opts.api;
    this.awsCredentials = opts.awsCredentials ?? credentialsFromEnvironment();
    this.writer = new StoreWriter(opts.store, opts.storeWrites ?? {}, (line) => this.log(line));
  }

  contextFor(req: IncomingMessage, pinnedByPath?: string): RunContext {
    const header = req.headers['x-shadowlap-run'];
    const runId = pinnedByPath || (Array.isArray(header) ? header[0] : header) || this.activeRunId;
    const ctx = runId ? this.runs.get(runId) : undefined;
    if (!ctx) throw new HttpError(409, runId ? `run ${runId} is not active` : 'no active run');
    return ctx;
  }

  /**
   * The scope a call is made in (scopeOf), and whether it is a judge's. A scope under `shadowlap:`
   * is Shadowlap's own: only a judge's model call may have one, `shadowlap:judge`, with this
   * process's judge token, so an agent's call can never be left out of the replay's strictness. A
   * run opened for its judge alone (openForJudge) takes no other call.
   */
  callScope(req: IncomingMessage, ctx: RunContext, kind: 'api' | 'tool'): { scope: string | undefined; judge: JudgeAccess | null } {
    const scope = scopeOf(req);
    if (!scope?.startsWith(RESERVED_SCOPE_PREFIX)) {
      if (ctx.judgeOnly) throw new HttpError(409, `run ${ctx.run.runId} has ended; it is open for its judge's calls only`);
      return { scope, judge: null };
    }
    const sent = headerValue(req, 'x-shadowlap-judge');
    const token = Buffer.from(this.judgeToken);
    const own = kind === 'api' && scope === JUDGE_SCOPE && sent !== undefined && Buffer.byteLength(sent) === token.length && timingSafeEqual(Buffer.from(sent), token);
    if (!own) throw new HttpError(400, `the scope "${scope}" is reserved for Shadowlap's own calls; give the agent's scope another name`);
    const check = decodeHeader(headerValue(req, 'x-shadowlap-judge-check'));
    const ask = headerValue(req, 'x-shadowlap-judge-ask');
    // The version of the request it sends (JUDGE_REQUEST_VERSION), kept so a later version can say an older verdict is no answer for it.
    const version = headerValue(req, 'x-shadowlap-judge-version');
    // Where the judge is asked live: its own upstream, never one this sidecar points at a model under test.
    const upstream = headerValue(req, 'x-shadowlap-judge-upstream');
    if (upstream !== undefined && !/^https?:\/\/[^/\s]+/i.test(upstream)) throw new HttpError(400, `x-shadowlap-judge-upstream is not an http(s) URL: ${upstream}`);
    return {
      scope,
      judge: {
        offline: headerValue(req, 'x-shadowlap-judge-offline') === '1',
        ...(upstream ? { upstream: upstream.replace(/\/+$/, '') } : {}),
        ...(check && ask && /^[0-9a-f]{1,64}$/.test(ask) ? { meta: { check: check.slice(0, 200), ask, ...(version && /^\d{1,6}$/.test(version) ? { v: Number(version) } : {}) } } : {}),
      },
    };
  }

  // ---- model API proxy: route, resolve, then serve recorded or forward live, recording each attempt ----

  /**
   * Where a captured request was going. In-process capture (Bedrock signs for its host, and any
   * client may hardcode a base URL) sends the agent's own request here with the destination in a
   * header. Only hosts the provider vouches for are accepted, so this is never an open proxy.
   */
  requestedUpstream(req: IncomingMessage, provider: Provider, ctx: RunContext, websocket = false): string | undefined {
    // A configured upstream (a mock, a local server, or "offline" in shadowlap test) takes precedence.
    if (this.upstreamOf(provider) || ctx.offline) return undefined;
    return this.vouchedUpstream(req, provider, websocket);
  }

  /**
   * The host a captured request names (`x-shadowlap-upstream`) when its provider vouches for it, as
   * an origin; undefined when it names none, and refused when it names one the provider doesn't own.
   */
  vouchedUpstream(req: IncomingMessage, provider: Provider, websocket = false): string | undefined {
    const raw = req.headers['x-shadowlap-upstream'];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!value) return undefined;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new HttpError(400, `x-shadowlap-upstream is not a URL: ${value}`);
    }
    // A WebSocket's host may be named wss:; it is reached over TLS either way. A host the config
    // declares with a port says what it takes itself, http included (Provider.accepts).
    const secure = url.protocol === 'https:' || (websocket && url.protocol === 'wss:');
    if (!(provider.accepts?.(url) ?? (secure && provider.hosts.test(url.hostname)))) {
      throw new HttpError(403, `${provider.id} cannot forward to ${url.origin}. Point it at a mock with ${upstreamVariable(provider)} instead.`);
    }
    return url.protocol === 'http:' ? url.origin : `https://${url.host}`;
  }

  /**
   * The upstream configured for a provider, by its id or by its id as SHADOWLAP_UPSTREAM_<NAME>
   * spells it (`bedrock_mantle` for bedrock-mantle, `openrouter_ai` for a declared openrouter.ai).
   */
  upstreamOf(provider: Provider): string | undefined {
    return this.upstreams[provider.id] || this.upstreams[provider.id.toLowerCase().replace(/[^a-z0-9]/g, '_')] || undefined;
  }

  /** The path a call goes to under `upstream`: an SDK's own base URL with no `/v1` under it (sdkBases) takes the SDK's path without that `/v1`. */
  upstreamPath(provider: Provider, upstream: string, path: string): string {
    const sdkBase = this.sdkBases[provider.id];
    const sdkPath = provider.sdkPath;
    const sdkRelative = sdkBase !== undefined && sdkPath !== undefined && upstream === sdkBase.replace(/\/+$/, '') && (path === sdkPath || path.startsWith(`${sdkPath}/`));
    return sdkRelative ? path.slice(sdkPath.length) : path;
  }

  /**
   * A request forwarded over HTTP/2, as a fetch Response so recording and streaming don't care how
   * it travelled. Needed for fidelity, not speed: a client that signs over HTTP/2 (the AWS SDK)
   * signs the `:authority` pseudo-header, which an HTTP/1.1 request cannot carry. A compressed body
   * is decoded as it is over HTTP/1.1 (asResponse), and `signal` ends the request when its agent has gone.
   */
  fetchOverHttp2(origin: string, path: string, method: string, headers: Record<string, string>, body: Buffer | null, authority: string, signal?: AbortSignal): Promise<Response> {
    let session = this.upstreamHttp2.get(origin);
    if (!session || session.closed || session.destroyed) {
      session = connectHttp2(origin);
      session.on('error', () => this.upstreamHttp2.delete(origin));
      session.on('close', () => this.upstreamHttp2.delete(origin));
      this.upstreamHttp2.set(origin, session);
    }
    const scheme = new URL(origin).protocol.replace(':', '');
    const stream = session.request({ ...headers, ':method': method, ':path': path, ':authority': authority, ':scheme': scheme }, { endStream: !body, ...(signal ? { signal } : {}) });
    if (body) stream.end(body);
    return new Promise((resolve, reject) => {
      // Every error, not just the first: a stream that fails again later must not go unheard.
      stream.on('error', reject);
      stream.once('response', (h) => {
        try {
          const status = Number(h[':status']);
          const out = new Headers();
          for (const [k, v] of Object.entries(h)) {
            if (k.startsWith(':') || v === undefined) continue;
            out.set(k, Array.isArray(v) ? v.join(', ') : String(v));
          }
          const noBody = method === 'HEAD' || status === 204 || status === 304;
          if (noBody) stream.resume();
          resolve(asResponse(status, out, noBody ? null : stream));
        } catch (err) {
          stream.destroy();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  /**
   * Record: an attempt's end, with what the agent got, through the store writer. Where it can't be
   * written, an error end in its place says why, and so do the run's warnings.
   */
  recordEnd(ctx: RunContext, callNo: number, identity: CallIdentity, end: AttemptEnd, noun = 'answer'): void {
    const at = Date.now();
    const row = (responseRef: string | null, outcome: 'ok' | 'error', meta: CallMeta): CallEndRow => ({ runId: ctx.run.runId, callNo, attempt: end.attempt, responseRef, outcome, meta, at });
    // Kept for the run's end (RunContext.records), as the store will hold it but for what only the store needs.
    const kept = row(null, end.outcome, withoutChunksOrHeaders(end.meta));
    ctx.keepEnd(callNo, kept);
    this.writer.write({
      what: `call ${callNo}'s ${noun}`,
      of: { runId: ctx.run.runId, part: 'calls' },
      run: () => this.store.appendCallEnd(identity, row(end.response !== undefined ? this.store.putBlob(end.response) : (end.responseRef ?? null), end.outcome, end.meta)),
      instead: (reason) => {
        const { chunks: _timing, ...meta } = end.meta;
        const error = row(null, 'error', { ...meta, error: { name: 'ShadowlapStoreError', message: `the ${noun} could not be written to the store: ${reason}` } });
        this.store.appendCallEnd(identity, error);
        ctx.keepEnd(callNo, { ...error, meta: withoutChunksOrHeaders(error.meta) }, kept);
      },
      failed: (reason, replaced) => {
        if (!replaced) ctx.keepEnd(callNo, null, kept);
        this.storeTrouble(ctx, `store:${callNo}:${end.attempt}`, `Call ${callNo}'s ${noun} could not be written to the store (${reason})${replaced ? ', so the call is kept as an error without it' : ''}. The agent got it; the recording doesn't hold it.`);
      },
    });
  }

  /**
   * A write of the run's that could not be made, said once in its warnings; nothing more once the run
   * itself could not be (RunContext.lost). Said after the run's summary was made, it is kept for
   * endWritten, for the newest runs.
   */
  storeTrouble(ctx: RunContext, key: string, message: string): void {
    if (ctx.lost !== null || !ctx.warnOnce(key, message) || !ctx.ended) return;
    const runId = ctx.run.runId;
    const lines = this.lateTrouble.get(runId) ?? [];
    if (!lines.length) this.lateTrouble.set(runId, lines);
    lines.push(message);
    if (this.lateTrouble.size > LATE_RUNS) this.lateTrouble.delete(this.lateTrouble.keys().next().value!);
  }

  noteDivergence(ctx: RunContext): void {
    const found = ctx.session.divergence;
    if (found && !ctx.run.divergence) {
      const d = this.keepDivergence(ctx, found);
      this.log(`run ${ctx.run.runId} diverged at call ${d.callNo} (${d.type})`);
    }
  }

  /** Keeps a run's divergence on it, in memory and in the store, through the store writer. */
  keepDivergence(ctx: RunContext, found: DivergenceReport): DivergenceReport {
    // A hint for a change the run's rules mask would ask for a rule the config has: the report
    // still lists the change, as the request carried it, but it didn't make the replay diverge.
    const hints = found.hints?.length ? unmaskedHints(found, ctx.normalizers) : null;
    const d = hints && hints.length !== found.hints!.length ? withHints(found, hints) : found;
    ctx.run.divergence = d;
    this.writer.write({
      what: `run ${ctx.run.runId}'s divergence`,
      of: { runId: ctx.run.runId, part: 'run' },
      run: () => this.store.setDivergence(ctx.run.runId, d),
      failed: (reason) => this.storeTrouble(ctx, 'store:divergence', `Where the run diverged (call ${d.callNo}) could not be written to the store (${reason}).`),
    });
    return d;
  }

  /**
   * Works out the diff of a divergence that waits for one (Session.explainPending), for `only` or for
   * every run: called once each request has been answered, so no agent waits on recorded requests
   * being loaded and compared, and by endRun before a run ends. A failure leaves the divergence as it
   * was first kept, compared with its nearest recorded call.
   */
  explainWaiting(only?: RunContext): void {
    if (this.closed) return;
    for (const ctx of only ? [only] : this.runs.values()) {
      if (!ctx.session.explaining) continue;
      try {
        const d = ctx.session.explainPending();
        if (d) this.keepDivergence(ctx, d);
      } catch (err) {
        this.log(`run ${ctx.run.runId}: its divergence was kept without a diff: ${messageOf(err)}`);
      }
    }
  }

  /** A stored JSON blob with each number as it was written (parseJsonExact): for what is served back and fingerprinted. */
  getJsonExact<T>(ref: string): T | null {
    const bytes = this.store.getBlob(ref);
    return bytes ? (parseJsonExact(bytes.toString('utf8')) as T) : null;
  }
}

/** A divergence with these hints in place of its own, none kept as no list. */
function withHints(d: DivergenceReport, hints: NonNullable<DivergenceReport['hints']>): DivergenceReport {
  const { hints: _dropped, ...rest } = d;
  return hints.length ? { ...rest, hints } : rest;
}

/** An end's metadata as the run's end reads it (RunContext.records): without the answer's chunk timing and headers, which only the store keeps. */
function withoutChunksOrHeaders(meta: CallMeta): CallMeta {
  const { chunks: _timing, headers: _headers, ...read } = meta;
  return read;
}

/** The variable that sends a provider's calls elsewhere: SHADOWLAP_UPSTREAM_BEDROCK_MANTLE for bedrock-mantle. */
export const upstreamVariable = (provider: Provider): string => `SHADOWLAP_UPSTREAM_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** The id a provider's calls are recorded under: the format's, for a host of another's (Provider.format). */
export const recordedId = (provider: Provider): string => provider.format ?? provider.id;
