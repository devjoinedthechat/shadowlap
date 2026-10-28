/**
 * A model call, in stages. Route (routeModelCall): what the agent sent, for which run and provider,
 * its connection watched from then on. Resolve (resolveModelCall): which call it is, a retry of an
 * earlier one or a new one the session decides, rewritten first as the run's interventions have it,
 * and its start recorded. Then serve it without the network where it must be (serveRecorded, and
 * model-answers.ts), or forward it live and stream the answer back as it arrives (forwardLive,
 * relayAnswer). Each attempt's end is recorded as the agent saw it, through the store writer, which
 * never holds an answer up.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { apiCallName, asParsed, credentialFreeHeaders, credentialFreeQuery, multipartView, apiNumbers, parseJsonExact, redactApiPath, redactHeaderValues, reportable, storeApiRequest, type CallStartRow, type SerializedError } from '@shadowlap/engine';
import { breakConnection, clientLeft, ClientWatch, RESPONSE_DROP, sendOwn } from './answers.js';
import { recordedId, upstreamVariable, type AttemptEnd, type JudgeAccess, type SidecarCore } from './core.js';
import { allowedHeaders, clockMarks, encodeMarks, fingerprintKey } from './fingerprint-cache.js';
import { identityQuery } from './query.js';
import { serveInjectedFailure, servePlaceholderRefusal, serveRefusal, serveReplayed, serveStateRefusal, answerOwn } from './model-answers.js';
import { carriesPlaceholder, PLACEHOLDER_AWS_ACCESS_KEY_ID } from './placeholders.js';
import { hostedProviders, withoutHeaderParameters, type Provider } from './providers.js';
import { apiFingerprint, judgeFingerprint, matchedHeaders, modelRules, queryValues } from './replay-index.js';
import { forwardedHeaders, lowerHeaders, originOf, readBody } from './requests.js';
import { isResponsesCreate } from './responses-state.js';
import { beginAttempt, settleAttempt, storedOrigin, type RunContext, type TrackedCall } from './run-context.js';
import { resignSigV4, signingKeyId } from './sigv4.js';
import { SseTimer } from './sse.js';
import { isTelemetry, serveTelemetry } from './telemetry.js';
import { requestUpstream } from './upstream.js';
import type { CallPlace } from './interventions.js';

/** A model call as the agent sent it: its run and provider, and its request as interventions leave it. */
interface ModelCall {
  ctx: RunContext;
  req: IncomingMessage;
  res: ServerResponse;
  client: ClientWatch;
  provider: Provider;
  scope: string | undefined;
  judge: JudgeAccess | null;
  /** The upstream a captured request named (`x-shadowlap-upstream`), once its provider vouched for it. */
  requested: string | undefined;
  method: string;
  /** The path as the agent sent it, and as the call is named and forwarded (an intervention may switch the model in it). */
  sent: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  rawBody: Buffer;
  /** The body as JSON.parse reads it: for what reads its members (interventions, the provider's state, its model). */
  body: unknown;
  /**
   * The body as it is stored and fingerprinted, each number as the agent wrote it (parseJsonExact), so
   * an id past 2^53 is kept and matched by its digits; once an intervention rewrote the request, the
   * rewritten body, which is what was sent.
   */
  exact: unknown;
  retryCount: number;
  /** Whether a request identical to one that failed retryably is its retry: its client counts retries and this is one, or it counts none. */
  retrying: boolean;
}

/** What interventions made of a model request (rewriteForInterventions): its place, the call it retries if it is a retry, and how it changed. */
interface Rewritten {
  retryKey?: string;
  claimed?: number;
  place?: CallPlace;
  refusal?: string;
  forced?: { by: string; counterpart: number };
  changedBy?: string;
}

/** A model call once resolved: which call it is, and why an intervention could not be applied to it, if it couldn't. */
interface PlacedCall {
  callNo: number;
  tracked: TrackedCall;
  refusal?: string;
}

/** A live attempt under way: when it started, how it ends for the agent (once), and how its end is recorded. */
interface LiveAttempt {
  started: number;
  settle(retryable: boolean): void;
  end(row: Omit<AttemptEnd, 'attempt'>): void;
}

/** The user agent Claude Code sends with its model calls: `claude-cli/2.1.0 (external, cli)`, `… sdk-ts)` under the Claude Agent SDK. */
const CLAUDE_CODE_AGENT = /^claude-cli\//i;

