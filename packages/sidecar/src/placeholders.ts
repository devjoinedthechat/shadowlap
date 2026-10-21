import { signingKeyId } from './sigv4.js';

/**
 * Placeholder keys. A model client built the default way takes its key from the environment and
 * refuses to send a request without one, even a request Shadowlap answers from a recording. So a
 * replay gives the agent a placeholder for each provider its recording called when the environment
 * has no credential for it (the CLI decides which replays, and which providers, in
 * placeholder-keys.ts), and the sidecar never sends a request that carries one, to any host: a
 * provider, a gateway, a model server or a mock. A live call needs a real key.
 */

/** The value every placeholder key holds: recognisable in a request, and never a provider's key. */
export const PLACEHOLDER_KEY = 'shadowlap-offline-replay-placeholder';

/** The access key id of placeholder AWS credentials, which a SigV4 signature names in the clear. */
export const PLACEHOLDER_AWS_ACCESS_KEY_ID = 'SHADOWLAPREPLAY';

/** An AWS credential scope made with the placeholder access key: `Credential=SHADOWLAPREPLAY/20261021/…`. */
const PLACEHOLDER_SCOPE = `${PLACEHOLDER_AWS_ACCESS_KEY_ID}/`;

/**
 * Whether a request carries a placeholder key, wherever it put it: in any header (an API key header,
 * a bearer token, a key a vector store passes on, an AWS signature made with the placeholder access
 * key) or in any query value (Gemini's `?key=`, a presigned AWS credential).
 */
export function carriesPlaceholder(headers: Readonly<Record<string, string | string[] | undefined>>, search: string): boolean {
  for (const [name, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v !== 'string') continue;
      if (v.includes(PLACEHOLDER_KEY) || v.includes(`Credential=${PLACEHOLDER_SCOPE}`)) return true;
      if (name.toLowerCase() === 'authorization' && signingKeyId(v) === PLACEHOLDER_AWS_ACCESS_KEY_ID) return true;
    }
  }
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (!query) return false;
  for (const v of new URLSearchParams(query).values()) if (v.includes(PLACEHOLDER_KEY) || v.startsWith(PLACEHOLDER_SCOPE)) return true;
  return false;
}

/**
 * What a live call that would carry a placeholder is answered with, in one line: `set` names the
 * variable to set (`ANTHROPIC_API_KEY`), and `call` the call when it isn't a provider's.
 */
export function placeholderRefusal(set: string, call?: string): string {
  return `${call ? `${call}: ` : ''}a live call needs a real key: set ${set}, or keep the replay offline`;
}
