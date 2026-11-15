/**
 * The SDKs' tool, clock and random calls (`POST /v1/calls/resolve`), in stages as a model call is:
 * route (routeToolCall) checks what a call asks for, resolve (resolveToolCall) works out which call
 * it is and records its start, and serve (serveToolCall) answers it from the recording, with a
 * failure or a result a flag gives, blocked or stubbed, or tells the SDK to run it live. A call the
 * SDK runs ends with completeCall. The record steps (recordToolStart, cacheToolFingerprint) serve the
 * captured HTTP calls too (capture.ts), which are recorded as tools.
 */
import { randomUUID } from 'node:crypto';
import { configuredTrust, fingerprintMisc, fingerprintTool, isRawNumber, matchable, plantInToolResult, refused, reportable, toolFailureError, type CallKind, type CallMeta, type CallStartRow, type Decision, type Effect, type Normalizer, type SerializedError, type ToolFailure } from '@shadowlap/engine';
import { HttpError, jsonBytes } from './answers.js';
import type { SidecarCore } from './core.js';
import { clockMarks, encodeMarks, fingerprintKey, rulesId, toolRules } from './fingerprint-cache.js';
import type { RunContext, TrackedCall } from './run-context.js';

export interface ResolveBody {
  kind: CallKind;
  name: string;
  effect?: Effect;
  args?: unknown;
  label?: string;
  implHash?: string;
  /** The call is a person's input, recorded as the `user_input` tool (see docs/protocol.md). */
  input?: boolean;
  /** The call came through `shadowlap mcp`: from which server, and the tools it offers (see docs/protocol.md). */
  mcp?: unknown;
  /** `untrusted`: the tool brings outside text in, where `shadowlap injection` plants (see docs/protocol.md). */
  trust?: 'trusted' | 'untrusted';
}

export type ResolveResponse =
  | { origin: 'replayed'; callNo: number; outcome: 'ok'; result: unknown }
  /**
   * A recorded error, or (with `injected`) a failure `--fail-at` asked for: the tool doesn't run and
   * the SDK raises a timeout, the given error, or an HTTP-shaped error with the status. A client that
   * doesn't know `injected` raises its replayed-error type with the same name and message.
   */
  | { origin: 'replayed'; callNo: number; outcome: 'error'; error: SerializedError; injected?: ToolFailure }
  | { origin: 'live'; callNo: number; outcome: 'ok'; result: unknown }
  | { origin: 'live'; callNo: number }
  | { origin: 'blocked'; callNo: number; outcome: 'error'; error: SerializedError }
  | { origin: 'stubbed'; callNo: number };

export interface CompleteBody {
  outcome: 'ok' | 'error';
  result?: unknown;
  error?: SerializedError;
  latencyMs?: number;
}

/** A tool, clock or random call as the SDK asked for it (routeToolCall). */
interface ToolCall {
  ctx: RunContext;
  body: ResolveBody;
  scope: string | undefined;
  kind: Exclude<CallKind, 'api'>;
  name: string;
  effect: Effect | null;
  /** What it is stored and matched by: a tool's arguments, or a clock or random read's label. */
  request: { args: unknown } | { label: string };
  /** A person's answer (`user_input`): after a fork it is served from the recording, in order. */
  input: boolean;
}

/** A tool, clock or random call once resolved (resolveToolCall). */
interface PlacedToolCall {
  callNo: number;
  tracked: TrackedCall;
}

/**
 * What the agent gets for a read the replay fenced (`unrecordedReads: 'fence'`, or one carrying
 * planted text): an error, as for a blocked write, so the model hears the read failed and carries on.
 */
export const fencedRead = (what: string) => `${what} was not run: this replay answers only the reads its recording holds`;

/**
 * A tool, clock or random call the SDK resolves, in stages as a model call is: route
 * (`routeToolCall`) checks what it asks for, resolve (`resolveToolCall`) works out which call it is
 * and records its start, and serve (`serveToolCall`) answers it from the recording, with a failure
 * or a result a flag gives, blocked or stubbed, or tells the SDK to run it live. Each answer given
 * here is recorded as the SDK got it (`endToolCall`); a call the SDK runs ends with completeCall.
 */