/**
 * A model call, in stages. Route (`routeModelCall`): what the agent sent, for which run and
 * provider, its connection watched from then on. Resolve (`resolveModelCall`): which call it is, a
 * retry of an earlier one or a new one the session decides, whose start is recorded. Then serve it
 * from the recording (`serveRecorded`), or forward it live and stream the answer back
 * (`forwardLive`). Each attempt's end is recorded as the agent saw it (`endAttempt`, `recordEnd`),
 * through the store writer, which never holds an answer up.
 */
export async function proxy(core: SidecarCore, req: IncomingMessage, res: ServerResponse, provider: Provider, sent: string, search: string, pinned?: string): Promise<void> {
  const call = await routeModelCall(core, req, res, provider, sent, search, pinned);
  if (!call) return;
  const placed = resolveModelCall(core, call);
  if (!placed) return;
  if (serveRecorded(core, call, placed)) return;
  await forwardLive(core, call, placed);
}

/**
 * Route: the run a model call belongs to, its scope, the upstream a captured request names, and the
 * request as the agent sent it. An SDK's own telemetry goes its own way (serveTelemetry). Null when
 * nothing more is to be done: it was answered, or its agent left before it was all here.
 */
async function routeModelCall(core: SidecarCore, req: IncomingMessage, res: ServerResponse, provider: Provider, sent: string, search: string, pinned?: string): Promise<ModelCall | null> {
  const client = new ClientWatch(res);
  res.on('error', () => {});
  const ctx = core.contextFor(req, pinned);
  if (isTelemetry(provider.id, sent)) {
    await serveTelemetry(core, ctx, req, res, provider, sent, search, client);
    return null;
  }
  // A judge's call: no flag rewrites it, and the session matches it apart from the agent's.
  const { scope, judge } = core.callScope(req, ctx, 'api');
  const requested = core.requestedUpstream(req, provider, ctx);
  let rawBody: Buffer;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    if (client.gone) return null;
    throw err;
  }
  // Gone before its request was all here: nothing was asked.
  if (client.gone) return null;
  // The providers the agent used: a judge's is none of them. A host the config declares is named by
  // its format: its name is the project's own, and this list goes into telemetry.
  if (!judge) ctx.providersUsed.add(provider.format && !hostedProviders.includes(provider) ? provider.format : provider.id);
  const headers = lowerHeaders(req.headers);
  if (!judge && CLAUDE_CODE_AGENT.test(headers['user-agent'] ?? '')) ctx.claudeCode = true;
  let body: unknown;
  let exact: unknown;
  if (rawBody.length === 0) body = exact = null;
  else {
    const text = rawBody.toString('utf8');
    try {
      const kept = { raw: false };
      exact = parseJsonExact(text, kept);
      body = kept.raw ? JSON.parse(text) : exact;
    } catch {
      body = exact = rawBody.toString('base64');
    }
  }
  const retryHeader = provider.retryCountHeader ? headers[provider.retryCountHeader] : undefined;
  const retryCount = retryHeader === undefined ? 0 : Number.parseInt(retryHeader, 10) || 0;
  const method = (req.method ?? 'GET').toUpperCase();
  return { ctx, req, res, client, provider, scope, judge, requested, method, sent, path: sent, search, headers, rawBody, body, exact, retryCount, retrying: retryCount > 0 || retryHeader === undefined };
}

/**
 * Resolve: which call a request is. One identical to a call whose last attempt failed in a way its
 * client retries, that reads as a retry, is that call's next attempt: the first such call with
 * nothing in flight, oldest failure first (RunContext.retries). Anything else is a new call the
 * session decides (replayed, live, forced live by an intervention), and its start is recorded.
 * Interventions rewrite the request first (rewriteForInterventions), and a retry gets the rewrite
 * of the attempt it repeats. Null when the call is answered here already (a judge that may not be
 * asked live).
 */
