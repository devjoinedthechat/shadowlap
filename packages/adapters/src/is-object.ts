/**
 * Whether a value is an object to read fields from: an object that is neither null nor an array. The
 * adapters' one copy of the engine's isObject (packages/engine/src/is-object.ts): they depend on the
 * SDK alone, and install nothing else.
 */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
