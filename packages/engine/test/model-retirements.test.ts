import { describe, expect, it } from 'vitest';
import { FIELD_RETIREMENTS, MODEL_RETIREMENTS, RETIREMENT_SOURCES, RETIREMENTS_VERSION, longDate, retiredFields, retirementOf, retirementsOf, retirementTableProblems, tableModel } from '../src/model-retirements.js';

/** The retirement table ships with the code: every date from a provider's own page, nothing asked at runtime. */

const at = (day: string) => Date.parse(`${day}T12:00:00Z`);

describe('the retirement table', () => {
  it('cites a provider page for every row, with a real date', () => {
    expect(retirementTableProblems()).toEqual([]);
    expect(MODEL_RETIREMENTS.length).toBeGreaterThan(100);
    for (const s of Object.values(RETIREMENT_SOURCES)) expect(s.url).toMatch(/^https:\/\/(platform\.claude\.com|developers\.openai\.com|ai\.google\.dev|docs\.cloud\.google\.com|docs\.aws\.amazon\.com)\//);
    for (const f of FIELD_RETIREMENTS) expect(Object.values(RETIREMENT_SOURCES).map((s) => s.url)).toContain(f.source);
    expect(RETIREMENTS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps no date a page does not set: no active Claude model, no "not before" date', () => {
    expect(MODEL_RETIREMENTS.some((r) => r.platform === 'anthropic' && r.model === 'claude-opus-5-5')).toBe(false);
    expect(MODEL_RETIREMENTS.some((r) => r.platform === 'vertex' && r.model === 'gemini-2.5-pro')).toBe(false);
  });
});

describe('retirementOf', () => {
  it('names a model that retires, the days left, and what the provider recommends', () => {
    const n = retirementOf('anthropic', 'claude-sonnet-4-5-20250929', { now: at('2026-10-19') });
    expect(n).toMatchObject({ state: 'retiring', retires: '2026-11-30', days: 42, replacement: 'claude-sonnet-5-5', source: RETIREMENT_SOURCES.anthropic.url });
    expect(n!.text).toBe('claude-sonnet-4-5-20250929 retires on the Claude API on November 30, 2026, in 42 days; Anthropic recommends claude-sonnet-5-5');
    expect(retirementOf('anthropic', 'claude-3-7-sonnet-20250219', { now: at('2026-10-19') })!.text).toBe('claude-3-7-sonnet-20250219 was retired on the Claude API on February 19, 2026: requests to it fail; Anthropic recommends claude-sonnet-5-5');
    expect(retirementOf('anthropic', 'claude-mythos-preview', { now: at('2026-10-19') })).toMatchObject({ state: 'deprecated', retires: null, days: null });
  });

  it("matches an Anthropic alias to the one snapshot it names, and nothing it can't tell", () => {
    expect(retirementOf('anthropic', 'claude-sonnet-4-5', { now: at('2026-10-19') })).toMatchObject({ matched: 'claude-sonnet-4-5-20250929', retires: '2026-11-30' });
    expect(retirementOf('anthropic', 'claude-3-7-sonnet-latest', { now: at('2026-10-19') })).toMatchObject({ matched: 'claude-3-7-sonnet-20250219' });
    expect(retirementOf('anthropic', 'claude-opus-5', { now: at('2026-10-19') })).toBeNull();
    // OpenAI names its aliases itself: gpt-4o is not on the page, its snapshots are.
    expect(retirementOf('openai', 'gpt-4o', { now: at('2026-10-19') })).toBeNull();
    expect(retirementOf('openai', 'gpt-4o-2024-08-06', { now: at('2026-10-19') })).toMatchObject({ retires: '2027-01-14', replacement: 'gpt-6-luna' });
    expect(retirementOf('openai', 'o4-mini', { now: at('2026-10-19') })).toMatchObject({ retires: '2026-10-23', days: 4 });
  });

  it("judges a call by the platform that served it: Bedrock's dates by Region, Gemini's as the earliest", () => {
    expect(tableModel('bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toEqual({ model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', region: null });
    expect(tableModel('bedrock', 'arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-3-haiku-20240307-v1:0')).toEqual({ model: 'anthropic.claude-3-haiku-20240307-v1:0', region: 'eu-west-1' });
    const bedrock = retirementOf('bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', { now: at('2026-10-19') });
    expect(bedrock).toMatchObject({ platform: 'bedrock', retires: '2027-04-08', state: 'retiring' });
    expect(bedrock!.text).toContain('in 31 Regions');
    // The same model through Anthropic's own API has its own date.
    expect(retirementOf('anthropic', 'claude-sonnet-4-5-20250929', { now: at('2026-10-19') })!.retires).toBe('2026-11-30');
    const haiku = retirementOf('bedrock', 'anthropic.claude-3-haiku-20240307-v1:0', { now: at('2026-10-19') });
    expect(haiku).toMatchObject({ retires: '2026-11-13' });
    expect(haiku!.regions).toHaveLength(6);
    expect(haiku!.text).toContain('it reached it on September 10, 2026 in 11 Regions');
    expect(retirementOf('bedrock', 'arn:aws:bedrock:us-east-1:1:foundation-model/anthropic.claude-3-haiku-20240307-v1:0', { now: at('2026-10-19') })).toMatchObject({ state: 'retired', retires: '2026-09-10' });

    const gemini = retirementOf('gemini', 'models/gemini-3.1-flash-lite', { now: at('2026-10-19') });
    expect(gemini).toMatchObject({ earliest: true, state: 'retiring', retires: '2027-05-07' });
    expect(gemini!.text).toContain('the earliest date Google gives');
    expect(retirementOf('vertex', 'publishers/google/models/gemini-2.0-flash', { now: at('2026-10-19') })).toMatchObject({ state: 'retired', retires: '2026-06-01' });
    expect(retirementOf('azure', 'gpt-4o-2024-08-06')).toBeNull();
  });

  it('lists each retiring model once, the soonest first', () => {
    const list = retirementsOf(
      [
        { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
        { provider: 'openai', model: 'o4-mini' },
        { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
        { provider: 'anthropic', model: 'claude-opus-5' },
      ],
      { now: at('2026-10-19') },
    );
    expect(list.map((n) => n.model)).toEqual(['o4-mini', 'claude-sonnet-4-5-20250929']);
    expect(longDate('2027-01-08')).toBe('January 8, 2027');
  });
});

describe('retiredFields', () => {
  it('names the sampling fields Claude 4.7 and later refuse, and lets the default temperature through', () => {
    expect(retiredFields('anthropic', 'claude-sonnet-5-5', { temperature: 0.2, top_p: 0.9, max_tokens: 10 }).map((f) => [f.field, f.value])).toEqual([
      ['temperature', 0.2],
      ['top_p', 0.9],
    ]);
    expect(retiredFields('anthropic', 'claude-opus-5-5', { temperature: 1 })).toEqual([]);
    expect(retiredFields('anthropic', 'claude-sonnet-4-6', { temperature: 0.2 })).toEqual([]);
    expect(retiredFields('anthropic', 'claude-opus-4-7', { top_k: 5 })[0]!.rule.behavior).toBe('Returns a 400 error when set to a non-default value');
  });
});