function resolveModelCall(core: SidecarCore, call: ModelCall): PlacedCall | null {
  const { ctx, provider, scope, judge } = call;
  const { place, refusal, forced, ...rewritten } = rewriteForInterventions(core, call);
  let { claimed, retryKey, changedBy } = rewritten;
  // A request that carries planted text (shadowlap injection's canary) forks the replay there, even
  // when a normalizer masks the text into a match: the point of the plant is a model reading it.
  if (refusal === undefined && !forced && !changedBy && ctx.session.state === 'replaying' && ctx.session.options.plantMarks && ctx.session.carriesPlant(call.rawBody.toString('utf8'))) changedBy = ctx.session.options.plantMarks.by;
  const { name, matchName, kept, asked, fingerprint, query, unqueried } = identifyModelCall(call);

  // A judge that may not be asked live, whose very request the recording never answered, is
  // answered by no one: nothing is kept of it, since a call no one answered holds no verdict, and
  // a run, or a pack of it, would only carry it.
  if (judge && (judge.offline || ctx.offline) && !ctx.session.judgedFor(fingerprint)) {
    const message = `shadowlap is offline: this judge check's request is not in the recording, and the judge may not be asked live`;
    sendOwn(call.res, { status: 503, body: { type: 'error', error: { type: 'shadowlap_offline', message } }, origin: 'offline' });
    return null;
  }

  // Without interventions, a retry is told apart by its request as it is matched.
  if (retryKey === undefined) {
    retryKey = `api\n${scope ?? ''}\n${fingerprint}`;
    claimed = call.retrying ? ctx.claimRetry(retryKey) : undefined;
  }
  if (claimed !== undefined) return { callNo: claimed, tracked: ctx.calls.get(claimed)!, ...(refusal !== undefined ? { refusal } : {}) };

  const callNo = ctx.nextCallNo++;
  // A refused intervention still makes a call, answered with the reason: forced live, so it forks there.
  const by = refusal !== undefined ? { by: `an intervention it could not take (${refusal})` } : forced;
  // Shown as it was matched: against a parent read rounded (RunMeta.exactNumbers), every number as the double it reads as.
  const decision = ctx.session.resolve({ callNo, kind: 'api', name, fingerprint, request: ctx.roundedNumbers ? asParsed(call.exact) : reportable(call.exact), headers: allowedHeaders(asked, provider.fingerprintHeaders), ...(query ? { query } : {}), ...(matchName ? { matchName } : {}), ...(scope ? { scope } : {}), ...(by ? { forced: by } : changedBy ? { changedBy } : {}) });
  const tracked: TrackedCall = { identity: { kind: 'api', name, fingerprint, occurrence: decision.occurrence }, effect: null, origin: storedOrigin('api', decision), decision, attempts: 0, inFlight: 0, retryable: false, done: false, retryKey, ...(place ? { place } : {}) };
  ctx.calls.set(callNo, tracked);
  core.noteDivergence(ctx);
  recordModelStart(core, call, callNo, tracked, kept, asked, unqueried);
  return { callNo, tracked, ...(refusal !== undefined ? { refusal } : {}) };
}

/**
 * Resolve, with interventions: the request rewritten as the run's flags have it, before it is
 * fingerprinted, stored or forwarded, so the recording of the fork holds exactly what was sent.
 * A flag names a model call by its place among the recording's model calls (of its scope, when the
 * recording has scopes), counted the way the recording counts them: every one, whatever it sends
 * (an embeddings call too), and a retry as the call it retries. A retry is told apart as the
 * recording tells it, by its fingerprint, here of the request before any rewrite, so it gets the
 * same rewrite as the attempt it repeats. Nothing without interventions, or for a judge's call.
 */
function rewriteForInterventions(core: SidecarCore, call: ModelCall): Rewritten {
  const { ctx, provider, scope } = call;
  if (!ctx.interventions?.active || call.judge) return {};
  const retryKey = `sent\n${scope ?? ''}\n${apiFingerprint(ctx, provider, { method: call.method, path: call.sent, headers: matchedHeaders(provider, call.headers), body: call.exact, query: identityQuery(call.search, ctx.redactions, apiCallName(call.method, call.sent)) })}`;
  const claimed = call.retrying ? ctx.claimRetry(retryKey) : undefined;
  const place = (claimed !== undefined ? ctx.calls.get(claimed)?.place : undefined) ?? ctx.interventions.next(scope);
  const done: Rewritten = { retryKey, place, ...(claimed !== undefined ? { claimed } : {}) };
  // From the request as the agent wrote it, so what is sent in its place keeps each of its numbers.
  const rewrite = ctx.interventions.apply(place, recordedId(provider), call.sent, call.exact);
  if ('refused' in rewrite) return { ...done, refusal: rewrite.refused };
  // At the call a flag named: a changed body diverges on its own, and its diff shows the change; a
  // model switched in the path, or a setting the request already had, is forced.
  if (rewrite.target) {
    if (rewrite.changed && rewrite.path === call.sent) done.changedBy = rewrite.target.by;
    else done.forced = rewrite.target;
  }
  if (rewrite.changed) {
    call.path = rewrite.path;
    call.exact = rewrite.body;
    call.body = asParsed(rewrite.body);
    call.rawBody = Buffer.from(JSON.stringify(rewrite.body), 'utf8');
    // AWS signs a request's exact path and body: the changed one is signed again, or refused. One
    // signed with placeholder credentials is never sent, so forwardLive refuses it as it is.
    const keyId = signingKeyId(call.headers.authorization);
    if (keyId && keyId !== PLACEHOLDER_AWS_ACCESS_KEY_ID) {
      const signed = resign(core, call.req, call.headers, call.method, call.path, call.search, call.rawBody);
      if ('error' in signed) done.refusal = `${rewrite.target?.by ?? 'the intervention'}: ${signed.error}`;
      else call.headers = signed.headers;
    }
  }
  return done;
}