export function resolveCall(core: SidecarCore, ctx: RunContext, body: ResolveBody, scope?: string): ResolveResponse {
  const call = routeToolCall(ctx, body, scope);
  const placed = resolveToolCall(core, call);
  return serveToolCall(core, call, placed);
}

/**
 * Resolve: which call a tool, clock or random call is, as the session decides it, and its start
 * recorded with what it keeps beside its request: its code's hash, its scope, a person's input, an
 * MCP server's, a read the recording held no counterpart for, and how far its result is trusted.
 */
function resolveToolCall(core: SidecarCore, call: ToolCall): PlacedToolCall {
  const { ctx, body, scope, kind, name, effect, request, input } = call;
  const { fingerprint } = 'args' in request ? fingerprintTool(name, request.args, ctx.normalizers, ctx.clockRef) : fingerprintMisc(kind as 'clock' | 'random', name, request.label);
  // The session diffs requests as plain JSON, with an integer past 2^53 as its digits, as loadRequest reads the recorded side.
  const { callNo, tracked } = ctx.openCall({ kind, name, fingerprint, effect, request: reportable(request), ...(scope ? { scope } : {}), ...(input ? { input } : {}) });
  const { decision } = tracked;
  core.noteDivergence(ctx);

  const meta: CallStartRow['meta'] = {};
  if (body.implHash) meta.implHash = body.implHash;
  if (scope) meta.scope = scope;
  if (input) meta.input = true;
  // A plain read the recording held no counterpart for, answered live while the replay goes on.
  if (decision.origin === 'live' && decision.extra) meta.extraRead = true;
  const mcp = kind === 'tool' ? mcpCallMeta(body.mcp) : undefined;
  if (mcp) meta.mcp = mcp;
  // A tool that brings outside text in, as the config's `tools`, the SDK's `trust` or an MCP
  // server's openWorldHint says. Kept on the call, never in its fingerprint: marking a tool changes no replay.
  if (kind === 'tool') Object.assign(meta, trustMeta(core, name, null, body.trust === 'untrusted' ? (mcp ? 'mcp' : 'sdk') : null));
  const requestRef = recordToolStart(core, ctx, callNo, tracked, request, meta);
  if ('args' in request) cacheToolFingerprint(core, ctx, callNo, { name, normalizers: ctx.normalizers }, false, fingerprint, request.args, requestRef);
  return { callNo, tracked };
}

/** Record: a tool, clock or random call's end, `response` the value to store, or the ref of what is stored already. */
function endToolCall(core: SidecarCore, call: ToolCall, placed: PlacedToolCall, response: { value: unknown } | string | null, outcome: 'ok' | 'error', meta: CallStartRow['meta']): void {
  core.recordEnd(call.ctx, placed.callNo, placed.tracked.identity, { attempt: 0, outcome, meta, ...(response !== null && typeof response === 'object' ? { response: jsonBytes(response.value) } : { responseRef: response }) }, 'result');
  placed.tracked.done = true;
}

/**
 * Serve: the SDK's answer, as the session decided the call, one function for each way it can be
 * decided. A failure `--fail-at` asks for, a result with text planted in it (`--inject-result`) or
 * given in its place (`--override`), and a recorded result are answered here, as are a clock or
 * random value, generated here so the SDK needs no second round trip, whatever the session decided,
 * and a blocked tool. A stubbed or live tool is the SDK's to run.
 */
function serveToolCall(core: SidecarCore, call: ToolCall, placed: PlacedToolCall): ResolveResponse {
  const decision = placed.tracked.decision;
  switch (decision.origin) {
    case 'injected':
      return serveInjectedTool(core, call, placed, decision);
    case 'planted':
      return servePlantedTool(core, call, placed, decision);
    case 'overridden':
      return serveOverriddenTool(core, call, placed, decision);
    case 'replayed':
      return serveReplayedTool(core, call, placed, decision);
    case 'blocked':
      return call.kind === 'tool' ? serveBlockedTool(core, call, placed) : serveValue(core, call, placed);
    case 'stubbed':
      return call.kind === 'tool' ? { origin: 'stubbed', callNo: placed.callNo } : serveValue(core, call, placed);
    case 'live':
      return call.kind === 'tool' ? { origin: 'live', callNo: placed.callNo } : serveValue(core, call, placed);
  }
}

