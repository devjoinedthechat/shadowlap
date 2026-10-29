/**
 * Signed reasoning: what a model's provider hands back signed or encrypted, and checks has not been
 * changed when the agent sends it back in a later request. Anthropic's thinking blocks (`thinking`
 * with its `signature`, and `redacted_thinking`, on Bedrock and Vertex too, and in a stream their
 * `thinking_delta` and `signature_delta`), Bedrock Converse's `reasoningContent`, Gemini's
 * `thoughtSignature`, an OpenAI reasoning item's `encrypted_content`, and the signed
 * `reasoning_details` OpenRouter passes on. A copy that can be replayed (a pack) keeps them as
 * recorded whatever its redaction rules, since a fork of it sends them back live and the provider
 * would refuse the request; it says which rules matched inside them instead (redact.ts). A copy
 * that is only read masks them like any other text.
 */

import { cloneExact } from './json-exact.js';
import { isObject } from './is-object.js';

/** Blocks signed whole, by their `type`. */
const SIGNED_TYPES = new Set(['thinking', 'redacted_thinking', 'thinking_delta', 'signature_delta', 'reasoning.text', 'reasoning.encrypted']);

/** Members whose value is signed or encrypted whole, wherever they are. */
const SIGNED_KEYS = new Set(['reasoningContent', 'redactedContent', 'thoughtSignature', 'thought_signature', 'encrypted_content']);

/** What a document holding signed reasoning names, as its JSON text writes it: read for before the document is. */
const MENTIONS = /"(?:thinking|redacted_thinking|thinking_delta|signature_delta|reasoning\.text|reasoning\.encrypted|reasoningContent|redactedContent|thoughtSignature|thought_signature|encrypted_content)"/;

/** A place in a JSON value: the keys and positions down to it. */
export type Place = ReadonlyArray<string | number>;

/** A place as one text, to look it up. */
export function placeKey(place: Place): string {
  return place.map((s) => (typeof s === 'number' ? `#${s}` : `.${s}`)).join('\u0001');
}

/** Whether a JSON text may hold signed reasoning: a quick look before it is read for it. */
export function mayHoldSigned(text: string): boolean {
  return MENTIONS.test(text);
}

/** Whether a value is signed whole: a thinking block, or what a signed member holds. */
function signedBlock(value: Record<string, unknown>): boolean {
  return typeof value.type === 'string' && SIGNED_TYPES.has(value.type);
}

/** Each piece of signed reasoning in a JSON value, outermost first, with its place: never one inside another. */
export function signedParts(value: unknown, at: Array<string | number> = [], out: Array<{ place: Place; value: unknown }> = []): Array<{ place: Place; value: unknown }> {
  if (Array.isArray(value)) value.forEach((v, i) => signedParts(v, [...at, i], out));
  else if (isObject(value)) {
    if (signedBlock(value)) out.push({ place: at, value });
    else
      for (const [k, v] of Object.entries(value)) {
        if (SIGNED_KEYS.has(k)) out.push({ place: [...at, k], value: v });
        else signedParts(v, [...at, k], out);
      }
  }
  return out;
}

/**
 * The texts in a piece of signed reasoning at `place`, each with its own place. `stream` leaves out
 * the text a stream sends in pieces across its events (a thinking delta's `thinking`, a Converse
 * reasoning delta's `text`), which is read whole, as the pieces add up, where the stream's runs are.
 */
export function signedTexts(value: unknown, place: Place, stream = false, out: Array<{ place: Place; text: string }> = []): Array<{ place: Place; text: string }> {
  if (typeof value === 'string') out.push({ place, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => signedTexts(v, [...place, i], stream, out));
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (stream && typeof v === 'string' && ((k === 'thinking' && (value.type === 'thinking' || value.type === 'thinking_delta')) || (k === 'text' && place[place.length - 1] === 'reasoningContent'))) continue;
      signedTexts(v, [...place, k], stream, out);
    }
  }
  return out;
}

/** Where a place's value sits in `value`: its holder and its key there; undefined when the place isn't there. */
function slotAt(value: unknown, place: Place): { holder: Record<string | number, unknown>; key: string | number } | undefined {
  let node: unknown = value;
  for (let k = 0; k < place.length - 1; k++) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string | number, unknown>)[place[k]!];
  }
  const key = place[place.length - 1];
  if (key === undefined || node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node) ? typeof key !== 'number' || key >= node.length : typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
  return { holder: node as Record<string | number, unknown>, key };
}

/** The key of what a piece of signed reasoning is cut out as while the rules apply: no request has it. */
export const SIGNED_MARK = '\u0000signed';

/** Whether a value is what a piece of signed reasoning was cut out as (cutSigned). */
export function isSignedMark(value: unknown): boolean {
  return isObject(value) && typeof value[SIGNED_MARK] === 'number' && Object.keys(value).length === 1;
}

/**
 * A copy of a request with each piece of signed reasoning cut out (signedParts), so no rule reaches
 * it, and how to put them back once the rules have applied: each at its place, wherever the place
 * is still there (a rule that replaced a whole value around one leaves nothing to put it in).
 */
export function cutSigned(request: unknown): { cut: unknown; parts: Array<{ place: Place; value: unknown }>; paste: (masked: unknown) => unknown } {
  const parts = signedParts(request);
  if (!parts.length) return { cut: request, parts, paste: (masked) => masked };
  // A number kept as written (parseJsonExact) stays one in the copy.
  const cut = cloneExact(request);
  // Cut out as a mark that holds no text, which the observer is kept from counting (isSignedMark).
  parts.forEach((p, n) => {
    const slot = p.place.length ? slotAt(cut, p.place) : undefined;
    if (slot) slot.holder[slot.key] = { [SIGNED_MARK]: n };
  });
  const paste = (masked: unknown): unknown => {
    if (parts.some((p) => p.place.length === 0)) return request;
    for (const p of parts) {
      const slot = slotAt(masked, p.place);
      if (slot) slot.holder[slot.key] = p.value;
    }
    return masked;
  };
  return { cut, parts, paste };
}