/**
 * Resolve: what identifies a model call, as its request is matched, and the headers it keeps. Its
 * query takes part, but for its credentials (identityQuery), unless the parent's calls to the
 * provider kept no query (`unqueried`), as a trace's never do: it is then matched, and kept,
 * without it.
 */
function identifyModelCall(call: ModelCall): { name: string; matchName: string | undefined; kept: Record<string, string>; asked: Record<string, string>; fingerprint: string; query: string; unqueried: boolean } {
  const { ctx, provider, judge } = call;
  const name = apiCallName(call.method, call.path);
  // Read as the recording's copy keeps its path: what a redaction rule masked there (a Bedrock model
  // ARN's account id) is masked here too.
  const path = redactApiPath(call.path, ctx.redactions, { kind: 'api', name });
  // What identifies the call, where the provider leaves part of its path out (Vertex AI's project and region).
  const matchPath = provider.matchPath?.(path) ?? path;
  const matchName = matchPath !== call.path ? apiCallName(call.method, matchPath) : undefined;
  // A parent that names no API version (a trace never keeps one) is matched, and this run kept,
  // without the version this request names: the run names none either, as the one it replays, so
  // the two stay the same calls (Compare, coverage) and its own replays match whatever version.
  const version = !judge && ctx.unversioned.has(provider.id) ? provider.apiVersion?.header : undefined;
  const sent = version !== undefined ? withoutHeader(call.headers, version) : call.headers;
  // So too a parent that holds no header parameters (made before calls kept them, or imported).
  const kept = ctx.headerParameters ? sent : withoutHeaderParameters(provider, sent);
  // Matched without what only says how the call signed in (matchHeaders); kept as it was sent.
  const asked = redactHeaderValues(matchedHeaders(provider, kept), ctx.redactions, { kind: 'api', name });
  const unqueried = !judge && ctx.unqueried.has(provider.id);
  // Read as the recording's copy keeps its query: a parameter a redaction rule masked there is masked here too.
  const query = unqueried ? '' : identityQuery(call.search, ctx.redactions, name);
  const request = { method: call.method, path, headers: asked, body: call.exact, query };
  const fingerprint = judge ? judgeFingerprint(request, ctx.redactions, provider, provider.matchPath?.(path), ctx.roundedNumbers).fingerprint : apiFingerprint(ctx, provider, request);
  return { name, matchName, kept, asked, fingerprint, query, unqueried };
}

/**
 * Record: a new model call's start with its request, and its fingerprint in the cache for the next
 * replay to start from, with the dates the request holds (fingerprint-cache.ts).
 */
