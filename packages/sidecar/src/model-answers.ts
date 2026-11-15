/**
 * A model call answered without its provider, and recorded as the agent got the answer: from the
 * recording (serveReplayed), with a failure `--fail-at` asks for (serveInjectedFailure), or with an
 * answer of the sidecar's own that says why the call was not sent (serveRefusal, serveStateRefusal,
 * servePlaceholderRefusal), in the provider's own error shape so its client shows the reason.
 */
import type { ServerResponse } from 'node:http';
import { placeholderRefusal } from './placeholders.js';
import { awsErrorType, type CallMeta, type CallRecord, type CallEndRow, type SerializedError } from '@shadowlap/engine';
import { breakAsRecorded, jsonBytes, providerError, RESPONSE_DROP, sendOwn, type OwnAnswer } from './answers.js';
import { recordedId, type AttemptEnd, type SidecarCore } from './core.js';
import type { Provider } from './providers.js';
import { beginAttempt, settleAttempt, type RunContext, type TrackedCall } from './run-context.js';

/** A recorded model answer's headers as a replay serves them: without what RESPONSE_DROP leaves out of a live one. */
function servedHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (!RESPONSE_DROP.has(k.toLowerCase())) out[k] = v;
  return out;
}

/**
 * Answers a model call with an answer of the sidecar's own instead of the provider's (sendOwn), and
 * records the attempt with it as the agent got it: its bytes, its status and its headers, so a
 * replay of the run serves the very same answer.
 */
export function answerOwn(core: SidecarCore, ctx: RunContext, res: ServerResponse, callNo: number, tracked: TrackedCall, own: OwnAnswer, meta: Omit<CallMeta, 'status' | 'headers' | 'retryable' | 'bytes'>, retryable = false): void {
  const attempt = beginAttempt(tracked);
  const sent = sendOwn(res, own);
  endAttempt(core, ctx, callNo, tracked, { attempt, response: sent.bytes, outcome: 'error', meta: { status: own.status, headers: sent.headers, retryable, bytes: sent.bytes.length, latencyMs: 0, ...meta } }, retryable);
}

/** An attempt that ended as it was answered: settled and recorded. */
function endAttempt(core: SidecarCore, ctx: RunContext, callNo: number, tracked: TrackedCall, end: AttemptEnd, retryable: boolean): void {
  settleAttempt(ctx, callNo, tracked, retryable);
  core.recordEnd(ctx, callNo, tracked.identity, end);
}

/**
 * Answers a model call an intervention could not be applied to, with the reason, instead of
 * sending it as the agent wrote it: a fork that silently isn't one is worse than an error.
 */
export function serveRefusal(core: SidecarCore, ctx: RunContext, res: ServerResponse, provider: Provider, callNo: number, tracked: TrackedCall, reason: string): void {
  const message = `shadowlap could not apply ${reason}`;
  // In the provider's own error shape, so its client shows the reason: AWS clients read a top-level
  // message and the error type from a header; the others read error.message.
  const error: SerializedError = { name: 'ShadowlapInterventionRefused', message };
  answerOwn(core, ctx, res, callNo, tracked, providerError(provider, 400, 'shadowlap_intervention_refused', message, 'refused'), { refused: true, error });
  ctx.warnOnce(`refused:${reason}`, `Not applied: ${reason}. Call ${callNo} was answered with that reason instead of being sent.`);
  core.log(`run ${ctx.run.runId} call ${callNo}: refused ${reason}`);
}

/**
 * Answers a live call that would read state the recording left on the provider's side (a recorded
 * Responses conversation, a file Gemini has deleted) instead of sending it: in the provider's error
 * shape, OpenAI's naming the request's field, so its client raises its bad-request error with the
 * reason; the run's summary says so too.
 */
export function serveStateRefusal(core: SidecarCore, ctx: RunContext, res: ServerResponse, provider: Provider, callNo: number, tracked: TrackedCall, why: string, param: string): void {
  const message = `shadowlap did not send this call: ${why}`;
  const error: SerializedError = { name: 'ShadowlapRecordedState', message };
  const format = recordedId(provider);
  const body = format === 'gemini' ? { error: { code: 400, message, status: 'FAILED_PRECONDITION' } } : format === 'anthropic' ? { type: 'error', error: { type: 'invalid_request_error', message } } : { error: { message, type: 'invalid_request_error', param, code: 'shadowlap_recorded_state' } };
  answerOwn(core, ctx, res, callNo, tracked, { status: 400, body, origin: 'refused' }, { refused: true, error });
  ctx.warnOnce(`state:${why}`, `Call ${callNo} was not sent: ${why}`);
  core.log(`run ${ctx.run.runId} call ${callNo}: refused, it would read state the recording left on ${provider.id}'s side`);
}

/**
 * Answers a live call that carries a placeholder key instead of sending it: a placeholder only gets
 * a replay's client to send what the recording answers. In the provider's own error shape, as a
 * refused key arrives (AWS's for Bedrock), so its client shows the line; the run's summary counts
 * the call as refused, not as an upstream request, and prints the line under the fork.
 */
export function servePlaceholderRefusal(core: SidecarCore, ctx: RunContext, res: ServerResponse, provider: Provider, callNo: number, tracked: TrackedCall): void {
  const message = placeholderRefusal(provider.keys?.set ?? `a key for ${provider.id}`);
  const error: SerializedError = { name: 'ShadowlapPlaceholderKey', message };
  answerOwn(core, ctx, res, callNo, tracked, providerError(provider, 401, 'shadowlap_placeholder_key', message, 'refused'), { refused: true, error });
  ctx.warnOnce(`placeholder:${provider.id}`, message);
  core.log(`run ${ctx.run.runId} call ${callNo}: not sent, it carries a placeholder key`);
}

