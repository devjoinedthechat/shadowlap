/**
 * Calls to the HTTP hosts declared under `http` in the config, captured in the agent's process and
 * recorded as tools: replayed from the recording, run live, blocked or stubbed. The sidecar makes the
 * request itself when one runs live, and only to a declared host.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fingerprintTool, maskPathCredentials, matchedAs, messageOf, plantInToolResult, refused, toolFailureError, withSecretNames, type CallEndRow, type CallStartRow, type Decision, type Effect, type SerializedError } from '@shadowlap/engine';
import { breakAsRecorded, breakConnection, clientLeft, ClientWatch, HttpError, json, jsonBytes, sendOwn, type OwnAnswer } from './answers.js';
import type { SidecarCore } from './core.js';
import { encodeBody, keptResponseHeaders, matchHttpRule, storedResponseBytes, withoutCredentials, type HttpResult, type StoredBody } from './http.js';
import { carriesPlaceholder, placeholderRefusal } from './placeholders.js';
import { forwardedHeaders, lowerHeaders, readBody } from './requests.js';
import type { RunContext, TrackedCall } from './run-context.js';
import { cacheToolFingerprint, fencedRead, recordToolStart, trustMeta } from './tool-calls.js';
import { requestUpstream } from './upstream.js';

/**
 * A call to a declared HTTP host as the agent sent it (routeHttpCall): its run, the host it was for,
 * and its request as it is stored and matched.
 */
interface HttpCall {
  ctx: RunContext;
  req: IncomingMessage;
  res: ServerResponse;
  client: ClientWatch;
  scope: string | undefined;
  /** The host it was for, as in-process capture names it (`x-shadowlap-upstream`). */
  host: string;
  effect: Effect;
  method: string;
  rawBody: Buffer;
  /** `POST host/path`, as the call is named. */
  name: string;
  /** Where it goes live: the host, and its path and query as the agent sent them. */
  url: string;
  search: string;
  /** What it is stored and matched by: its method, and its URL and body without their credentials. */
  args: { method: string; url: string } & StoredBody;
}

/** A captured HTTP call once resolved (resolveHttpCall). */
interface PlacedHttpCall {
  callNo: number;
  tracked: TrackedCall;
}

/**
 * What a captured HTTP call's end stores: the host's answer (`result`), or the error it got instead,
 * with the answer the sidecar gave it itself (`answer`) when it gave one.
 */
interface StoredHttpEnd {
  result?: HttpResult;
  error?: SerializedError;
  answer?: HttpResult;
}

/**
 * A captured call to a host under `http` in the config, resolved like a tool call the SDK would
 * make: replayed from the recording, run live, blocked or stubbed. The sidecar makes the request
 * itself when it runs live, and only to a declared host. Request headers are never stored, nor
 * the credentials in its query string or form body (an API key, a token, a signature): the
 * request is stored and matched with them masked (withoutCredentials), so a rotated key still
 * replays, and only the live forward carries them. In stages, as a model call is: route
 * (`routeHttpCall`), resolve (`resolveHttpCall`), then serve it without the network where it must
 * be (`serveRecordedHttp`) or forward it live (`forwardHttp`). Each answer is recorded as the agent
 * got it (`endHttpCall`).
 */
export async function proxyHttp(core: SidecarCore, req: IncomingMessage, res: ServerResponse, subpath: string, search: string, pinned?: string): Promise<void> {
  const call = await routeHttpCall(core, req, res, subpath, search, pinned);
  if (!call) return;
  const placed = resolveHttpCall(core, call);
  if (serveRecordedHttp(core, call, placed)) return;
  await forwardHttp(core, call, placed);
}

/**
 * Route: the run a captured HTTP call belongs to, its scope, the declared host it was for, and the
 * request as the agent sent it, as it is stored and matched. Its agent is watched from the start,
 * as a model call's is: one that leaves ends the request to the host too. Null when its agent left
 * before the request was all here: nothing was asked.
 */
