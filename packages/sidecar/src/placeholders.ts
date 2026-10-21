/**
 * What an offline replay gives an agent for a key it has none of. The official SDKs refuse to send a
 * request without a key (`new OpenAI()` throws as it is built), even one the recording answers, so
 * `shadowlap replay`, `test` and `calibrate` set one of these where the environment has no key for a
 * provider the recording called. One never leaves this machine: a call past a fork that would take it
 * to another host is answered with why instead (Sidecar's forward).
 */
export const REPLAY_KEY = 'shadowlap-offline-replay-placeholder';

/** The AWS access key id an offline replay of a run with Bedrock calls gets: the SDK signs it into each request's Authorization. */
export const REPLAY_AWS_KEY_ID = 'SHADOWLAPREPLAY';

/** Whether a request carries a placeholder: in one of its provider's credential headers, or in its query (Gemini's `?key=`). */
export function carriesPlaceholder(headers: Readonly<Record<string, string>>, credentialHeaders: readonly string[], search: string): boolean {
  for (const name of credentialHeaders) {
    const value = headers[name];
    if (value && (value.includes(REPLAY_KEY) || value.includes(`Credential=${REPLAY_AWS_KEY_ID}/`))) return true;
  }
  return search.includes(REPLAY_KEY);
}

/** An upstream's host and port, as a message names it: `api.anthropic.com`, `127.0.0.1:11434`. */
export function hostOf(upstream: string): string {
  try {
    return new URL(upstream).host;
  } catch {
    return upstream;
  }
}

/** Whether an upstream is on this machine (a mock, a local model server): a loopback address or localhost. */
export function onThisMachine(upstream: string): boolean {
  let host: string;
  try {
    host = new URL(upstream).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}
