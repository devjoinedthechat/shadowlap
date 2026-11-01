/**
 * A field of something that arrived untyped, as what it should be, or null: a run's metadata from a
 * pack someone else made, a stored JSON column, the API's answer. The server and its pages read them
 * the same way. No imports: the page's bundle imports this too.
 */
export const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
