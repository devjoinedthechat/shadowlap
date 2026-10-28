/**
 * What a caught value says: an Error's message, or the value itself as text, as JavaScript can throw
 * anything. `(err as Error).message` reads undefined from a thrown string. The packages share this one
 * reading of it, and a lint rule in eslint.config.mjs refuses the other spellings.
 */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
