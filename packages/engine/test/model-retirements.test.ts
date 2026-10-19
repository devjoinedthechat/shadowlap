import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { longDate, replacementModels, retiredFields, retirementOf, retirementsOf, retirementTable, retirementTableProblems, tableModel, type RetirementTable } from '../src/model-retirements.js';

/** The retirement table ships with the code as data: every date from a provider's own page, nothing asked at runtime. */

const at = (day: string) => Date.parse(`${day}T12:00:00Z`);
const { models, fields, platforms, version } = retirementTable();

describe('the retirement table', () => {
  it('is the data file the package ships, each row citing a provider page, with a real date', () => {
    const file = JSON.parse(readFileSync(new URL('../data/model-retirements.json', import.meta.url), 'utf8')) as RetirementTable;
    expect(retirementTable()).toEqual(file);
    expect(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).files).toContain('data');
    expect(retirementTableProblems()).toEqual([]);
    expect(models.length).toBeGreaterThan(100);
    for (const s of Object.values(platforms)) {
      for (const page of s.pages) expect(page).toMatch(/^https:\/\/(platform\.claude\.com|developers\.openai\.com|ai\.google\.dev|docs\.cloud\.google\.com|docs\.aws\.amazon\.com)\//);
      expect(s.pages).toContain(s.url);
    }
    for (const f of fields) expect(Object.values(platforms).flatMap((s) => s.pages)).toContain(f.source);
    expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('names what is wrong with a row or a rule, for whoever edits the file', () => {
    const edited: RetirementTable = {
      ...retirementTable(),
      models: [{ platform: 'bedrock', model: 'm', retires: '2026-13-01', source: 'https://example.com/elsewhere' }],
      fields: [{ ...fields[0]!, says: '' }],
    };
    expect(retirementTableProblems(edited)).toEqual([
      'bedrock m: its source is not one of the platforms\' pages',
      'bedrock m: retires is not a date',
      'bedrock m: a Bedrock date needs its Regions',
      `the ${fields[0]!.fields.join(', ')} rule: it needs the page's words`,
    ]);
  });

  it('keeps no date a page does not set: no active Claude model, no "or later" date', () => {
    expect(models.some((r) => r.platform === 'anthropic' && r.model === 'claude-opus-5-5')).toBe(false);
    // Vertex AI gives gemini-3.8-flash "September 2, 2027 or later", and gemini-2.5-pro a date of its own.
    expect(models.some((r) => r.platform === 'vertex' && r.model === 'gemini-3.8-flash')).toBe(false);
    expect(models.find((r) => r.platform === 'vertex' && r.model === 'gemini-2.5-pro')).toMatchObject({ retires: '2026-10-20', replacement: 'gemini-3.8-flash or gemini-3.5-flash' });
    // The Gemini API keeps serving 2.5 Pro with no shutdown date: the same model, another platform's table.
    expect(models.some((r) => r.platform === 'gemini' && r.model === 'gemini-2.5-pro')).toBe(false);
  });
});

describe('retirementOf', () => {
  it('names a model that retires, the days left, and what the provider recommends', () => {
    const n = retirementOf('anthropic', 'claude-sonnet-4-5-20250929', { now: at('2026-10-19') });
    expect(n).toMatchObject({ state: 'retiring', retires: '2026-11-30', days: 42, replacement: 'claude-sonnet-5-5', source: platforms.anthropic.url });
    expect(n!.text).toBe('claude-sonnet-4-5-20250929 retires on the Claude API on November 30, 2026, in 42 days; Anthropic recommends claude-sonnet-5-5');
    expect(retirementOf('anthropic', 'claude-3-7-sonnet-20250219', { now: at('2026-10-19') })!.text).toBe('claude-3-7-sonnet-20250219 was retired on the Claude API on February 19, 2026: requests to it fail; Anthropic recommends claude-sonnet-5-5');
    expect(retirementOf('anthropic', 'claude-mythos-preview', { now: at('2026-10-19') })).toMatchObject({ state: 'deprecated', retires: null, days: null });
  });

  it('names the models a replacement offers, for a page to preview the switch to', () => {
    expect(retirementOf('anthropic', 'claude-sonnet-4-5-20250929', { now: at('2026-10-19') })!.replacements).toEqual(['claude-sonnet-5-5']);
    expect(retirementOf('vertex', 'gemini-2.5-flash-lite', { now: at('2026-10-19') })!.replacements).toEqual(['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
    expect(replacementModels('gpt-5.6-sol (reasoning.mode: pro)')).toEqual(['gpt-5.6-sol']);
    expect(replacementModels('gpt-5 or gpt-4.1')).toEqual(['gpt-5', 'gpt-4.1']);
    expect(replacementModels('o3')).toEqual(['o3']);
    // Every replacement the table holds names a model, but the one that names a kind of model.
    expect(models.filter((r) => r.replacement && !replacementModels(r.replacement).length).map((r) => r.replacement)).toEqual(['The most capable cyber model available to you.']);
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
    expect(retirementOf('vertex', 'publishers/google/models/gemini-2.0-flash', { now: at('2026-10-19') })).toMatchObject({ state: 'retired', retires: '2026-06-01', replacement: 'gemini-3.1-flash-lite' });
    expect(retirementOf('azure', 'gpt-4o-2024-08-06')).toBeNull();
  });

  it("matches a Vertex AI version to the model Google's pages name: Gemini's stable versions, Claude's after @", () => {
    const pro = retirementOf('vertex', 'gemini-2.5-pro', { now: at('2026-10-19') });
    expect(pro).toMatchObject({ state: 'retiring', retires: '2026-10-20', days: 1, source: platforms.vertex.url });
    expect(pro!.text).toBe('gemini-2.5-pro retires on Vertex AI on October 20, 2026, in 1 day; Google Cloud recommends gemini-3.8-flash or gemini-3.5-flash');
    expect(retirementOf('vertex', 'projects/p/locations/us-central1/publishers/google/models/gemini-2.0-flash-001', { now: at('2026-10-19') })).toMatchObject({ matched: 'gemini-2.0-flash', state: 'retired' });
    const sonnet = retirementOf('vertex', 'claude-3-7-sonnet@20250219', { now: at('2026-10-19') });
    expect(sonnet).toMatchObject({ matched: 'claude-3-7-sonnet', deprecated: '2025-11-11', retires: '2026-05-11', state: 'retired', replacement: null });
    expect(sonnet!.source).toMatch(/\/deprecations\/partner-models$/);
    // A model the page doesn't name is no match, whatever its version.
    expect(retirementOf('vertex', 'claude-sonnet-4-5@20250929', { now: at('2026-10-19') })).toBeNull();
    expect(retirementOf('vertex', 'gemini-3.8-flash-001', { now: at('2026-10-19') })).toBeNull();
  });

  it("names the computer use previews, an agent's models too", () => {
    expect(retirementOf('openai', 'computer-use-preview', { now: at('2026-10-19') })).toMatchObject({ state: 'retired', retires: '2026-07-23', replacement: 'gpt-5.6-terra' });
    expect(retirementOf('gemini', 'gemini-2.5-computer-use-preview-10-2025', { now: at('2026-10-19') })).toMatchObject({ earliest: true, retires: '2026-07-28', replacement: 'gemini-3.8-flash' });
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

  it('names a manual thinking budget on Claude 4.7 and later, with what the page says to send instead', () => {
    const [f] = retiredFields('anthropic', 'claude-sonnet-5-5', { thinking: { type: 'enabled', budget_tokens: 2048 } });
    expect(f).toMatchObject({ field: 'thinking', value: { type: 'enabled', budget_tokens: 2048 }, rule: { allowed: { thinking: { type: 'adaptive' } }, source: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking' } });
    // Adaptive thinking, thinking turned off, and a model that still takes a budget are left as they are.
    expect(retiredFields('anthropic', 'claude-sonnet-5-5', { thinking: { type: 'adaptive' } })).toEqual([]);
    expect(retiredFields('anthropic', 'claude-opus-4-8', { thinking: { type: 'disabled' } })).toEqual([]);
    expect(retiredFields('anthropic', 'claude-sonnet-4-6', { thinking: { type: 'enabled', budget_tokens: 2048 } })).toEqual([]);
    expect(retiredFields('anthropic', 'claude-mythos-preview', { thinking: { type: 'enabled', budget_tokens: 2048 } })).toEqual([]);
  });

  it('applies to Claude wherever a Messages API body is sent: Bedrock and Vertex AI, not Converse', () => {
    const messages = { anthropic_version: 'bedrock-2023-05-31', messages: [], temperature: 0.5 };
    expect(retiredFields('bedrock', 'us.anthropic.claude-opus-4-7', messages).map((f) => f.field)).toEqual(['temperature']);
    expect(retiredFields('bedrock', 'anthropic.claude-sonnet-4-5-20250929-v1:0', messages)).toEqual([]);
    expect(retiredFields('vertex', 'claude-sonnet-5-5', { ...messages, anthropic_version: 'vertex-2023-10-16' }).map((f) => f.field)).toEqual(['temperature']);
    expect(retiredFields('bedrock', 'anthropic.claude-opus-4-7', { messages: [], inferenceConfig: { temperature: 0.5 } })).toEqual([]);
    expect(retiredFields('vertex', 'gemini-2.5-pro', { contents: [], temperature: 0.5 })).toEqual([]);
  });
});
