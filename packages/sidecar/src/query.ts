import { CREDENTIAL_PLACEHOLDER, redactQuery, type Normalizer } from '@shadowlap/engine';

/**
 * A model call's query string as its identity reads it. Every parameter takes part (Gemini's
 * `alt=sse`, Azure's `api-version`, a page cursor), but for those that carry a credential: an API key
 * (Gemini's `?key=`), a token, a signature. A key differs from one machine to the next and is rotated,
 * and a recording never keeps one, so it can't be what makes a call the call it is.
 */

/**
 * Parameter names a recording left out of the query it kept before credentials were read by the
 * engine's `credentialParam` (the sidecar's own list until then): a recording made then never holds
 * them, so a call's identity never counts them either, or a call to it would match none of its calls.
 */
const NEVER_KEPT = /^(key|api[-_]?key|apikey|access[-_]?token|id[-_]?token|token|code|sig|signature|x-amz-.+|x-goog-.+)$/i;

/**
 * The parameters of a query string (with or without `?`) that take part in a model call's identity,
 * URL-encoded in the order they were sent: read as a copy of the run keeps its query (the engine's
 * `redactQuery`), every credential left out (`credentialFreeQuery`) and the rules that redacted the
 * recording applied (`redactions`, for the call named `name`), so a live call matches a redacted
 * pack's call whose parameter a rule masked, the rule's pattern across its name and value included;
 * and without a value a copy masked as a credential (`<CREDENTIAL>`) or a name a recording never
 * kept (`NEVER_KEPT`). Empty when nothing is left. The engine sorts them (`queryPairs`).
 */
export function identityQuery(search: string | undefined, redactions: readonly Normalizer[] = [], name = ''): string {
  if (!search) return '';
  const read = redactQuery(search.startsWith('?') ? search.slice(1) : search, redactions, { kind: 'api', name });
  if (!read) return '';
  const kept = new URLSearchParams();
  for (const [param, value] of new URLSearchParams(read)) {
    if (value === CREDENTIAL_PLACEHOLDER || NEVER_KEPT.test(param)) continue;
    kept.append(param, value);
  }
  return kept.toString();
}
