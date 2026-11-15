import type { Usage } from './types.js';

/** One rate card: USD per million tokens of each kind. */
export interface Rates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Approximate list prices, USD per million tokens, for the cost estimates in summaries and the
 * TUI. `Usage.inputTokens` means uncached input tokens; cache reads and writes are priced apart.
 * Estimates only: prices change, partner platforms differ, and unknown models get no estimate.
 * Override or extend with `prices` in shadowlap.config.json.
 *
 * `above` is a second card for a long prompt: a call whose whole prompt (`promptTokens`: uncached
 * input, cache reads and cache writes) is over `above.tokens` pays its rates for all of its tokens,
 * output too. Each call is priced by its own prompt, never by a run's sum.
 */
export interface Price extends Rates {
  above?: Rates & { tokens: number };
}

const opus: Price = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const fable: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
const fable52: Price = { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 };

/** Longest matching prefix wins; keys are lower-case. */
export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-fable-5-2': fable52,
  'claude-mythos-5-2': fable52,
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
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Two cards by the prompt's length: up to 100,000 tokens, and over.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, above: { tokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
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

/**
 * Whether price key `k` covers model `m` (both lower-case): the whole id, or a prefix of it whose
 * last number is whole. `claude-fable-5-2` is Fable 5.2 and its snapshots, never Fable 5's dated
 * `claude-fable-5-20260401`.
 */
const covers = (m: string, k: string) => m === k || (m.startsWith(k) && !(/\d$/.test(k) && /^\d/.test(m.slice(k.length))));

export function priceFor(model: string | null | undefined, overrides: Record<string, Price> = {}): Price | null {
  if (!model) return null;
  const m = canonicalModel(model).toLowerCase();
  let best: { key: string; price: Price } | null = null;
  for (const table of [overrides, DEFAULT_PRICES]) {
    for (const [key, price] of Object.entries(table)) {
      const k = key.toLowerCase();
      if (covers(m, k)) {
        if (!best || k.length > best.key.length) best = { key: k, price };
      }
    }
    if (best) return best.price; // overrides take precedence over the defaults
  }
  return null;
}

/** A call's whole prompt: its uncached input, cache reads and cache writes. A price's second card is chosen by it. */
export function promptTokens(usage: Usage): number {
  return usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}

/**
 * The prompt lengths where a price changes card (`above.tokens`), of `overrides` and the defaults,
 * ascending: what usage summed over calls is split at, so the sums are priced as each call is (`bandOf`).
 */
export function priceBreaks(overrides: Record<string, Price> = {}): number[] {
  const breaks = new Set<number>();
  for (const table of [overrides, DEFAULT_PRICES]) for (const p of Object.values(table)) if (p.above) breaks.add(p.above.tokens);
  return [...breaks].sort((a, b) => a - b);
}

/**
 * The band of `breaks` a call's whole prompt falls in: the largest break it is over, or 0. Calls of
 * one band pay one card under every price whose break is among `breaks`, so their usage summed is
 * priced as each call would be: `estimateCost(model, sum, prices, band)`.
 */
export function bandOf(usage: Usage, breaks: readonly number[]): number {
  const prompt = promptTokens(usage);
  let band = 0;
  for (const b of breaks) if (prompt > b) band = b;
  return band;
}

/**
 * USD for one call's usage, or null when the model is unknown: at the card its whole prompt picks.
 * With `band` (`bandOf`), `usage` is summed over calls of that band, and the card is the band's.
 */
export function estimateCost(model: string | null | undefined, usage: Usage | undefined, overrides?: Record<string, Price>, band?: number): number | null {
  const p = priceFor(model, overrides);
  if (!p || !usage) return null;
  const long = p.above && (band === undefined ? promptTokens(usage) > p.above.tokens : band >= p.above.tokens);
  const r: Rates = long ? p.above! : p;
  const perTok = 1 / 1_000_000;
  return usage.inputTokens * r.input * perTok + usage.outputTokens * r.output * perTok + (usage.cacheReadInputTokens ?? 0) * (r.cacheRead ?? r.input) * perTok + (usage.cacheCreationInputTokens ?? 0) * (r.cacheWrite ?? r.input) * perTok;
}

/** USD for calls' usage, each priced on its own (`estimateCost`), or null when the model is unknown. */
export function estimateCalls(model: string | null | undefined, usages: readonly Usage[], overrides?: Record<string, Price>): number | null {
  if (!priceFor(model, overrides)) return null;
  return usages.reduce((n, u) => n + (estimateCost(model, u, overrides) ?? 0), 0);
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.001) return '<$0.001';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** An estimate in dollars: `≈$0.0004`, and `<$0.001` as it is. */
export function aboutUsd(n: number): string {
  const s = formatUsd(n);
  return s.startsWith('<') ? s : `≈${s}`;
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
