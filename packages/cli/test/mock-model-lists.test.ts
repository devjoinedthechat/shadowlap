import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listModelChoices } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { startMockOpenAI, turn, type MockServer as OpenAIServer } from '@shadowlap-testing/mock-openai';

/**
 * The mock providers list their models the way the real Models APIs do, so what asks a provider for
 * its models (`tasks models`, the dashboard's Score model…) offers them when it is pointed at the
 * mocks, as the demo store is, instead of saying the list couldn't be read.
 */

let anthropic: MockServer;
let openai: OpenAIServer;

beforeAll(async () => {
  anthropic = await startMockAnthropic({ script: () => ({ message: message([text('ok')]) }), eventDelayMs: () => 0 });
  openai = await startMockOpenAI({ script: () => ({ turn: turn('ok') }) });
});
afterAll(async () => {
  await anthropic.close();
  await openai.close();
});

const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('the mock providers list their models', () => {
  it('as Anthropic\'s and OpenAI\'s Models APIs do, a page at a time and one by id', async () => {
    const all = await get(`${anthropic.url}/v1/models?limit=100`);
    expect(all).toEqual({
      status: 200,
      body: {
        data: [
          { type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-09-01T00:00:00Z' },
          { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2026-08-31T00:00:00Z' },
        ],
        has_more: false,
        first_id: 'claude-sonnet-5',
        last_id: 'claude-haiku-4-5',
      },
    });
    const first = await get(`${anthropic.url}/v1/models?limit=1`);
    expect(first.body).toMatchObject({ data: [{ id: 'claude-sonnet-5' }], has_more: true });
    const next = await get(`${anthropic.url}/v1/models?limit=1&after_id=claude-sonnet-5`);
    expect(next.body).toMatchObject({ data: [{ id: 'claude-haiku-4-5' }], has_more: false });
    expect((await get(`${anthropic.url}/v1/models/claude-haiku-4-5`)).body).toMatchObject({ id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' });
    expect((await get(`${anthropic.url}/v1/models/claude-nosuch`)).status).toBe(404);
    // Listing is not a model call: the scripted conversation never sees it.
    expect(anthropic.requests).toEqual([]);

    expect(await get(`${openai.url}/v1/models`)).toEqual({
      status: 200,
      body: {
        object: 'list',
        data: [
          { id: 'gpt-5', object: 'model', created: 1_788_220_800, owned_by: 'system' },
          { id: 'gpt-5-mini', object: 'model', created: 1_788_134_400, owned_by: 'system' },
        ],
      },
    });
    expect((await get(`${openai.url}/v1/models/gpt-5-mini`)).body).toMatchObject({ id: 'gpt-5-mini', object: 'model' });
    expect((await get(`${openai.url}/v1/models/gpt-nosuch`)).body).toMatchObject({ error: { code: 'model_not_found' } });
    expect(openai.requests).toEqual([]);
    expect(openai.otherRequests).toEqual([]);
  });

  it('lists the models it is given, and a model picker pointed at the mocks offers them', async () => {
    const own = await startMockAnthropic({ script: () => ({ message: message([text('ok')]) }), models: ['claude-opus-5-5'] });
    try {
      expect((await get(`${own.url}/v1/models`)).body).toMatchObject({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] });
    } finally {
      await own.close();
    }

    // As the demo store's commands run: the providers' upstreams are the mocks, with a placeholder
    // key. Ollama is asked at a port nothing listens on and fetch doesn't block.
    const listing = await listModelChoices({
      recorded: [{ model: 'claude-sonnet-5', provider: 'anthropic' }],
      tokens: { inputTokens: 1000, outputTokens: 100 },
      env: { SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url, ANTHROPIC_API_KEY: 'demo-key', SHADOWLAP_UPSTREAM_OPENAI: openai.url, OLLAMA_HOST: '127.0.0.1:2' },
    });
    expect(listing.choices.map((c) => [c.group, c.id])).toEqual([
      ['Recorded with', 'claude-sonnet-5'],
      ['Anthropic API', 'claude-haiku-4-5'],
      ['OpenAI-compatible, on this machine', 'gpt-5'],
      ['OpenAI-compatible, on this machine', 'gpt-5-mini'],
    ]);
    expect(listing.notes).toEqual([{ group: 'Ollama, on this machine', note: "isn't running" }]);
  });
});
