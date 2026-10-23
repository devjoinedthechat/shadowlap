import type { CallRecord } from './types.js';

/**
 * Response headers that name the account a call was made with: Anthropic's organization id. A
 * recording made now never keeps one (the sidecar's provider modules leave it out of what they
 * store); a run recorded before may hold one, and no copy of a run takes it along: a pack, a HAR file.
 */
export const ACCOUNT_HEADERS: readonly string[] = ['anthropic-organization-id'];

/** Response headers without the ones that name an account; the same object when it holds none. */
export function withoutAccountHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  if (!ACCOUNT_HEADERS.some((h) => Object.hasOwn(headers, h))) return headers as Record<string, string>;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !ACCOUNT_HEADERS.includes(name.toLowerCase())));
}

/** A call as a copy of its run carries it: its ends' response headers without the ones that name an account. */
export function forCopy(call: CallRecord): CallRecord {
  const end = <E extends NonNullable<CallRecord['end']>>(e: E): E => (e.meta.headers ? { ...e, meta: { ...e.meta, headers: withoutAccountHeaders(e.meta.headers) } } : e);
  const touched = [call.end, ...call.attempts].some((e) => e?.meta.headers && ACCOUNT_HEADERS.some((h) => Object.hasOwn(e.meta.headers!, h)));
  return touched ? { ...call, end: call.end ? end(call.end) : null, attempts: call.attempts.map(end) } : call;
}
