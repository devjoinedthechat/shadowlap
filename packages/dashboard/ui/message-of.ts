/**
 * What a caught value says: an Error's message, or the value itself as text, as JavaScript can throw
 * anything. The browser code's one copy of the engine's messageOf (packages/engine/src/message-of.ts),
 * which it doesn't import: the page bundles nothing of the engine.
 */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
