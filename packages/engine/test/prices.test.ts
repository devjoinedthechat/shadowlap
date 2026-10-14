import { describe, expect, it } from 'vitest';
import { estimateCost, formatDuration, formatUsd, priceFor, shortModel } from '../src/prices.js';

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
