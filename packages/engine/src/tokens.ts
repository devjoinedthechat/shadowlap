import type { Usage } from './types.js';

/**
 * A model call's input tokens: everything the model read, uncached, written to the prompt cache and
 * read from it. The one count `show`, `test`, a replay's summary and the dashboard call input tokens,
 * whatever the provider bills for each part.
 */
export function wholeInput(u: Pick<Usage, 'inputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'>): number {
  return u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
}
