/**
 * What an offline replay gives an agent for a key it has none of. The official SDKs refuse to send a
 * request without a key (`new OpenAI()` throws as it is built), even one the recording answers, so
 * `shadowlap replay`, `test` and `calibrate` set one of these where the environment has no key for a
 * provider the recording called. The sidecar never sends one to a provider's API: a call past a fork
 * that would go there with it is answered with why instead (Sidecar's forward).
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