async function routeHttpCall(core: SidecarCore, req: IncomingMessage, res: ServerResponse, subpath: string, search: string, pinned?: string): Promise<HttpCall | null> {
  const client = new ClientWatch(res);
  res.on('error', () => {});
  const ctx = core.contextFor(req, pinned);
  const { scope } = core.callScope(req, ctx, 'tool');
  const raw = req.headers['x-shadowlap-upstream'];
  let origin: URL;
  try {
    origin = new URL(String(Array.isArray(raw) ? raw[0] : raw));
  } catch {
    throw new HttpError(400, 'a captured HTTP call needs x-shadowlap-upstream');
  }
  const rule = matchHttpRule(core.httpRules, origin);
  if (!rule) throw new HttpError(403, `${origin.host} is not an HTTP host Shadowlap records: add it under "http" in shadowlap.config.json`);
  const method = (req.method ?? 'GET').toUpperCase();
  let rawBody: Buffer;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    if (client.gone) return null;
    throw err;
  }
  if (client.gone) return null;
  // Stored and matched without the credentials in its address: a webhook's secret in its path, its query's (credentialFreeUrl).
  const [path, query] = withSecretNames(ctx.secretNames, () => [maskPathCredentials(subpath), withoutCredentials(search)] as const);
  const name = `${method} ${origin.host}${path}`;
  // A long body is stored on a thread of its own (BodyThreads): the agent can leave meanwhile.
  // A secret's names are kept, or masked, as the run's rule says (RunContext.secretNames); a secret
  // a write to a secret store sends, by the call's name (credentialFreeBody).
  const body = await core.bodies.request(rawBody, req.headers['content-type'], ctx.secretNames, name);
  if (client.gone) return null;
  const args = { method, url: `${origin.origin}${path}${query}`, ...body };
  return { ctx, req, res, client, scope, host: origin.host, effect: rule.effect, method, rawBody, name, url: `${origin.origin}${subpath}${search}`, search, args };
}

/**
 * Resolve: which call a captured HTTP request is, as the session decides it, and its start
 * recorded. A redacted parent holds such a call under its name masked (an address in the path),
 * and it is matched so (matchedAs).
 */
function resolveHttpCall(core: SidecarCore, call: HttpCall): PlacedHttpCall {
  const { ctx, scope, name, args, effect } = call;
  const matched = matchedAs({ kind: 'tool', name, meta: { http: call.host } }, ctx.normalizers, ctx.redactions);
  const { fingerprint } = fingerprintTool(matched.name, args, matched.normalizers, ctx.clockRef);
  const { callNo, tracked } = ctx.openCall({ kind: 'tool', name, fingerprint, effect, request: { args }, ...(scope ? { scope } : {}), ...(matched.name !== name ? { recordedName: matched.name } : {}) });
  const { decision } = tracked;
  core.noteDivergence(ctx);
  // A plain read the recording held no counterpart for, answered live while the replay goes on.
  const requestRef = recordToolStart(core, ctx, callNo, tracked, { args }, { http: call.host, ...(scope ? { scope } : {}), ...(decision.origin === 'live' && decision.extra ? { extraRead: true } : {}), ...trustMeta(core, name, call.host, null) });
  cacheToolFingerprint(core, ctx, callNo, matched, true, fingerprint, args, requestRef);
  return { callNo, tracked };
}

/** Record: a captured HTTP call's end, `response` the bytes to store or the ref of what is stored already. */
function endHttpCall(core: SidecarCore, call: HttpCall, placed: PlacedHttpCall, response: Buffer | string | null, outcome: 'ok' | 'error', meta: CallStartRow['meta']): void {
  core.recordEnd(call.ctx, placed.callNo, placed.tracked.identity, { attempt: 0, outcome, meta, ...(Buffer.isBuffer(response) ? { response } : { responseRef: response }) }, 'result');
  placed.tracked.done = true;
}

/**
 * Answers a captured HTTP call with an answer of the sidecar's own (sendOwn), and records it with
 * the error it stands for: the answer is kept beside the error (`answer`, never `result`, which is
 * the host's), so a replay sends the agent the same status, headers and bytes.
 */
function answerOwnHttp(core: SidecarCore, call: HttpCall, placed: PlacedHttpCall, own: OwnAnswer, error: SerializedError, meta: CallStartRow['meta'] = {}): void {
  const sent = sendOwn(call.res, own);
  const answer: HttpResult = { status: own.status, headers: sent.headers, body: own.body, encoding: 'json' };
  endHttpCall(core, call, placed, jsonBytes({ error, answer }), 'error', { status: own.status, error, latencyMs: 0, ...meta });
}

/**
 * Serves a recorded captured HTTP call as its agent got it: the host's answer, the bytes as they
 * came (an agent that reads the text, or a number JSON.parse would round, gets what it got then);
 * the sidecar's own; or, where no answer reached the agent (it left, its host couldn't be reached or
 * broke off, a flag closed its connection), its connection closed again. An answer of the sidecar's
 * own that an earlier version kept only as its error is written again from it (earlierHttpAnswer).
 */
