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
 * walked as an ordinary number: store and serve it, and fingerprint `matchable(value)`. `kept.raw` is
 * set when it kept one, so a caller that also needs the plain reading parses again only then.
 */
export function parseJsonExact(text: string, kept?: { raw: boolean }): unknown {
  const raw = json.rawJSON;
  // No number a double reads otherwise: JSON.parse gives the very same, five times as fast as a reviver.
  if (!raw || !rereadNumber(text)) return JSON.parse(text);
  return JSON.parse(text, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    if (typeof value !== 'number' || typeof context?.source !== 'string' || String(value) === context.source) return value;
    if (kept) kept.raw = true;
    return raw(context.source);
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
 * A deep copy of a value from `parseJsonExact`: a number kept as written stays the very value it is
 * (it is frozen, and structuredClone would turn it into an object holding its text), and bytes stay
 * as they are. What the rules a copy applies (normalize.ts) work on.
 */
export function cloneExact<T>(value: T): T {
  if (value === null || typeof value !== 'object' || isRawNumber(value) || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map((v: unknown) => cloneExact(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) setOwn(out, k, cloneExact(v));
  return out as T;
}

/**
 * A value from `parseJsonExact` as `JSON.parse` would have read it: every number the double it reads
 * as, an integer past 2^53 rounded. How a model request was matched before requests kept their
 * numbers, which a replay of a recording made then matches it by.
 */
export function asParsed(value: unknown): unknown {
  if (isRawNumber(value)) return Number(value.rawJSON);
  if (Array.isArray(value)) return value.map(asParsed);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) setOwn(out, k, asParsed(v));
    return out;
  }
  return value;
}

/**
 * Whether JSON text may hold a number whose text a double reads otherwise, which parseJsonExact keeps
 * as written: one with an exponent (`1e-07`), a fraction ending in zero (`20.0`), 16 significant
 * digits or more (an id past 2^53), `-0`, or below 1e-6 (`0.0000001`, which reads back as `1e-7`).
 * Any other number, at most 15 significant digits, is the shortest text of the double it reads as,
 * which is how a double is written. Strings are skipped, so a hash or base64 in one never counts;
 * text that isn't JSON says yes, and JSON.parse with the reviver says why.
 */
function rereadNumber(text: string): boolean {
  const n = text.length;
  const digit = (i: number) => {
    const c = text.charCodeAt(i);
    return c >= 48 && c <= 57;
  };
  for (let i = 0; i < n; ) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      // A string: to its closing quote, past every escaped one.
      let end = i;
      for (;;) {
        end = text.indexOf('"', end + 1);
        if (end < 0) return true;
        let slashes = 0;
        while (text.charCodeAt(end - 1 - slashes) === 92) slashes++;
        if (slashes % 2 === 0) break;
      }
      i = end + 1;
      continue;
    }
    if (c !== 45 && !(c >= 48 && c <= 57)) {
      i++;
      continue;
    }
    // A number: -?int(.frac)?(e±exp)?
    let j = c === 45 ? i + 1 : i;
    const intStart = j;
    while (j < n && digit(j)) j++;
    const intDigits = j - intStart;
    const zeroInt = intDigits === 1 && text.charCodeAt(intStart) === 48;
    let fracDigits = 0;
    let leadingZeros = 0;
    if (text.charCodeAt(j) === 46) {
      const fracStart = ++j;
      while (j < n && digit(j)) j++;
      fracDigits = j - fracStart;
      if (fracDigits && text.charCodeAt(j - 1) === 48) return true;
      while (leadingZeros < fracDigits && text.charCodeAt(fracStart + leadingZeros) === 48) leadingZeros++;
    }
    const e = text.charCodeAt(j);
    if (e === 101 || e === 69) return true;
    if (c === 45 && zeroInt && fracDigits === 0) return true;
    const significant = zeroInt ? fracDigits - leadingZeros : intDigits + fracDigits;
    if (significant >= 16 || (zeroInt && leadingZeros >= 6)) return true;
    i = Math.max(j, i + 1);
  }
  return false;
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
