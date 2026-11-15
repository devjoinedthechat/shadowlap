/**
 * Run again, allowing's words, apart from its button and dialog (allow-again.tsx), so a run's note
 * can say what a job the CLI refuses offers without loading them.
 */

/** Names joined as a sentence lists them: `a`, `a and b`, `a, b and c`. */
export const andList = (names: readonly string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}` : (names[0] ?? ''));

/** Its label, by the tools it allows. */
export const allowAgainLabel = (tools: readonly string[]): string => `Run again, allowing ${andList(tools)}`;