function replayHttp(core: SidecarCore, call: HttpCall, recorded: CallEndRow, from: string): void {
  const blob = recorded.responseRef ? core.store.getBlob(recorded.responseRef) : null;
  const payload = blob ? (JSON.parse(blob.toString('utf8')) as StoredHttpEnd) : {};
  if (payload.result) return sendHttp(call.res, payload.result, from, storedResponseBytes(payload.result, blob));
  const answer = payload.answer ?? earlierHttpAnswer(recorded, payload.error);
  if (answer) return sendHttp(call.res, answer, from);
  if (recorded.meta.status === undefined) return breakAsRecorded(call.res, recorded.meta, Date.now(), recorded.meta.error?.message ?? 'no answer came');
  json(call.res, 502, { type: 'error', error: { type: 'shadowlap_replayed_error', message: payload.error?.message ?? 'the recorded call failed' } });
}

/**
 * Serve recorded: a captured HTTP call answered without the network where it has to be, as the
 * session decided, one function for each way it can be decided: replayed, failed as `--fail-at`
 * asks, with text planted in its result, with an override's result, blocked, stubbed; or, decided
 * live, one that may not go out (offline, or carrying a placeholder key). False when it goes live.
 */
function serveRecordedHttp(core: SidecarCore, call: HttpCall, placed: PlacedHttpCall): boolean {
  const decision = placed.tracked.decision;
  switch (decision.origin) {
    case 'replayed':
      serveReplayedHttp(core, call, placed, decision);
      return true;
    case 'injected':
      serveInjectedHttp(core, call, placed, decision);
      return true;
    case 'planted':
      servePlantedHttp(core, call, placed, decision);
      return true;
    case 'overridden':
      serveOverriddenHttp(core, call, placed, decision);
      return true;
    case 'blocked':
      serveBlockedHttp(core, call, placed);
      return true;
    case 'stubbed':
      serveStubbedHttp(core, call, placed);
      return true;
    case 'live':
      return refuseLiveHttp(core, call, placed);
  }
}

/** The host's answer as the recording holds it. */
function serveReplayedHttp(core: SidecarCore, call: HttpCall, placed: PlacedHttpCall, decision: Extract<Decision, { origin: 'replayed' }>): void {
  const recorded = decision.record.end!;
  endHttpCall(core, call, placed, recorded.responseRef, recorded.outcome, { ...recorded.meta, replayedFrom: decision.record.callNo, latencyMs: 0 });
  replayHttp(core, call, recorded, 'replayed');
}

/**
 * A failure `--fail-at` asks for, the way HTTP fails: with that status; or, for a timeout or an
 * error, the way the agent's HTTP library reports one. The capture hooks raise the library's own
 * error (a fetch TimeoutError, httpx.ReadTimeout, requests' ReadTimeout...) from an answer that
 * names the failure, and ask for one with x-shadowlap-failures: raise. Any other client gets the
 * connection closed before a response, which it reports as a network error.
 */
function serveInjectedHttp(core: SidecarCore, call: HttpCall, placed: PlacedHttpCall, decision: Extract<Decision, { origin: 'injected' }>): void {
  const { ctx, req, res, name } = call;
  const f = decision.failure;
  const error = toolFailureError(name, f);
  const meta = { injected: true, failure: f };
  core.log(`run ${ctx.run.runId} call ${placed.callNo}: injected ${f.kind === 'status' ? `HTTP ${f.status}` : f.kind}`);
  if (f.kind === 'status') answerOwnHttp(core, call, placed, { status: f.status, body: { error: { message: error.message } }, origin: 'injected' }, error, meta);
  else if (req.headers['x-shadowlap-failures'] !== 'raise') {
    endHttpCall(core, call, placed, jsonBytes({ error }), 'error', { ...meta, error, latencyMs: 0 });
    breakConnection(res, error.message);
  } else {
    // Only a message the flag gave: without one, each library's own wording stands.
    const headers = { 'x-shadowlap-injected': f.kind, ...(f.kind === 'error' && f.message ? { 'x-shadowlap-injected-message': encodeURIComponent(f.message) } : {}) };
    answerOwnHttp(core, call, placed, { status: f.kind === 'timeout' ? 504 : 502, body: { error: { message: error.message } }, origin: 'injected', headers }, error, meta);
  }
}

/**
 * The recorded answer with text planted in it (`--inject-result`), each number as it was recorded,
 * so the agent gets the result with only the text added; served as recorded when the text can't go in.
 */
