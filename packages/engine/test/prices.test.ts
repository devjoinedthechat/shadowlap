import { describe, expect, it } from 'vitest';
import { bandOf, estimateCalls, estimateCost, formatDuration, formatUsd, priceBreaks, priceFor, promptTokens, shortModel, type Price } from '../src/prices.js';
import type { Usage } from '../src/types.js';

/** USD for a whole million-token count at a rate: what a test works out by hand. */
const usd = (tokens: number, rate: number) => (tokens * rate) / 1_000_000;

describe('prices', () => {
  it('matches by longest prefix, case-insensitively, with overrides first', () => {
    expect(priceFor('claude-opus-5')?.input).toBe(5);
    expect(priceFor('claude-opus-5-20260401')?.output).toBe(25);
    // Opus 5.5 is priced apart from Opus 5, and its prefix doesn't swallow Opus 5's dated snapshots.
    expect(priceFor('claude-opus-5-5')).toMatchObject({ input: 4, output: 20 });
    expect(priceFor('Claude-Sonnet-5')?.input).toBe(2);
    expect(priceFor('gpt-5-mini')?.input).toBe(0.25); // not gpt-5
    expect(priceFor('claude-fable-5-1')?.cacheRead).toBe(0.25); // not claude-fable-5
    expect(priceFor('unknown-model')).toBeNull();
    expect(priceFor('claude-opus-5', { 'claude-opus-5': { input: 1, output: 2 } })?.input).toBe(1);
    expect(priceFor('my-finetune', { 'my-finetune': { input: 9, output: 9 } })?.output).toBe(9);
  });

  it('estimates cost with cache reads and writes priced apart', () => {
    // 1M uncached input at $5, 100k output at $25, 500k cache reads at $0.50, 200k cache writes at $6.25
    const usd = estimateCost('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 500_000, cacheCreationInputTokens: 200_000 });
    expect(usd).toBeCloseTo(5 + 2.5 + 0.25 + 1.25, 6);
    expect(estimateCost('unknown', { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(estimateCost('claude-opus-5', undefined)).toBeNull();
  });

  it('prices the current Claude models at their list prices', () => {
    // Sonnet 5.5 is priced apart from Sonnet 5, whose cache read is 0.20.
    expect(priceFor('claude-sonnet-5-5')).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(priceFor('claude-sonnet-5-5-20261001')?.cacheRead).toBe(0.1);
    expect(priceFor('claude-sonnet-5')?.cacheRead).toBe(0.2);
    for (const m of ['claude-fable-5-2', 'claude-mythos-5-2', 'claude-fable-5-2-20261101', 'us.anthropic.claude-mythos-5-2-v1:0']) expect(priceFor(m), m).toEqual({ input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 });
    // A number in a key is whole: Fable 5.2's key is no prefix of Fable 5's dated snapshot, nor 5.1's.
    expect(priceFor('claude-fable-5-20260401')).toMatchObject({ input: 10, output: 50 });
    expect(priceFor('claude-mythos-5-1')).toMatchObject({ input: 10, cacheRead: 0.25 });
    expect(priceFor('my-model-12', { 'my-model-1': { input: 1, output: 1 } })).toBeNull();
    expect(priceFor('claude-haiku-5-5')).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, above: { tokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } });
    // Each card's cache reads are 0.1x and its cache writes 1.25x of its input rate.
    const haiku = priceFor('claude-haiku-5-5')!;
    for (const card of [haiku, haiku.above!]) {
      expect(card.cacheRead).toBeCloseTo(card.input * 0.1, 10);
      expect(card.cacheWrite).toBeCloseTo(card.input * 1.25, 10);
    }
  });

  it('prices Claude Haiku 5.5 by the call\'s whole prompt: up to 100,000 tokens on one card, longer on the other', () => {
    const at = (inputTokens: number, outputTokens = 1000) => estimateCost('claude-haiku-5-5', { inputTokens, outputTokens });
    expect(at(100_000)).toBeCloseTo(usd(100_000, 0.1) + usd(1000, 0.5), 12);
    expect(at(100_001)).toBeCloseTo(usd(100_001, 0.5) + usd(1000, 2.5), 12);
    // Output is on the card the prompt picks, however long the answer.
    expect(at(10, 200_000)).toBeCloseTo(usd(10, 0.1) + usd(200_000, 0.5), 12);
    // Claude Haiku 4.5 has one card at any length.
    expect(estimateCost('claude-haiku-4-5', { inputTokens: 100_001, outputTokens: 1000 })).toBeCloseTo(usd(100_001, 1) + usd(1000, 5), 12);
  });

  it('counts cache reads and writes in the prompt that picks Haiku 5.5\'s card, and prices them at that card\'s cache rates', () => {
    // 90,000 in all: the short card.
    const short: Usage = { inputTokens: 20_000, outputTokens: 1000, cacheReadInputTokens: 60_000, cacheCreationInputTokens: 10_000 };
    expect(promptTokens(short)).toBe(90_000);
    expect(estimateCost('claude-haiku-5-5', short)).toBeCloseTo(usd(20_000, 0.1) + usd(1000, 0.5) + usd(60_000, 0.01) + usd(10_000, 0.125), 12);
    // 100,001 in all, though only 20,000 uncached: the long card.
    const long: Usage = { inputTokens: 20_000, outputTokens: 1000, cacheReadInputTokens: 70_000, cacheCreationInputTokens: 10_001 };
    expect(promptTokens(long)).toBe(100_001);
    expect(estimateCost('claude-haiku-5-5', long)).toBeCloseTo(usd(20_000, 0.5) + usd(1000, 2.5) + usd(70_000, 0.05) + usd(10_001, 0.625), 12);
  });

  it('takes a second card from the config, and a config price without one replaces both of the defaults\'', () => {
    const prices: Record<string, Price> = { 'my-long-model': { input: 1, output: 2, above: { tokens: 200_000, input: 3, output: 4, cacheRead: 0.3 } }, 'claude-haiku-5-5': { input: 0.2, output: 1 } };
    expect(estimateCost('my-long-model', { inputTokens: 200_000, outputTokens: 10 }, prices)).toBeCloseTo(usd(200_000, 1) + usd(10, 2), 12);
    expect(estimateCost('my-long-model', { inputTokens: 100_000, outputTokens: 10, cacheReadInputTokens: 100_001 }, prices)).toBeCloseTo(usd(100_000, 3) + usd(10, 4) + usd(100_001, 0.3), 12);
    // A card's cache write falls back to its own input rate.
    expect(estimateCost('my-long-model', { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 300_000 }, prices)).toBeCloseTo(usd(300_000, 3), 12);
    expect(estimateCost('claude-haiku-5-5', { inputTokens: 150_000, outputTokens: 10 }, prices)).toBeCloseTo(usd(150_000, 0.2) + usd(10, 1), 12);
    expect(priceBreaks(prices)).toEqual([100_000, 200_000]);
    expect(priceBreaks()).toEqual([100_000]);
  });

  it('prices usage summed within a band of the prompt\'s length as each call alone', () => {
    const breaks = priceBreaks();
    const calls: Usage[] = [
      { inputTokens: 40_000, outputTokens: 500, cacheReadInputTokens: 50_000 },
      { inputTokens: 100_000, outputTokens: 800 },
      { inputTokens: 5000, outputTokens: 900, cacheReadInputTokens: 95_000, cacheCreationInputTokens: 1 },
      { inputTokens: 300_000, outputTokens: 700 },
    ];
    expect(calls.map((u) => bandOf(u, breaks))).toEqual([0, 0, 100_000, 100_000]);
    const each = calls.reduce((n, u) => n + estimateCost('claude-haiku-5-5', u)!, 0);
    const sum = (us: Usage[]): Usage => ({ inputTokens: us.reduce((n, u) => n + u.inputTokens, 0), outputTokens: us.reduce((n, u) => n + u.outputTokens, 0), cacheReadInputTokens: us.reduce((n, u) => n + (u.cacheReadInputTokens ?? 0), 0), cacheCreationInputTokens: us.reduce((n, u) => n + (u.cacheCreationInputTokens ?? 0), 0) });
    const banded = estimateCost('claude-haiku-5-5', sum(calls.slice(0, 2)), undefined, 0)! + estimateCost('claude-haiku-5-5', sum(calls.slice(2)), undefined, 100_000)!;
    expect(banded).toBeCloseTo(each, 12);
    expect(estimateCalls('claude-haiku-5-5', calls)).toBeCloseTo(each, 12);
    // The sum priced as one call would be on the long card whole.
    expect(estimateCost('claude-haiku-5-5', sum(calls))).toBeGreaterThan(each);
    expect(estimateCalls('unknown', calls)).toBeNull();
    expect(estimateCalls('claude-haiku-5-5', [])).toBe(0);
  });

  it('formats money and durations for a narrow column', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.0004)).toBe('<$0.001');
    expect(formatUsd(0.0071)).toBe('$0.0071');
    expect(formatUsd(0.31)).toBe('$0.310');
    expect(formatUsd(12.345)).toBe('$12.35');
    expect(formatUsd(1234)).toBe('$1,234');
    expect(shortModel('claude-opus-5-20260401')).toBe('opus-5');
    expect(shortModel('gpt-5-mini')).toBe('gpt-5-mini');
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(4200)).toBe('4.2s');
    expect(formatDuration(72_000)).toBe('1m 12s');
  });
});