/**
 * A failure `--fail-at` asks for: the tool does not run. Its error is stored as shadowlap's, and the
 * SDK raises it as the kind of failure asked for; a client that predates this raises it as a
 * replayed error.
 */
function serveInjectedTool(core: SidecarCore, call: ToolCall, placed: PlacedToolCall, decision: Extract<Decision, { origin: 'injected' }>): ResolveResponse {
  const { ctx, name } = call;
  const error = toolFailureError(name, decision.failure);
  endToolCall(core, call, placed, { value: { error } }, 'error', { injected: true, failure: decision.failure, error, latencyMs: 0 });
  core.log(`run ${ctx.run.runId} call ${placed.callNo}: injected ${decision.failure.kind} into ${name}`);
  return { origin: 'replayed', callNo: placed.callNo, outcome: 'error', error, injected: decision.failure };
}

/**
 * The recorded result with text planted in it (`--inject-result`), each number as it was recorded,
 * so the agent gets the result with only the text added. A result the text can't go in is served as
 * recorded, and said: the run is a clean replay, not the attack it was asked for.
 */
function servePlantedTool(core: SidecarCore, call: ToolCall, placed: PlacedToolCall, decision: Extract<Decision, { origin: 'planted' }>): ResolveResponse {
  const { ctx } = call;
  const { callNo } = placed;
  const record = decision.record;
  const recorded = record.end!;
  const payload = (recorded.responseRef ? core.getJsonExact<{ result?: unknown; error?: SerializedError }>(recorded.responseRef) : null) ?? {};
  const planted = recorded.outcome === 'ok' ? plantInToolResult(payload.result, decision.text, false) : { refused: 'it failed when it was recorded, so it has no result to add to' };
  if (!refused(planted)) {
    endToolCall(core, call, placed, { value: { result: planted.result } }, 'ok', { overriddenFrom: record.callNo, planted: planted.at, latencyMs: 0 });
    return { origin: 'replayed', callNo, outcome: 'ok', result: planted.result };
  }
  ctx.session.declined(record.callNo);
  ctx.warnOnce(`plant:${record.callNo}`, `--inject-result ${record.callNo} changed nothing: ${planted.refused}`);
  endToolCall(core, call, placed, recorded.responseRef, recorded.outcome, { ...recorded.meta, replayedFrom: record.callNo, latencyMs: 0 });
  if (recorded.outcome === 'ok') return { origin: 'replayed', callNo, outcome: 'ok', result: (recorded.responseRef ? core.getJsonExact<{ result?: unknown }>(recorded.responseRef) : null)?.result };
  return { origin: 'replayed', callNo, outcome: 'error', error: payload.error ?? { name: 'Error', message: 'recorded error' } };
}

/** An `--override` result: the user's substitute stands in for the recording, and the agent builds its next request from it. */
function serveOverriddenTool(core: SidecarCore, call: ToolCall, placed: PlacedToolCall, decision: Extract<Decision, { origin: 'overridden' }>): ResolveResponse {
  endToolCall(core, call, placed, { value: { result: decision.result } }, 'ok', { overriddenFrom: decision.record.callNo, latencyMs: 0 });
  return { origin: 'replayed', callNo: placed.callNo, outcome: 'ok', result: decision.result };
}

/**
 * The recorded result, read with each number as it was recorded, so the SDK gets back exactly what
 * the tool returned; a tool whose code changed since says so, once.
 */