function servePlantedHttp(core: SidecarCore, call: HttpCall, placed: PlacedHttpCall, decision: Extract<Decision, { origin: 'planted' }>): void {
  const { ctx, res } = call;
  const recorded = decision.record.end!;
  const payload = (recorded.responseRef ? core.getJsonExact<StoredHttpEnd>(recorded.responseRef) : null) ?? {};
  const planted = payload.result ? plantInToolResult(payload.result, decision.text, true) : { refused: 'it failed when it was recorded, so it has no response to add to' };
  if (refused(planted)) {
    ctx.session.declined(decision.record.callNo);
    ctx.warnOnce(`plant:${decision.record.callNo}`, `--inject-result ${decision.record.callNo} changed nothing: ${planted.refused}`);
    endHttpCall(core, call, placed, recorded.responseRef, recorded.outcome, { ...recorded.meta, replayedFrom: decision.record.callNo, latencyMs: 0 });
    replayHttp(core, call, recorded, 'replayed');
    return;
  }
  endHttpCall(core, call, placed, jsonBytes({ result: planted.result }), 'ok', { overriddenFrom: decision.record.callNo, planted: planted.at, latencyMs: 0 });
  sendHttp(res, planted.result as HttpResult, 'overridden');
}

/** An `--override` result: an HTTP answer as given, or any other value as a JSON body with status 200. */
function serveOverriddenHttp(core: SidecarCore, call: HttpCall, placed: PlacedHttpCall, decision: Extract<Decision, { origin: 'overridden' }>): void {
  const value = decision.result as Partial<HttpResult> | null;
  const result: HttpResult = value && typeof value === 'object' && typeof value.status === 'number' ? { status: value.status, headers: value.headers ?? {}, ...(value.body !== undefined ? { body: value.body, encoding: value.encoding ?? 'json' } : {}) } : { status: 200, headers: { 'content-type': 'application/json' }, body: value, encoding: 'json' };
  endHttpCall(core, call, placed, jsonBytes({ result }), 'ok', { overriddenFrom: decision.record.callNo, latencyMs: 0 });
  sendHttp(call.res, result, 'overridden');
}

/** A read the replay fences, or a write after the divergence: answered 409 without being sent. */
function serveBlockedHttp(core: SidecarCore, call: HttpCall, placed: PlacedHttpCall): void {
  const { name, effect } = call;
  const error: SerializedError = effect === 'read' ? { name: 'ShadowlapReadBlocked', message: fencedRead(name) } : { name: 'ShadowlapWriteBlocked', message: `write ${name} blocked after divergence (use --writes stub|allow to change this)` };
  answerOwnHttp(core, call, placed, { status: 409, body: { type: 'error', error: { type: effect === 'read' ? 'shadowlap_read_blocked' : 'shadowlap_write_blocked', message: error.message } }, origin: 'blocked' }, error);
}

/** A write stubbed after the divergence (`--writes stub`): a 200 that says so, never sent. */
function serveStubbedHttp(core: SidecarCore, call: HttpCall, placed: PlacedHttpCall): void {
  const result: HttpResult = { status: 200, headers: { 'content-type': 'application/json' }, body: { shadowlap: 'stubbed' }, encoding: 'json' };
  endHttpCall(core, call, placed, jsonBytes({ result }), 'ok', { stubbed: true, latencyMs: 0 });
  sendHttp(call.res, result, 'stubbed');
}

/**
 * A call decided live that may not go out, answered here: offline (shadowlap test), or carrying a
 * placeholder key the agent passes on to a declared host (a vector store that embeds with the
 * caller's OpenAI key), which is never sent either. False when it may go out.
 */
function refuseLiveHttp(core: SidecarCore, call: HttpCall, placed: PlacedHttpCall): boolean {
  const { ctx, req, name } = call;
  const { callNo } = placed;
  if (ctx.offline || core.upstreams.http === 'offline') {
    const message = `shadowlap is offline: call #${callNo} (${name}) was not served from the recording and would need the network`;
    answerOwnHttp(core, call, placed, { status: 503, body: { type: 'error', error: { type: 'shadowlap_offline', message } }, origin: 'offline' }, { name: 'ShadowlapOffline', message });
    return true;
  }
  if (carriesPlaceholder(req.headers, call.search)) {
    const message = placeholderRefusal('the key it sends', name);
    answerOwnHttp(core, call, placed, { status: 401, body: { type: 'error', error: { type: 'shadowlap_placeholder_key', message } }, origin: 'refused' }, { name: 'ShadowlapPlaceholderKey', message }, { refused: true, retryable: false });
    ctx.warnOnce(`placeholder:${name}`, message);
    core.log(`run ${ctx.run.runId} call ${callNo}: not sent, it carries a placeholder key`);
    return true;
  }
  return false;
}

