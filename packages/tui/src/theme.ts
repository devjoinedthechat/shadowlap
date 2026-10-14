import type { Origin } from '@shadowlap/engine';

export const originColor: Record<Origin | 'injected', string> = {
  live: 'white',
  replayed: 'cyan',
  blocked: 'red',
  stubbed: 'yellow',
  overridden: 'magenta',
  // Answered by Shadowlap with --fail-at: magenta as an override is, because Shadowlap stood in.
  injected: 'magenta',
};

/**
 * Where a call's answer came from, as it should be shown. The store keeps an injected failure as live
 * — it did not come from the recording — but it did not come from the provider either.
 */
export function displayOrigin(c: { origin: Origin; end: { meta: { injected?: boolean } } | null }): Origin | 'injected' {
  return c.end?.meta.injected ? 'injected' : c.origin;
}

/**
 * Column labels stay ASCII on purpose: glyphs with East-Asian-ambiguous width (◆ ▶ · →) are
 * measured differently by the layout engine and by terminals, which skews aligned rows.
 */
export const kindLabel: Record<string, string> = {
  api: 'api',
  tool: 'tool',
  clock: 'clk',
  random: 'rnd',
};

export const roleColor: Record<string, string> = {
  system: 'magenta',
  user: 'green',
  assistant: 'blue',
  tool: 'yellow',
  label: 'gray',
};