function serveReplayedTool(core: SidecarCore, call: ToolCall, placed: PlacedToolCall, decision: Extract<Decision, { origin: 'replayed' }>): ResolveResponse {
  const { ctx, body, kind, name } = call;
  const { callNo } = placed;
  const record = decision.record;
  const recorded = record.end!;
  const payload = (recorded.responseRef ? core.getJsonExact<{ result?: unknown; error?: SerializedError }>(recorded.responseRef) : null) ?? {};
  if (kind === 'tool' && body.implHash && record.meta.implHash && record.meta.implHash !== body.implHash && !ctx.session.options.liveTools.has(name)) {
    ctx.warnOnce(name, `${name} changed since the recording; pass --live-tool ${name} to run it live`);
  }
  endToolCall(core, call, placed, recorded.responseRef, recorded.outcome, { ...recorded.meta, replayedFrom: record.callNo, latencyMs: 0 });
  if (recorded.outcome === 'ok') return { origin: 'replayed', callNo, outcome: 'ok', result: payload.result };
  return { origin: 'replayed', callNo, outcome: 'error', error: payload.error ?? { name: 'Error', message: 'recorded error' } };
}

/** A blocked tool: a read the replay fences, or a write after the divergence, fails without running. */
function serveBlockedTool(core: SidecarCore, call: ToolCall, placed: PlacedToolCall): ResolveResponse {
  const { name, effect } = call;
  const error: SerializedError = effect === 'read' ? { name: 'ShadowlapReadBlocked', message: fencedRead(`read tool ${name}`) } : { name: 'ShadowlapWriteBlocked', message: `write tool ${name} blocked after divergence (use --writes stub|allow to change this)` };
  endToolCall(core, call, placed, { value: { error } }, 'error', { error });
  return { origin: 'blocked', callNo: placed.callNo, outcome: 'error', error };
}

/** A clock or random value, generated here so the SDK needs no second round trip. */
function serveValue(core: SidecarCore, call: ToolCall, placed: PlacedToolCall): ResolveResponse {
  const result = call.kind === 'clock' ? Date.now() : call.name === 'uuid' ? randomUUID() : Math.random();
  endToolCall(core, call, placed, { value: { result } }, 'ok', {});
  return { origin: 'live', callNo: placed.callNo, outcome: 'ok', result };
}

export function completeCall(core: SidecarCore, ctx: RunContext, callNo: number, body: CompleteBody): void {
  const tracked = ctx.calls.get(callNo);
  if (!tracked) throw new HttpError(404, `unknown call ${callNo}`);
  if (tracked.done) throw new HttpError(409, `call ${callNo} already completed`);
  const outcome = body.outcome === 'error' ? 'error' : 'ok';
  const payload = outcome === 'ok' ? { result: body.result ?? null } : { error: body.error ?? { name: 'Error', message: 'unknown error' } };
  const meta: CallStartRow['meta'] = {};
  const latency = isRawNumber(body.latencyMs) ? Number(body.latencyMs.rawJSON) : body.latencyMs;
  if (typeof latency === 'number') meta.latencyMs = latency;
  if (outcome === 'error' && body.error) meta.error = body.error;
  core.recordEnd(ctx, callNo, tracked.identity, { attempt: 0, response: jsonBytes(payload), outcome, meta }, 'result');
  tracked.done = true;
}

/** Record: a tool call's start with its request (`{ args }`, or a clock or random call's label); the ref its request is stored under, once it is. */
export function recordToolStart(core: SidecarCore, ctx: RunContext, callNo: number, tracked: TrackedCall, request: unknown, meta: CallStartRow['meta']): () => string | null {
  // As the store will hold it, kept for the run's end (RunContext.records); its request's ref once written.
  const record = ctx.keepStart({ runId: ctx.run.runId, callNo, ...tracked.identity, origin: tracked.origin, effect: tracked.effect, requestRef: null, meta, at: Date.now() });
  core.writer.write({
    what: `call ${callNo}'s start`,
    of: { runId: ctx.run.runId, part: 'calls' },
    run: () => {
      record.requestRef = core.store.putJson(request);
      core.store.appendCallStart(record);
    },
    failed: (reason) => {
      ctx.dropCall(callNo);
      core.storeTrouble(ctx, `store:${callNo}:start`, `Call ${callNo} could not be written to the store (${reason}): it is missing from the recording.`);
    },
  });
  return () => record.requestRef;
}