function recordModelStart(core: SidecarCore, call: ModelCall, callNo: number, tracked: TrackedCall, kept: Record<string, string>, asked: Record<string, string>, unqueried: boolean): void {
  const { ctx, provider, scope, judge, exact: body } = call;
  // The query too, credentials left out: asking the call again (shadowlap decisions) sends it as the
  // agent did, and it is part of the call's identity. Kept empty when there is none, so a replay
  // tells a call that had none from one recorded before calls kept it; not kept when it was matched
  // without one (unqueried), so this run's own replays match it the same way.
  const query = unqueried ? undefined : (credentialFreeQuery(call.search.replace(/^\?/, '')) ?? '');
  // Under the format's provider when it went through a host of another's, that host kept as `via`.
  const meta: CallStartRow['meta'] = { retryCount: call.retryCount, provider: recordedId(provider), ...(provider.format ? { via: provider.id } : {}), fingerprintHeaders: allowedHeaders(kept, provider.fingerprintHeaders), ...(query !== undefined ? { query } : {}), ...(scope ? { scope } : {}), ...(judge?.meta ? { judge: judge.meta } : {}) };
  // As the store will hold it, kept for the run's end (RunContext.records); its request's ref once written.
  const record = ctx.keepStart({ runId: ctx.run.runId, callNo, ...tracked.identity, origin: tracked.origin, effect: null, requestRef: null, meta, at: Date.now() });
  core.writer.write({
    what: `call ${callNo}'s start`,
    of: { runId: ctx.run.runId, part: 'calls' },
    run: () => {
      record.requestRef = storeApiRequest(core.store, body);
      core.store.appendCallStart(record);
    },
    // Still matched on replay, by the fingerprint its row keeps; only its diff has no request to show.
    instead: () => {
      record.requestRef = null;
      core.store.appendCallStart(record);
    },
    failed: (reason, replaced) => {
      if (!replaced) ctx.dropCall(callNo);
      core.storeTrouble(ctx, `store:${callNo}:start`, `Call ${callNo}'s request could not be written to the store (${reason}): ${replaced ? 'the call is kept without it' : 'the call is missing from the recording'}.`);
    },
  });
  // Keyed by what identified it, as the query and headers are: its path as the parent's rules read it.
  const path = redactApiPath(call.path, ctx.redactions, tracked.identity);
  const rules = modelRules({ ids: ctx.rules, clockRef: ctx.clockRef, withoutPrompt: ctx.withoutPrompt, roundedNumbers: ctx.roundedNumbers }, provider, call.method, path, asked, query, judge !== null);
  core.writer.write({
    what: `call ${callNo}'s fingerprint`,
    optional: true,
    run: () => {
      const requestRef = record.requestRef;
      if (requestRef === null) return;
      const marks = judge ? [] : clockMarks([multipartView(apiNumbers(body, ctx.roundedNumbers)), ...queryValues(query), ...Object.values(asked)], ctx.clockRef);
      core.store.cacheFingerprints([{ key: fingerprintKey(rules, requestRef), requestRef, fingerprint: tracked.identity.fingerprint, clock: encodeMarks(marks) }]);
    },
  });
}

/**
 * Serve recorded: a call answered without the network where it has to be. A refused intervention
 * is answered with its reason, a failure `--fail-at` asks for as the provider would fail, and a
 * call the session matched as it was recorded. False when it goes live.
 */
function serveRecorded(core: SidecarCore, call: ModelCall, placed: PlacedCall): boolean {
  const { ctx, res, provider } = call;
  const { callNo, tracked } = placed;
  if (placed.refusal !== undefined) {
    serveRefusal(core, ctx, res, provider, callNo, tracked, placed.refusal);
    return true;
  }
  // Checked after the retry branch and keyed by call number, so every attempt of an injected
  // failure fails. The interesting question is what the agent does when a call cannot succeed;
  // "the retry works" is what an ordinary replay already shows.
  const injected = ctx.session.injectedFailure(callNo);
  if (injected !== undefined) {
    serveInjectedFailure(core, ctx, res, provider, callNo, tracked, injected.status, injected.target);
    return true;
  }
  // Overrides apply to tool results only; for a model call an override decision is served as recorded.
  if (tracked.decision.origin === 'replayed' || tracked.decision.origin === 'overridden') {
    serveReplayed(core, ctx, res, callNo, tracked);
    return true;
  }
  return continueRecordedState(core, call, placed);
}

/**
 * Serve recorded, for a live call that names state the recording left on the provider's side,
 * which the provider keeps only for the account that made it and only for a while. A Responses
 * call that continues a recorded response (responses-state.ts) is sent with the whole conversation
 * it continues instead; one that names a conversation the recording used is refused, since the
 * conversation holds the recorded run's later turns too. A call that names a Gemini cache the
 * recording made, or a file it uploaded (provider-state.ts), is sent with the cache's contents or
 * the file's bytes in its place, and one that reads a file Gemini has deleted is refused. What is
 * sent in place of the agent's request is signed again where AWS signs it; the call's recording
 * keeps the request as the agent sent it. True when it was answered here.
 */
