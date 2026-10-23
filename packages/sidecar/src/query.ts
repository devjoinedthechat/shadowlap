import { CREDENTIAL_PLACEHOLDER, credentialParam } from './http.js';

/**
 * A model call's query string as its identity reads it. Every parameter takes part (Gemini's
 * `alt=sse`, Azure's `api-version`, a page cursor), but for those that carry a credential: an API key
 * (Gemini's `?key=`), a token, a signature. A key differs from one machine to the next and is rotated,
 * and a recording never keeps one, so it can't be what makes a call the call it is.
 */

/**
 * Parameter names a recording left out of the query it kept before credentials were read by
 * `credentialParam` (`SECRET_QUERY` in server.ts): a recording made then never holds them, so a
 * call's identity never counts them either, or a call to it would match none of its calls.
 */
const NEVER_KEPT = /^(key|api[-_]?key|apikey|access[-_]?token|id[-_]?token|token|code|sig|signature|x-amz-.+|x-goog-.+)$/i;

/**
 * The parameters of a query string (with or without `?`) that take part in a model call's identity,
 * URL-encoded in the order they were sent: without credentials (`credentialParam`), values a copy
 * masked as one (`<CREDENTIAL>`), and the names a recording never kept (`NEVER_KEPT`). Empty when
 * nothing is left. The engine sorts them (`queryPairs`).
 */
export function identityQuery(search: string | undefined): string {
  if (!search) return '';
  const kept = new URLSearchParams();
  for (const [name, value] of new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)) {
    if (value === CREDENTIAL_PLACEHOLDER || NEVER_KEPT.test(name) || credentialParam(name, value)) continue;
    kept.append(name, value);
  }
  return kept.toString();
}
