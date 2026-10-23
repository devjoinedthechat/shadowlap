/**
 * Paths under a provider's API that carry an SDK's own telemetry, not a model call: the OpenAI Agents
 * SDK's trace export (Python and TypeScript), which posts to `api.openai.com/v1/traces/ingest` by
 * default with new random ids and times every run. Nothing there is the agent's behaviour, and
 * nothing a replay could match, so the sidecar passes it on while recording and records nothing of
 * it, and a replay answers it with 204 itself (server.ts, serveTelemetry).
 */
const TELEMETRY: Readonly<Record<string, RegExp>> = {
  openai: /^\/v1\/traces\/ingest\/?$/,
};

/** Whether a request to `provider` at `path` (as the provider's API names it) is telemetry. */
export function isTelemetry(provider: string, path: string): boolean {
  return TELEMETRY[provider]?.test(path) ?? false;
}