function continueRecordedState(core: SidecarCore, call: ModelCall, placed: PlacedCall): boolean {
  const { ctx, res, provider, judge } = call;
  const { callNo, tracked } = placed;
  if (judge || ctx.offline) return false;
  // From the request as the agent wrote it, so what is sent in its place keeps each of its numbers.
  let body = call.exact;
  const instead: string[] = [];
  const continued = ctx.responses && isResponsesCreate(call.method, call.path, recordedId(provider)) ? ctx.responses.continuation(body) : null;
  if (continued && 'refuse' in continued) {
    serveStateRefusal(core, ctx, res, provider, callNo, tracked, continued.refuse, continued.param);
    return true;
  }
  if (continued?.send === 'whole') {
    body = continued.body;
    instead.push(`the whole conversation in place of previous_response_id ${continued.previous}`);
    const from = continued.from.map((n) => `#${n}`).join(', ');
    ctx.warnOnce(`responses:${continued.previous}`, `call ${callNo} continued ${continued.previous}, a response the recording made, which OpenAI keeps only for the key that made it and only while it keeps it: it was sent with the whole conversation it continues instead, rebuilt from the recorded call${continued.from.length === 1 ? '' : 's'} ${from}.`);
  }
  const rebuilt = ctx.providerState?.rebuild(recordedId(provider), callNo, body);
  if (rebuilt?.refuse) {
    serveStateRefusal(core, ctx, res, provider, callNo, tracked, rebuilt.refuse.why, rebuilt.refuse.param);
    return true;
  }
  for (const note of rebuilt?.notes ?? []) ctx.warnOnce(note.key, note.text);
  if (rebuilt?.body) {
    body = rebuilt.body;
    instead.push('the cache or file the recording made in the request');
  }
  if (!instead.length) return false;
  call.rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  const keyId = signingKeyId(call.headers.authorization);
  if (keyId && keyId !== PLACEHOLDER_AWS_ACCESS_KEY_ID) {
    const signed = resign(core, call.req, call.headers, call.method, call.path, call.search, call.rawBody);
    if ('error' in signed) {
      serveRefusal(core, ctx, res, provider, callNo, tracked, `${instead.join(' and ')}: ${signed.error}`);
      return true;
    }
    call.headers = signed.headers;
  }
  core.log(`run ${ctx.run.runId} call ${callNo}: sent with ${instead.join(' and ')}`);
  return false;
}

/**
 * A Bedrock request an intervention changed, signed again for the host the agent signed it for:
 * the HTTP/2 authority it arrived with, or the host in-process capture names.
 */
function resign(core: SidecarCore, req: IncomingMessage, headers: Record<string, string>, method: string, path: string, search: string, body: Buffer): { headers: Record<string, string> } | { error: string } {
  let host = headers[':authority'];
  if (!host) {
    const raw = req.headers['x-shadowlap-upstream'];
    try {
      host = new URL(String(Array.isArray(raw) ? raw[0] : raw)).host;
    } catch {
      host = headers.host;
    }
  }
  if (!host) return { error: 'the host the request was signed for is unknown' };
  return resignSigV4({ method, path, query: search.replace(/^\?/, ''), headers, body, host }, core.awsCredentials);
}

/**
 * Forward live: the call sent to its provider, or refused where it can't be (liveUpstream), and
 * the answer streamed back as it arrives (relayAnswer). When the agent leaves, the request upstream
 * ends with it, and the attempt is recorded as a retryable disconnect, so its client's retry is
 * the same call. When the provider's connection breaks part way, the agent's breaks there too, as
 * it would without Shadowlap.
 */
