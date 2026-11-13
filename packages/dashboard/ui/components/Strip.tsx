import { ktok } from '../format.js';

/**
 * What a strip cell says of a call, on the run page's strip (ui/run/RunStrip.tsx). The small strips,
 * the Runs table's and the Overview's, are MiniStrip.tsx.
 */

/** What a strip cell says about one call: its tokens for a model call, else its effect or kind. */
export function stripDetail(c: { kind: string; effect: string | null; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null }): string {
  if (c.kind === 'api') return c.usage ? `${ktok(c.usage.input + c.usage.cacheRead + c.usage.cacheWrite)} → ${ktok(c.usage.output)}` : 'model call';
  return c.effect ?? c.kind;
}
