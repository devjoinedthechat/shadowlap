import type { Usage } from './types.js';

/**
 * Approximate list prices, USD per million tokens, for the cost estimates in summaries and the
 * TUI. `Usage.inputTokens` means uncached input tokens; cache reads and writes are priced apart.
 * Estimates only: prices change, partner platforms differ, and unknown models get no estimate.
 * Override or extend with `prices` in shadowlap.config.json.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const opus: Price = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const fable: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

/** Longest matching prefix wins; keys are lower-case. */
export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-fable-5-1': { ...fable, cacheRead: 0.25 },
  'claude-mythos-5-1': { ...fable, cacheRead: 0.25 },
  'claude-fable-5': fable,
  'claude-mythos-5': fable,
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': opus,
  'claude-opus-4-8': opus,
  'claude-opus-4-7': opus,
  'claude-opus-4-6': opus,
  'claude-opus-4-5': opus,
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1 },
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
  o3: { input: 2, output: 8, cacheRead: 0.5 },
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.31 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.075 },
};

/**
 * A model id as the price table and the timeline know it, whatever platform served it: Bedrock's
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0` and Vertex's `claude-sonnet-4-5@20250929` are both
 * `claude-sonnet-4-5-20250929`, and Vercel's AI Gateway's `anthropic/claude-sonnet-4.5` is
 * `claude-sonnet-4-5` (a Claude version's dot is a dash; GPT's, `gpt-4.1`, stays).
 */
export function canonicalModel(model: string): string {
  const routed = /^(anthropic|openai|google|xai|mistral|deepseek|meta|amazon|cohere|vercel|groq|perplexity)\/(.+)$/i.exec(model);
  if (routed) model = /^claude-/i.test(routed[2]!) ? routed[2]!.replace(/(\d)\.(\d)/g, '$1-$2') : routed[2]!;
  return model
    .replace(/^(us|eu|apac|jp|au|ca|us-gov|global)\./i, '')
    .replace(/^(anthropic|amazon|meta|mistral|cohere|ai21|deepseek|openai|qwen|writer)\./i, '')
    .replace(/-v\d+(:\d+)?$/i, '')
    .replace(/@(\d{8}|latest|default)$/i, (_m, d: string) => (/^\d{8}$/.test(d) ? `-${d}` : ''));
}

export function priceFor(model: string | null | undefined, overrides: Record<string, Price> = {}): Price | null {
  if (!model) return null;
  const m = canonicalModel(model).toLowerCase();
  let best: { key: string; price: Price } | null = null;
  for (const table of [overrides, DEFAULT_PRICES]) {
    for (const [key, price] of Object.entries(table)) {
      const k = key.toLowerCase();
      if (m === k || m.startsWith(k)) {
        if (!best || k.length > best.key.length) best = { key: k, price };
      }
    }
    if (best) return best.price; // overrides take precedence over the defaults
  }
  return null;
}

/** USD for one call's usage, or null when the model is unknown. */
export function estimateCost(model: string | null | undefined, usage: Usage | undefined, overrides?: Record<string, Price>): number | null {
  const p = priceFor(model, overrides);
  if (!p || !usage) return null;
  const perTok = 1 / 1_000_000;
  return usage.inputTokens * p.input * perTok + usage.outputTokens * p.output * perTok + (usage.cacheReadInputTokens ?? 0) * (p.cacheRead ?? p.input) * perTok + (usage.cacheCreationInputTokens ?? 0) * (p.cacheWrite ?? p.input) * perTok;
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.001) return '<$0.001';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** `claude-opus-5-20260401` → `opus-5`; `gpt-5-mini` stays. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return '';
  return canonicalModel(model)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/@\d{8}$/, '');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return m < 60 ? `${m}m ${s}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
