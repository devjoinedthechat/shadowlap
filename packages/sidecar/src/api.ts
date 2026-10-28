/**
 * The session's API under /v1/, behind the session token: health, a run's start and end, the SDKs'
 * call resolution and completion, and what the preloads and the network guard say. A host's own
 * routes (SidecarOptions.api) come after these.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { asParsed, type ReplayOptions, type RunStatus, type ToolFailure } from '@shadowlap/engine';
import { HttpError, json } from './answers.js';
import type { SidecarCore } from './core.js';
import type { Interventions } from './interventions.js';
import { endRun, envFor, startRun, type StartRunInput } from './lifecycle.js';
import { MAX_HELLOS, mergeHello, parseHello, parseSdkHeader, sdkMismatch } from './preloads.js';
import { headerValue, readJson } from './requests.js';
import type { RunContext } from './run-context.js';
import { completeCall, resolveCall, type CompleteBody, type ResolveBody } from './tool-calls.js';

export async function handleApi(core: SidecarCore, req: IncomingMessage, res: ServerResponse, rest: string, url: URL, pinned?: string): Promise<void> {
  const method = req.method ?? 'GET';
  if (rest === 'v1/health' && method === 'GET') return json(res, 200, { ok: true, activeRun: core.activeRunId });

  if (rest === 'v1/runs' && method === 'POST') {
    type StartBody = Partial<StartRunInput> & {
      replay?: Partial<ReplayOptions> & { liveTools?: string[]; overrides?: Record<string, unknown>; failAt?: Record<string, number>; toolFailures?: Record<string, ToolFailure>; plants?: Record<string, string> };
      interventions?: Interventions;
    };
    // Read as JSON.parse reads it, but for the results an override gives: each of their numbers as
    // the SDK wrote it, an id past 2^53 by its digits, as the CLI's --override keeps them.
    const exact = (await readJson(req, true)) as StartBody;
    const body = asParsed(exact) as StartBody;
    if (body.replay && exact.replay?.overrides) body.replay.overrides = exact.replay.overrides;
    if (body.mode !== 'record' && body.mode !== 'replay') throw new HttpError(400, 'mode must be record or replay');
    // Maps keyed by call number arrive as JSON objects.
    const byCall = <T>(o: Record<string, T> | undefined) => (o && typeof o === 'object' ? new Map(Object.entries(o).map(([k, v]) => [Number(k), v] as const)) : undefined);
    const replay = body.replay
      ? {
          ...body.replay,
          ...(body.replay.liveTools ? { liveTools: new Set(body.replay.liveTools) } : {}),
          ...(body.replay.overrides ? { overrides: byCall(body.replay.overrides)! } : {}),
          ...(body.replay.failAt ? { failAt: byCall(body.replay.failAt)! } : {}),
          ...(body.replay.toolFailures ? { toolFailures: byCall(body.replay.toolFailures)! } : {}),
          ...(body.replay.plants ? { plants: byCall(body.replay.plants)! } : {}),
        }
      : undefined;
    const run = startRun(core, {
      mode: body.mode,
      ...(body.parentRunId ? { parentRunId: body.parentRunId } : {}),
      command: body.command ?? { argv: [], cwd: '' },
      // A command a program sends is the token holder's choice: replaying the run asks first.
      ...(body.command?.argv?.length ? { meta: { commandFromClient: true } } : {}),
      codeVersion: body.codeVersion ?? null,
      ...(replay ? { replay: replay } : {}),
      ...(body.interventions ? { interventions: body.interventions } : {}),
    });
    return json(res, 201, { run, env: envFor(core, run.runId) });
  }

  const endMatch = /^v1\/runs\/([^/]+)\/end$/.exec(rest);
  if (endMatch && method === 'POST') {
    const body = (await readJson(req)) as { status?: RunStatus };
    const status = body.status && body.status !== 'running' ? body.status : 'completed';
    return json(res, 200, endRun(core, decodeURIComponent(endMatch[1]!), status));
  }

  if (rest === 'v1/calls/resolve' && method === 'POST') {
    // Numbers kept as the SDK wrote them: a 64-bit id or a Python 20.0 is stored and served exactly.
    const body = (await readJson(req, true)) as ResolveBody;
    const ctx = core.contextFor(req, pinned);
    noteSdk(ctx, req);
    const { scope } = core.callScope(req, ctx, 'tool');
    ctx.sdksSeen.add(sdkFamily(headerValue(req, 'x-shadowlap-sdk'), req.headers['user-agent']));
    return json(res, 200, resolveCall(core, ctx, body, scope));
  }

  // A preload says it loaded in one of the agent's processes, once per process (preloads.ts).
  if (rest === 'v1/hello' && method === 'POST') {
    const hello = parseHello(await readJson(req));
    const ctx = core.contextFor(req, pinned);
    noteSdk(ctx, req);
    if (hello) {
      const key = `${hello.runtime}:${hello.pid}`;
      // A process says hello again for each query it starts: what each said holds (mergeHello).
      const prev = ctx.hellos.get(key);
      if (prev) ctx.hellos.set(key, mergeHello(prev, hello));
      else if (ctx.hellos.size < MAX_HELLOS) ctx.hellos.set(key, hello);
      else ctx.hellosBeyond.set(hello.runtime, (ctx.hellosBeyond.get(hello.runtime) ?? 0) + 1);
    }
    return json(res, 202, { ok: true });
  }

  if (rest === 'v1/guard' && method === 'POST') {
    const body = (await readJson(req)) as { target?: unknown; action?: unknown };
    const ctx = core.contextFor(req, pinned);
    const target = typeof body.target === 'string' ? body.target.slice(0, 300) : '';
    if (target) {
      const action = body.action === 'blocked' ? 'blocked' : 'warned';
      const prev = ctx.unguarded.get(target);
      ctx.unguarded.set(target, { count: (prev?.count ?? 0) + 1, action: prev?.action === 'blocked' ? 'blocked' : action });
    }
    return json(res, 202, { ok: true });
  }

  const completeMatch = /^v1\/calls\/(\d+)\/complete$/.exec(rest);
  if (completeMatch && method === 'POST') {
    const body = (await readJson(req, true)) as CompleteBody;
    const ctx = core.contextFor(req, pinned);
    noteSdk(ctx, req);
    completeCall(core, ctx, Number(completeMatch[1]), body);
    return json(res, 200, { ok: true });
  }

  if (core.api) {
    const handled = await core.api({ method, path: rest, body: () => readJson(req) });
    if (handled) return json(res, handled.status, handled.body);
  }
  throw new HttpError(404, `unknown API route ${method} ${url.pathname}`);
}

/** An SDK whose major.minor differs from this CLI's, named once per run and SDK (`x-shadowlap-sdk`). */
function noteSdk(ctx: RunContext, req: IncomingMessage): void {
  const sdk = parseSdkHeader(headerValue(req, 'x-shadowlap-sdk'));
  if (!sdk) return;
  const key = `${sdk.family}/${sdk.majorMinor}`;
  if (ctx.sdkWarned.has(key) || ctx.sdkWarned.size >= 16) return;
  ctx.sdkWarned.add(key);
  const line = sdkMismatch(`${sdk.family}/${sdk.version}`);
  if (line) ctx.warnings.push(line);
}

/**
 * Coarse SDK language, only ever used as a telemetry category: from the `x-shadowlap-sdk` header
 * both SDKs send on every call (`node/0.1.0`, `python/0.1.0`), else from the user agent, which the
 * MCP proxy names itself in and the Node SDK sends none of.
 */
function sdkFamily(sdkHeader: string | undefined, userAgent: string | undefined): string {
  const family = parseSdkHeader(sdkHeader)?.family;
  if (family === 'node') return 'typescript';
  if (family === 'python') return 'python';
  const ua = (userAgent ?? '').toLowerCase();
  if (ua.includes('shadowlap-mcp')) return 'mcp';
  if (ua.includes('python')) return 'python';
  if (ua.includes('node') || ua.includes('undici') || ua.includes('bun') || ua.includes('deno')) return 'typescript';
  return 'other';
}