/**
 * Forward live: the captured call sent to its host as the agent sent it, and the host's answer,
 * read whole, passed on and recorded as it came. An agent that leaves before the answer is recorded
 * as gone, and the request to the host ends with it. A host that can't be reached, or that breaks
 * off its answer, breaks the agent's connection as it would have without Shadowlap: the agent's
 * HTTP library reports a network error, and the call is recorded with none, so a replay closes the
 * connection again.
 */
async function forwardHttp(core: SidecarCore, call: HttpCall, placed: PlacedHttpCall): Promise<void> {
  const { ctx, res, client, method, rawBody, name } = call;
  const started = Date.now();
  let upstream: Response | undefined;
  let bytes: Buffer;
  // The agent left before the host answered (its own timeout, say): it saw no answer at all.
  const left = () => {
    const error = clientLeft('before the response');
    endHttpCall(core, call, placed, jsonBytes({ error }), 'error', { error, latencyMs: Date.now() - started });
  };
  try {
    upstream = await requestUpstream(call.url, method, forwardedHeaders(lowerHeaders(call.req.headers)), rawBody.length && method !== 'GET' && method !== 'HEAD' ? rawBody : null, core.upstreamRequests, client.signal);
    bytes = Buffer.from(await upstream.arrayBuffer());
  } catch (err) {
    // Its agent has gone and the sidecar has closed: it records and reports nothing (closed).
    if (core.closed) return;
    if (client.gone) return left();
    const message = `${name}: ${messageOf(err)}`;
    const error: SerializedError = { name: upstream ? 'UpstreamStreamError' : 'UpstreamConnectionError', message };
    breakConnection(res, message);
    endHttpCall(core, call, placed, jsonBytes({ error }), 'error', { error, latencyMs: Date.now() - started });
    ctx.warnOnce(`unreachable:${call.host}`, `Call ${placed.callNo} ${upstream ? `lost its connection to ${call.host} part way through the answer` : `could not reach ${call.host}`} (${message}): the agent's connection was closed with no answer, as the host's would have been.`);
    core.log(`run ${ctx.run.runId} call ${placed.callNo}: ${error.message}`);
    return;
  }
  if (client.gone) return left();
  const headers = keptResponseHeaders(upstream.headers);
  // A long answer is stored on a thread of its own (BodyThreads); the agent has it once it is stored, as before.
  const stored = await core.bodies.response({ status: upstream.status, headers, contentType: upstream.headers.get('content-type') ?? undefined, callName: name }, bytes, ctx.secretNames);
  if (core.closed) return;
  if (client.gone) return left();
  endHttpCall(core, call, placed, stored, 'ok', { status: upstream.status, latencyMs: Date.now() - started, bytes: bytes.length });
  res.writeHead(upstream.status, { ...headers, 'content-length': String(bytes.length), 'x-shadowlap-origin': 'live' });
  res.end(bytes);
}

/** Sends a captured HTTP call's answer as it is stored (the host's, or the sidecar's own), with its length and `x-shadowlap-origin`. */
function sendHttp(res: ServerResponse, result: HttpResult, from: string, bytes = encodeBody(result)): void {
  res.writeHead(result.status, { ...result.headers, 'content-length': String(bytes.length), 'x-shadowlap-origin': from });
  res.end(bytes);
}

/** The error types an earlier sidecar's answers of its own to a captured HTTP call carried, by the error it kept. */
const EARLIER_HTTP = new Map([
  ['ShadowlapReadBlocked', 'shadowlap_read_blocked'],
  ['ShadowlapWriteBlocked', 'shadowlap_write_blocked'],
  ['ShadowlapOffline', 'shadowlap_offline'],
  ['ShadowlapUpstreamError', 'shadowlap_upstream_error'],
  ['ShadowlapPlaceholderKey', 'shadowlap_placeholder_key'],
]);

/**
 * An answer of its own to a captured HTTP call that an earlier sidecar kept only as its error and
 * status, written again as that version sent it: a blocked call, an offline one, a host it couldn't
 * reach, a placeholder key, a status a flag injected. Null for anything else.
 */
function earlierHttpAnswer(end: CallEndRow, error: SerializedError | undefined): HttpResult | null {
  const status = end.meta.status;
  if (end.outcome !== 'error' || status === undefined || !error) return null;
  const type = EARLIER_HTTP.get(error.name);
  const body = end.meta.injected ? { error: { message: error.message } } : type ? { type: 'error', error: { type, message: error.message } } : null;
  return body ? { status, headers: { 'content-type': 'application/json' }, body, encoding: 'json' } : null;
}