/**
 * Serves a call as it was recorded. An answer that was cut part way (the provider's connection
 * broke, or the agent left) is cut where it was, so the agent sees what it saw then: what arrived,
 * then a connection that breaks; with no answer at all (a provider that couldn't be reached), a
 * connection that closes before one. Where the agent left (its own timeout), the connection is held
 * as long as it waited then before it breaks (breakAsRecorded). An answer of the sidecar's own that
 * an earlier version recorded without its bytes or headers is served as that version sent it
 * (earlierOwnAnswer).
 */
export function serveReplayed(core: SidecarCore, ctx: RunContext, res: ServerResponse, callNo: number, tracked: TrackedCall): void {
  if (tracked.decision.origin !== 'replayed' && tracked.decision.origin !== 'overridden') return;
  const record = tracked.decision.record;
  const end = record.end!;
  const earlier = earlierOwnAnswer(record);
  const bytes = end.responseRef ? (core.store.getBlob(end.responseRef) ?? Buffer.alloc(0)) : (earlier?.bytes ?? Buffer.alloc(0));
  const headers = servedHeaders(end.meta.headers ?? earlier?.headers ?? {});
  const status = end.meta.status ?? 200;
  const started = Date.now();
  const attempt = beginAttempt(tracked);
  if (!cutShort(end)) {
    res.writeHead(status, { ...headers, 'content-length': String(bytes.length), 'x-shadowlap-origin': 'replayed' });
    res.end(bytes);
  } else if (end.meta.status === undefined) {
    breakAsRecorded(res, end.meta, started, end.meta.error?.message ?? 'no answer came');
  } else {
    res.writeHead(status, { ...headers, 'x-shadowlap-origin': 'replayed' });
    res.flushHeaders();
    const broken = () => breakAsRecorded(res, end.meta, started, end.meta.error?.message ?? 'the answer was cut short');
    if (bytes.length) res.write(bytes, broken);
    else setImmediate(broken);
  }
  // A recorded retryable failure is served as-is; the client's retry gets the same answer.
  endAttempt(core, ctx, callNo, tracked, { attempt, responseRef: end.responseRef, outcome: end.outcome, meta: { ...end.meta, replayedFrom: record.callNo, latencyMs: 0 } }, end.outcome === 'error' && end.meta.retryable === true);
}

/**
 * Answers a model call with a failure shadowlap produced, for `--fail-at`. Nothing leaves the
 * machine. The body names shadowlap as the source and the call is stored with `injected`, so
 * neither the agent's error nor the recording can be mistaken for something the provider did.
 */
export function serveInjectedFailure(core: SidecarCore, ctx: RunContext, res: ServerResponse, provider: Provider, callNo: number, tracked: TrackedCall, status: number, target: number): void {
  const message = `injected failure: HTTP ${status} (shadowlap --fail-at ${target}=${status})`;
  // In the provider's own error shape, as a real failure arrives: AWS clients read a top-level
  // message and the error's type from a header, and branch on that type (ThrottlingException).
  const own = providerError(provider, status, 'shadowlap_injected', message, 'injected');
  const error = { name: 'ShadowlapInjectedFailure', message };
  // Retryable by the provider's own rule, so the client's retry logic runs — and fails again.
  answerOwn(core, ctx, res, callNo, tracked, own, { injected: true, error, provider: recordedId(provider) }, provider.isRetryableStatus(status));
  core.log(`run ${ctx.run.runId} call ${callNo}: injected HTTP ${status}`);
}

/**
 * Whether a recorded answer stopped part way, or never came: its provider's connection broke, its
 * agent left before it was whole, or its provider couldn't be reached at all (an earlier version
 * answered that last with a 502 of its own, which it recorded with the status).
 */
function cutShort(end: CallEndRow): boolean {
  const name = end.meta.error?.name;
  return end.outcome === 'error' && (name === 'UpstreamStreamError' || name === 'ClientDisconnected' || (name === 'UpstreamConnectionError' && end.meta.status === undefined));
}

/** The error types an earlier sidecar's answers of its own carried, by the error it recorded with them. */
const EARLIER_OWN = new Map([
  ['UpstreamConnectionError', 'shadowlap_upstream_error'],
  ['ShadowlapNoUpstream', 'shadowlap_no_upstream'],
  ['ShadowlapOffline', 'shadowlap_offline'],
]);

/**
 * An answer of its own that an earlier sidecar recorded without what a replay needs to send it
 * again: a 502 for a provider it couldn't reach, a 400 for no upstream and a 503 offline, kept
 * without their bytes, which are written again from the error each kept, as that version sent them;
 * and its refusals and injected failures, kept without their headers: JSON, and for Bedrock the
 * error type AWS clients read. Null for any other answer.
 */
function earlierOwnAnswer(record: CallRecord): { bytes: Buffer | null; headers: Record<string, string> } | null {
  const end = record.end;
  if (!end || end.outcome !== 'error' || end.meta.headers || end.meta.status === undefined) return null;
  const error = end.meta.error;
  const type = error ? EARLIER_OWN.get(error.name) : undefined;
  if (!end.responseRef && type) return { bytes: jsonBytes({ type: 'error', error: { type, message: error!.message } }), headers: { 'content-type': 'application/json' } };
  if (!end.responseRef || !(end.meta.refused || end.meta.injected)) return null;
  const aws = record.meta.provider === 'bedrock' || end.meta.provider === 'bedrock';
  return { bytes: null, headers: { 'content-type': 'application/json', ...(aws ? { 'x-amzn-errortype': awsErrorType(end.meta.status) } : {}) } };
}
