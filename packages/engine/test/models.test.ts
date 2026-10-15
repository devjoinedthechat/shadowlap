import { describe, expect, it } from 'vitest';
import { anthropicBase, endpointVia, isLoopback, listModelChoices, ollamaBase, openAIBase } from '../src/models.js';

/**
 * Models to score, listed from each configured provider. No network: the providers are a fake fetch
 * that answers by URL, refuses a connection, or never answers.
 */

type Route = { status?: number; body?: unknown; refuse?: boolean; hang?: boolean; headers?: (h: Record<string, string>) => void };

function fakeFetch(routes: Record<string, Route>): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    const r = routes[url];
    if (!r || r.refuse) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    r.headers?.((init?.headers ?? {}) as Record<string, string>);
    if (r.hang) {
      await new Promise<void>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))));
    }
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: impl, asked };
}

const TOKENS = { inputTokens: 10_000, outputTokens: 1_000 };

describe('models to score', () => {
  it('lists the recorded model, each provider\'s models with a price per attempt, and endpoints scored before', async () => {
    let anthropicKey = '';
    const { fetch } = fakeFetch({
      'https://api.anthropic.com/v1/models?limit=100': { body: { data: [{ id: 'claude-haiku-4-5', type: 'model' }, { id: 'claude-opus-5-5', type: 'model' }] }, headers: (h) => (anthropicKey = h['x-api-key'] ?? '') },
      'https://api.openai.com/v1/models': { body: { data: [{ id: 'gpt-5-mini' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4o-realtime-preview' }, { id: 'whisper-1' }] } },
      'http://127.0.0.1:11434/api/tags': { body: { models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:8b' }] } },
    });
    const listing = await listModelChoices({
      recorded: [{ model: 'claude-sonnet-5', provider: 'anthropic' }],
      scored: [{ model: 'my-finetune', baseUrl: 'http://127.0.0.1:8000/v1', via: 'on this machine' }, { model: 'claude-haiku-4-5', baseUrl: null, via: 'Anthropic API' }],
      tokens: TOKENS,
      env: { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai' },
      fetch,
    });
    expect(anthropicKey).toBe('sk-ant');
    expect(listing.notes).toEqual([]);
    expect(listing.choices.map((c) => [c.group, c.id, c.flags.join(' '), c.perAttempt === null ? null : Number(c.perAttempt.toFixed(4)), c.local])).toEqual([
      ['Recorded with', 'claude-sonnet-5', '--model claude-sonnet-5', 0.03, false],
      ['Anthropic API', 'claude-haiku-4-5', '--model claude-haiku-4-5', 0.015, false],
      ['Anthropic API', 'claude-opus-5-5', '--model claude-opus-5-5', 0.06, false],
      ['OpenAI API', 'gpt-5-mini', '--model openai:gpt-5-mini', 0.0045, false],
      ['Ollama, on this machine', 'llama3.1:8b', '--model llama3.1:8b --base-url http://127.0.0.1:11434/v1', 0, true],
      ['Ollama, on this machine', 'qwen2.5:7b', '--model qwen2.5:7b --base-url http://127.0.0.1:11434/v1', 0, true],
      ['Endpoints scored before', 'my-finetune', '--model my-finetune --base-url http://127.0.0.1:8000/v1', 0, true],
    ]);
    expect(listing.tokens).toEqual(TOKENS);
  });

  it('turns a provider with no key, no server or no answer into a note, and still lists the rest', async () => {
    const { fetch, asked } = fakeFetch({
      'https://api.openai.com/v1/models': { hang: true },
      'http://127.0.0.1:11434/api/tags': { refuse: true },
    });
    const listing = await listModelChoices({ recorded: [{ model: 'gpt-5-mini', provider: 'openai' }], tokens: null, env: { OPENAI_API_KEY: 'k' }, fetch, timeoutMs: 50 });
    expect(listing.choices).toEqual([{ group: 'Recorded with', id: 'gpt-5-mini', via: 'the recorded model', baseUrl: null, flags: ['--model', 'gpt-5-mini'], perAttempt: null, local: false }]);
    expect(listing.notes).toEqual([
      { group: 'Anthropic API', note: 'ANTHROPIC_API_KEY is not set' },
      { group: 'OpenAI API', note: "OpenAI API didn't answer in time" },
      { group: 'Ollama, on this machine', note: "Ollama isn't running" },
    ]);
    // No key, no request: nothing is sent to a provider without one.
    expect(asked.some((u) => u.includes('anthropic'))).toBe(false);
  });

  it('asks the servers the environment points at, and names an OpenAI-compatible one by its host', async () => {
    const { fetch } = fakeFetch({
      'http://127.0.0.1:9001/v1/models?limit=100': { body: { data: [{ id: 'claude-haiku-4-5' }] } },
      'http://127.0.0.1:9002/v1/models': { body: { data: [{ id: 'my-finetune' }] } },
      'http://10.0.0.5:11434/api/tags': { body: { models: [{ name: 'qwen3:32b' }] } },
    });
    const env = { ANTHROPIC_API_KEY: 'k', SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9001', SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:9002', OLLAMA_HOST: '10.0.0.5' };
    const listing = await listModelChoices({ recorded: [], tokens: TOKENS, env, fetch });
    expect(listing.choices.map((c) => [c.group, c.id, c.flags.join(' ')])).toEqual([
      ['Anthropic API', 'claude-haiku-4-5', '--model anthropic:claude-haiku-4-5'],
      ['OpenAI-compatible, on this machine', 'my-finetune', '--model my-finetune --base-url http://127.0.0.1:9002/v1'],
      ['Ollama, 10.0.0.5:11434', 'qwen3:32b', '--model qwen3:32b --base-url http://10.0.0.5:11434/v1'],
    ]);
    // A model on another machine has no price, rather than a made-up one.
    expect(listing.choices[2]!.perAttempt).toBeNull();
  });

  it('knows where things run', () => {
    expect(isLoopback('http://localhost:8000/v1')).toBe(true);
    expect(isLoopback('http://[::1]:8000/v1')).toBe(true);
    expect(isLoopback('https://api.openai.com/v1')).toBe(false);
    expect(endpointVia('http://127.0.0.1:11434/v1')).toBe('Ollama, on this machine');
    expect(endpointVia('http://127.0.0.1:8000/v1')).toBe('on this machine');
    expect(endpointVia('https://api.openai.com/v1')).toBe('OpenAI API');
    expect(endpointVia('https://gpu.example.com/v1')).toBe('gpu.example.com');
    expect(openAIBase({ OPENAI_BASE_URL: 'http://localhost:11434/v1/' })).toBe('http://localhost:11434/v1');
    expect(openAIBase({})).toBe('https://api.openai.com/v1');
    expect(anthropicBase({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:5555/t/0123456789abcdef0123456789abcdef/anthropic' })).toBe('https://api.anthropic.com');
    expect(ollamaBase({ OLLAMA_HOST: '0.0.0.0:11500' })).toBe('http://127.0.0.1:11500');
    expect(ollamaBase({})).toBe('http://127.0.0.1:11434');
  });
});