/**
 * Record: a tool call's fingerprint in the cache for the next replay to start from, once its
 * request is stored, with the dates its arguments hold (fingerprint-cache.ts). `matched` is the
 * name and rules it was fingerprinted under; a captured call's arguments were read with a secret's
 * names under the run's rule (RunContext.secretNames).
 */
export function cacheToolFingerprint(core: SidecarCore, ctx: RunContext, callNo: number, matched: { name: string; normalizers: Normalizer[] }, captured: boolean, fingerprint: string, args: unknown, requestRef: () => string | null): void {
  core.writer.write({
    what: `call ${callNo}'s fingerprint`,
    optional: true,
    run: () => {
      const ref = requestRef();
      if (ref === null) return;
      const rules = toolRules(matched.name, matched.normalizers === ctx.normalizers ? ctx.rules.normalizers : rulesId(matched.normalizers), ctx.clockRef !== undefined, captured, ctx.secretNames);
      core.store.cacheFingerprints([{ key: fingerprintKey(rules, ref), requestRef: ref, fingerprint, clock: encodeMarks(clockMarks([matchable(args ?? null)], ctx.clockRef)) }]);
    },
  });
}

/**
 * A tool call's trust, as its start row keeps it: the config's word for its name or host, either
 * way, else `untrusted` from `declared` (the SDK's `trust`, an MCP server's openWorldHint), else nothing.
 */
export function trustMeta(core: SidecarCore, name: string, host: string | null, declared: 'sdk' | 'mcp' | null): Pick<CallMeta, 'trust' | 'trustFrom'> {
  const configured = configuredTrust(core.trust, name, host);
  if (configured) return { trust: configured, trustFrom: 'config' };
  return declared ? { trust: 'untrusted', trustFrom: declared } : {};
}

/**
 * Route: what a tool, clock or random call asks for, checked: its kind, a name, and a tool's declared
 * effect. Refused with 400 when it doesn't say.
 */
function routeToolCall(ctx: RunContext, body: ResolveBody, scope: string | undefined): ToolCall {
  const kind = body.kind;
  if (kind !== 'tool' && kind !== 'clock' && kind !== 'random') throw new HttpError(400, `bad kind ${String(kind)}`);
  if (typeof body.name !== 'string' || !body.name) throw new HttpError(400, 'name is required');
  const effect: Effect | null = kind === 'tool' ? (body.effect ?? null) : null;
  if (kind === 'tool' && effect !== 'pure' && effect !== 'read' && effect !== 'write') throw new HttpError(400, `tool ${body.name} must declare effect pure|read|write`);
  return { ctx, body, scope, kind, name: body.name, effect, request: kind === 'tool' ? { args: body.args ?? null } : { label: body.label ?? '' }, input: kind === 'tool' && body.input === true };
}

/** `mcp` from a resolve body, checked and bounded, as call meta; undefined when it isn't one. */
function mcpCallMeta(raw: unknown): CallMeta['mcp'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { transport, server, tools } = raw as Record<string, unknown>;
  if ((transport !== 'stdio' && transport !== 'http') || typeof server !== 'string' || !server) return undefined;
  const text = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  const listed = Array.isArray(tools)
    ? (tools as unknown[])
        .slice(0, 1000)
        .filter((t): t is { name: string; effect: Effect; trust?: unknown } => {
          const tool = t as { name?: unknown; effect?: unknown } | null;
          return typeof t === 'object' && tool !== null && typeof tool.name === 'string' && (tool.effect === 'pure' || tool.effect === 'read' || tool.effect === 'write');
        })
        .map((t) => ({ name: text(t.name), effect: t.effect, ...(t.trust === 'untrusted' ? { trust: 'untrusted' as const } : {}) }))
    : undefined;
  return { transport, server: text(server), ...(listed ? { tools: listed } : {}) };
}
