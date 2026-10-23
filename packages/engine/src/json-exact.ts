import { setOwn } from './canonical.js';

/**
 * JSON whose numbers survive the trip. `JSON.parse` reads every number as a double, so an id past
 * 2^53 comes back changed (1234567890123456789 as 1234567890123456800) and a Python float written
 * `20.0` comes back as `20`, which Python then reads as an int. What a tool returned must reach the
 * agent on replay exactly as it was recorded, so payloads the SDKs send are read with each number's
 * text kept, written to the store as it was, and served back the same way.
 */

type RawJson = { readonly rawJSON: string };
const json = JSON as unknown as { rawJSON?: (text: string) => RawJson; isRawJSON?: (value: unknown) => boolean };

/** Whether a value is a number kept as written by `parseJsonExact`. */
export const isRawNumber = (value: unknown): value is RawJson => json.isRawJSON?.(value) === true;

/**
 * `JSON.parse` that keeps a number whose text a double would change as written: `JSON.stringify` writes
 * it back verbatim. Every other value is what `JSON.parse` gives. Such a value can't be cloned or
 * walked as an ordinary number: store and serve it, and fingerprint `matchable(value)`.
 */
export function parseJsonExact(text: string): unknown {
  const raw = json.rawJSON;
  if (!raw) return JSON.parse(text);
  return JSON.parse(text, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    return typeof value === 'number' && typeof context?.source === 'string' && String(value) !== context.source ? raw(context.source) : value;
  } as (key: string, value: unknown) => unknown);
}

/**
 * A value from `parseJsonExact` as matching reads it: an integer a double can't hold as a BigInt (its
 * exact digits, so two 64-bit ids that round alike still differ), any other number as the double it
 * reads as (`20.0` is `20`, as it always matched). Nothing else changes.
 */
export function matchable(value: unknown): unknown {
  if (isRawNumber(value)) return /^-?\d+$/.test(value.rawJSON) ? BigInt(value.rawJSON) : Number(value.rawJSON);
  if (Array.isArray(value)) return value.map(matchable);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) setOwn(out, k, matchable(v));
    return out;
  }
  return value;
}

/**
 * A value from `parseJsonExact` as a divergence report shows it, as plain JSON: an integer a double
 * can't hold as its digits in a string (`"1234567890123456789"`, so two ids that round alike show as
 * the change they are, and survive the trip through the store), any other number as the double it
 * reads as, which is how it matched.
 */
export function reportable(value: unknown): unknown {
  if (isRawNumber(value)) {
    if (!/^-?\d+$/.test(value.rawJSON)) return Number(value.rawJSON);
    const n = BigInt(value.rawJSON);
    return Number.isSafeInteger(Number(n)) ? Number(n) : n.toString();
  }
  if (Array.isArray(value)) return value.map(reportable);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) setOwn(out, k, reportable(v));
    return out;
  }
  return value;
}
