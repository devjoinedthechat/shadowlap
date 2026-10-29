/**
 * Whether a value is an object to read fields from: an object that is neither null nor an array. The
 * packages share this one test of it, and a lint rule in eslint.config.mjs refuses another definition.
 */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
