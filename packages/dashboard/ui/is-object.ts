/**
 * Whether a value is an object to read fields from: an object that is neither null nor an array. The
 * browser code's one copy of the engine's isObject (packages/engine/src/is-object.ts), which it doesn't
 * import: the page bundles nothing of the engine.
 */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
