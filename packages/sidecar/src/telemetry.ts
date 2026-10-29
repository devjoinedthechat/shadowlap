/**
 * Paths under a provider's API that carry an SDK's own telemetry, not a model call: the OpenAI Agents
 * SDK's trace export (Python and TypeScript), which posts to `api.openai.com/v1/traces/ingest` by
 * default with new random ids and times every run. Nothing there is the agent's behaviour, and
 * nothing a replay could match, so the sidecar passes it on while recording and records nothing of
 * it, and a replay answers it with 204 itself (serveTelemetry, below).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { messageOf } from '@shadowlap/engine';
import { breakConnection, RESPONSE_DROP, type ClientWatch } from './answers.js';
import type { SidecarCore } from './core.js';
import type { Provider } from './providers.js';
import { carriesPlaceholder } from './placeholders.js';
import { forwardedHeaders, lowerHeaders, originOf, readBody } from './requests.js';
import type { RunContext } from './run-context.js';
import { requestUpstream } from './upstream.js';

const TELEMETRY: Readonly<Record<string, RegExp>> = {
  openai: /^\/v1\/traces\/ingest\/?$/,
};

/** Whether a request to `provider` at `path` (as the provider's API names it) is telemetry. */
export function isTelemetry(provider: string, path: string): boolean {
  return TELEMETRY[provider]?.test(path) ?? false;
}

/**
 * An SDK's own telemetry under a provider (the OpenAI Agents SDK's trace export): no model call,
 * and nothing a replay could match, since every export names new random ids and times. While
 * recording it goes on as the agent sent it, and nothing of it is recorded or counted: to the host
 * the agent addressed it to, when in-process capture names one its provider vouches for, before an
 * upstream set for the provider's model calls (a local model server holds no traces), else as the
 * provider's calls go. A replay answers it with 204 itself, so a replay's traces never reach the
 * provider, and so does a store that may not reach the network ("offline").
 */
export async function serveTelemetry(core: SidecarCore, ctx: RunContext, req: IncomingMessage, res: ServerResponse, provider: Provider, path: string, search: string, client: ClientWatch): Promise<void> {
  let rawBody: Buffer;
  try {
    rawBody = await readBody(req);
  } catch {
    return;
  }
  const headers = lowerHeaders(req.headers);
  const configured = core.upstreamOf(provider);
  const live = ctx.run.mode === 'record' && !ctx.offline && !ctx.judgeOnly && configured !== 'offline';
  const upstream = live ? (core.vouchedUpstream(req, provider) || configured || provider.upstream).replace(/\/$/, '') : '';
  if (client.gone) return;
  if (!upstream || carriesPlaceholder(headers, search)) {
    res.writeHead(204, { 'x-shadowlap-origin': 'telemetry' });
    res.end();
    return;
  }
  const method = (req.method ?? 'POST').toUpperCase();
  let answer: Response;
  let bytes: Buffer;
  try {
    answer = await requestUpstream(`${upstream}${core.upstreamPath(provider, upstream, path)}${search}`, method, forwardedHeaders(headers), method === 'GET' || method === 'HEAD' ? null : rawBody, core.upstreamRequests, client.signal);
    bytes = Buffer.from(await answer.arrayBuffer());
  } catch (err) {
    if (client.gone || core.closed) return;
    // Its connection breaks as the host's did, as for a model call.
    const message = messageOf(err);
    core.log(`run ${ctx.run.runId}: telemetry to ${originOf(upstream)} failed: ${message}`);
    breakConnection(res, message);
    return;
  }
  const out: Record<string, string> = {};
  answer.headers.forEach((v, k) => {
    if (!RESPONSE_DROP.has(k) && !provider.credentialHeaders.includes(k)) out[k] = v;
  });
  const empty = answer.status === 204 || answer.status === 304;
  res.writeHead(answer.status, { ...out, ...(empty ? {} : { 'content-length': String(bytes.length) }), 'x-shadowlap-origin': 'telemetry' });
  res.end(empty ? undefined : bytes);
}