async function forwardLive(core: SidecarCore, call: ModelCall, placed: PlacedCall): Promise<void> {
  const upstream = liveUpstream(core, call, placed);
  if (upstream === null) return;
  const { ctx, res, provider, client } = call;
  const { callNo, tracked } = placed;
  const number = beginAttempt(tracked);
  let settled = false;
  const attempt: LiveAttempt = {
    started: Date.now(),
    // The attempt ends for the agent once: when it leaves (its client may retry before the request
    // upstream has ended), or when its answer has.
    settle: (retryable) => {
      if (settled) return;
      settled = true;
      settleAttempt(ctx, callNo, tracked, retryable);
    },
    end: (row) => core.recordEnd(ctx, callNo, tracked.identity, { attempt: number, ...row }),
  };
  client.whenGone(() => attempt.settle(true));
  if (client.gone) {
    attempt.end({ responseRef: null, outcome: 'error', meta: { latencyMs: 0, retryable: true, provider: provider.id, error: clientLeft('before its request was sent') } });
    return;
  }
  let answer: Response;
  try {
    answer = await sendUpstream(core, call, upstream);
  } catch (err) {
    // Its agent has gone and the sidecar has closed: it records and reports nothing (closed).
    if (core.closed) return;
    if (client.gone) {
      // The agent left before the provider answered (its own timeout, say): it saw no answer at all.
      attempt.end({ responseRef: null, outcome: 'error', meta: { latencyMs: Date.now() - attempt.started, retryable: true, provider: provider.id, error: clientLeft('before the response headers') } });
      return;
    }
    // The provider couldn't be reached, or broke the connection before it answered: the agent's
    // connection breaks too, as the provider's would have without Shadowlap, so its client reports
    // a connection error and retries as it would. Recorded as cut short with no answer, which a
    // replay serves the same way; the run's summary says why.
    const message = err instanceof Error ? err.message : String(err);
    breakConnection(res, message);
    attempt.settle(true);
    attempt.end({ responseRef: null, outcome: 'error', meta: { latencyMs: Date.now() - attempt.started, retryable: true, provider: recordedId(provider), error: { name: 'UpstreamConnectionError', message } } });
    const where = originOf(upstream);
    ctx.warnOnce(`unreachable:${where}`, `Call ${callNo} could not reach ${where} (${message}): its connection was closed with no answer, as the provider's would have been.`);
    core.log(`run ${ctx.run.runId} call ${callNo}: ${where} could not be reached: ${message}`);
    return;
  }
  await relayAnswer(core, call, answer, attempt);
}

/**
 * Forward live: where the call goes. An upstream configured here wins (shadowlap test sets
 * "offline"), then the one a captured request names, then the provider's own default; a judge names
 * its own. Null when it can go nowhere, answered and recorded with why: offline, no upstream for its
 * provider, or a placeholder key, which is never sent to any host (a provider, a gateway, a model
 * server or a mock).
 */
function liveUpstream(core: SidecarCore, call: ModelCall, placed: PlacedCall): string | null {
  const { ctx, res, provider } = call;
  const { callNo, tracked } = placed;
  const judging = call.judge?.upstream !== undefined;
  const requested = call.judge?.upstream ?? call.requested;
  const upstream = ctx.offline || call.judge?.offline === true ? 'offline' : ((judging ? requested : undefined) || core.upstreamOf(provider) || requested || provider.upstream).replace(/\/$/, '');
  if (!upstream) {
    const message = `no upstream for ${provider.id}: set ${upstreamVariable(provider)}, or let Shadowlap capture the call in the agent's process`;
    answerOwn(core, ctx, res, callNo, tracked, { status: 400, body: { type: 'error', error: { type: 'shadowlap_no_upstream', message } }, origin: 'refused' }, { error: { name: 'ShadowlapNoUpstream', message } });
    return null;
  }
  if (upstream === 'offline') {
    // `shadowlap test` runs offline: a live call here means the replay diverged, and the run must fail loudly, not spend tokens.
    const message = `shadowlap is offline: call #${callNo} (${tracked.identity.name}) was not served from the recording and would need the network`;
    answerOwn(core, ctx, res, callNo, tracked, { status: 503, body: { type: 'error', error: { type: 'shadowlap_offline', message } }, origin: 'offline' }, { offline: true, error: { name: 'ShadowlapOffline', message } });
    return null;
  }
  if (carriesPlaceholder(call.headers, call.search)) {
    servePlaceholderRefusal(core, ctx, res, provider, callNo, tracked);
    return null;
  }
  return upstream;
}

/**
 * Forward live: the request as the agent sent it, signed headers and all. Its own `accept-encoding`
 * goes as it sent it, since a signed request (AWS SigV4) may sign it, and a compressed answer is
 * decoded for the recording and the agent alike; with none, an uncompressed answer is asked for. A
 * request that arrived over HTTP/2 carries its signed :authority, and leaves the same way. It ends
 * when its agent has gone (ClientWatch).
 */
function sendUpstream(core: SidecarCore, call: ModelCall, upstream: string): Promise<Response> {
  const path = core.upstreamPath(call.provider, upstream, call.path);
  const headers = forwardedHeaders(call.headers);
  headers['accept-encoding'] ??= 'identity';
  const body = call.method === 'GET' || call.method === 'HEAD' ? null : call.rawBody;
  const authority = call.headers[':authority'];
  return authority
    ? core.fetchOverHttp2(upstream.replace(/(https?:\/\/[^/]+).*/, '$1'), `${upstream.replace(/https?:\/\/[^/]+/, '')}${path}${call.search}`, call.method, headers, body, authority, call.client.signal)
    : requestUpstream(upstream + path + call.search, call.method, headers, body, core.upstreamRequests, call.client.signal);
}

