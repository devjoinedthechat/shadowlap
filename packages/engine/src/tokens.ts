import type { Usage } from './types.js';

/**
 * A model call's input tokens: everything the model read, uncached, written to the prompt cache and
 * read from it. The one count `show`, `test`, a replay's summary and the dashboard call input tokens,
 * whatever the provider bills for each part.
 */
export function wholeInput(u: Pick<Usage, 'inputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'>): number {
  return u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
}

/**
 * A token count as the CLI and the dashboard both write it: `840`, `1.8k`, `24.6k`, `1.23M`. One
 * formatter, so `show`'s line and the page's receipt give the same figure for the same run.
 */
export function formatTokens(n: number): string {
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