/**
 * Forward live: the provider's answer streamed to the agent as it arrives, and recorded as the agent
 * got it. What arrives after the agent left reached nobody and isn't recorded; an answer the
 * provider cut part way reaches the agent as far as it came, then the agent's connection breaks.
 */
async function relayAnswer(core: SidecarCore, call: ModelCall, answer: Response, attempt: LiveAttempt): Promise<void> {
  const { res, provider, client } = call;
  const status = answer.status;
  const responseHeaders: Record<string, string> = {};
  answer.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (RESPONSE_DROP.has(key) || provider.credentialHeaders.includes(key)) return;
    responseHeaders[key] = v;
  });
  const reader = (answer.body as ReadableStream<Uint8Array> | null)?.getReader();
  const timer = new SseTimer(attempt.started);
  const chunks: Buffer[] = [];
  let streamError: SerializedError | undefined;
  // The last write to the agent, so a broken answer reaches it whole before its connection breaks.
  let written: Promise<void> = Promise.resolve();
  try {
    if (!client.gone) {
      res.writeHead(status, { ...responseHeaders, 'x-shadowlap-origin': 'live' });
      res.flushHeaders();
    }
  } catch (err) {
    // Headers no response can carry: the provider's answer can't be passed on, so it is none.
    streamError = { name: 'UpstreamResponseError', message: err instanceof Error ? err.message : String(err) };
  }
  if (reader && !streamError) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || client.gone) break;
        const buf = Buffer.from(value);
        chunks.push(buf);
        timer.push(buf);
        written = new Promise((resolve) => res.write(buf, () => resolve()));
      }
    } catch (err) {
      // A read that fails because the agent left is the agent leaving, not the provider failing.
      if (!client.gone) streamError = { name: 'UpstreamStreamError', message: err instanceof Error ? err.message : String(err) };
    }
  }
  if (client.gone) {
    await reader?.cancel().catch(() => {});
    res.destroy();
  } else if (streamError) {
    await reader?.cancel().catch(() => {});
    await settledWithin(written, 2_000);
    breakConnection(res, streamError.message);
  } else res.end();
  // Its agent has gone and the sidecar has closed: it records and reports nothing (closed).
  if (core.closed) return;

  const bytes = Buffer.concat(chunks);
  const gone = client.gone;
  const contentType = responseHeaders['content-type'];
  const retryable = gone || streamError !== undefined || provider.isRetryableStatus(status);
  const outcome = status < 400 && !streamError && !gone ? 'ok' : 'error';
  attempt.settle(outcome === 'error' && retryable);
  const meta: CallStartRow['meta'] = { status, headers: credentialFreeHeaders(responseHeaders), latencyMs: Date.now() - attempt.started, retryable, bytes: bytes.length, provider: recordedId(provider) };
  // An upstream that asks another model than the request names says which (`shadowlap tasks score`'s takeover).
  // Read after the answer is sent, as usage is: a path or body it can't read never costs the call its end.
  const requestedModel = responseHeaders['x-shadowlap-model'] || readQuietly(() => provider.extractModel(call.path, call.body, call.headers));
  if (requestedModel) meta.model = requestedModel;
  const usage = readQuietly(() => provider.extractUsage(bytes, contentType));
  if (usage) meta.usage = usage;
  const stopReason = outcome === 'ok' ? readQuietly(() => provider.extractStopReason(bytes, contentType)) : null;
  if (stopReason) meta.stopReason = stopReason;
  if (timer.events.length) meta.chunks = timer.events;
  if (streamError) meta.error = streamError;
  if (gone) meta.error = clientLeft('before the response completed');
  attempt.end({ response: bytes, outcome, meta });
}

/** Headers without one of them. */
function withoutHeader(headers: Readonly<Record<string, string>>, name: string): Record<string, string> {
  const { [name]: _left, ...rest } = headers;
  return rest;
}

/** Waits for `p`, or `ms` at most, without keeping the process alive for it. */
function settledWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

/** What reading an answer finds, or null when the answer doesn't read as the provider's (a usage, a stop reason). */
function readQuietly<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
