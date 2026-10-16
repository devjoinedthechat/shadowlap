import { describe, expect, it } from 'vitest';
import { anthropicBase, choiceTarget, endpointVia, isLoopback, listingInput, listModelChoices, mainRefusal, modelReach, ollamaBase, openAIBase, refusedLine } from '../src/models.js';
import type { TaskScoreRow } from '../src/store.js';
import type { Task } from '../src/tasks.js';

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
    expect(listing.choices).toEqual([{ group: 'Recorded with', id: 'gpt-5-mini', via: 'the recorded model', where: 'OpenAI API', baseUrl: null, flags: ['--model', 'gpt-5-mini'], perAttempt: null, local: false, provider: 'openai' }]);
    expect(listing.notes).toEqual([
      { group: 'Anthropic API', note: 'ANTHROPIC_API_KEY is not set' },
      { group: 'OpenAI API', note: "didn't answer in time" },
      { group: 'Ollama, on this machine', note: "isn't running" },
    ]);
    // No key, no request: nothing is sent to a provider without one.
    expect(asked.some((u) => u.includes('anthropic'))).toBe(false);
  });

  it('asks no provider when told not to, and lists only the recorded models and those scored before', async () => {
    const { fetch, asked } = fakeFetch({ 'https://api.anthropic.com/v1/models?limit=100': { body: { data: [{ id: 'claude-haiku-4-5' }] } } });
    const listing = await listModelChoices({ recorded: [{ model: 'claude-sonnet-5', provider: 'anthropic' }], scored: [{ model: 'my-finetune', baseUrl: 'http://127.0.0.1:8000/v1', via: 'on this machine' }], tokens: TOKENS, env: { ANTHROPIC_API_KEY: 'sk-ant' }, fetch, ask: false });
    expect(asked).toEqual([]);
    expect(listing.notes).toEqual([]);
    expect(listing.choices.map((c) => [c.group, c.id])).toEqual([
      ['Recorded with', 'claude-sonnet-5'],
      ['Endpoints scored before', 'my-finetune'],
    ]);
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

  it('takes the recorded models, the models scored before and the tokens to price from the tasks', () => {
    const task = (golden: string, status: Task['status'], model: string, inputTokens: number): Task => ({ golden, name: golden, status, note: null, runId: 'r', takeover: { callNo: 5, why: 'w', from: 'config' }, scope: null, scopes: [null], rewards: null, checks: [], after: { live: [], stubbed: [] }, prefix: 4, model, provider: 'anthropic', callName: 'POST /v1/messages', tokensAfter: { inputTokens, outputTokens: 100 } });
    const row = (model: string, baseUrl: string | null, attempt: number): TaskScoreRow => ({ model, baseUrl, golden: 'a', attempt, runId: null, score: 1, checks: [], spent: 0, via: baseUrl ? 'on this machine' : 'Anthropic API', session: 's', at: 1 });
    const input = listingInput([task('a', 'ready', 'claude-sonnet-5', 1000), task('b', 'ready', 'claude-sonnet-5', 3000), task('c', 'blocked', 'claude-opus-5', 9000)], [row('qwen', 'http://127.0.0.1:11434/v1', 1), row('qwen', 'http://127.0.0.1:11434/v1', 2), row('claude-haiku-4-5', null, 1)]);
    // Only ready tasks: a blocked one is neither scored nor priced.
    expect(input.recorded).toEqual([{ model: 'claude-sonnet-5', provider: 'anthropic' }]);
    expect(input.scored).toEqual([
      { model: 'qwen', baseUrl: 'http://127.0.0.1:11434/v1', via: 'on this machine' },
      { model: 'claude-haiku-4-5', baseUrl: null, via: 'Anthropic API' },
    ]);
    expect(input.tokens).toEqual({ inputTokens: 2000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });

  it('knows where things run', () => {
    expect(isLoopback('http://localhost:8000/v1')).toBe(true);
    expect(isLoopback('http://[::1]:8000/v1')).toBe(true);
    expect(isLoopback('https://api.openai.com/v1')).toBe(false);
    expect(endpointVia('http://127.0.0.1:11434/v1', {})).toBe('Ollama, on this machine');
    expect(endpointVia('http://127.0.0.1:8000/v1', {})).toBe('on this machine');
    expect(endpointVia('https://api.openai.com/v1', {})).toBe('OpenAI API');
    expect(endpointVia('https://gpu.example.com/v1', {})).toBe('gpu.example.com');
    // Ollama where OLLAMA_HOST puts it is named as its model list is, so a model listed there keeps the name once scored.
    expect(endpointVia('http://127.0.0.1:11500/v1', { OLLAMA_HOST: '0.0.0.0:11500' })).toBe('Ollama, on this machine');
    expect(endpointVia('http://localhost:11500/v1', { OLLAMA_HOST: '127.0.0.1:11500' })).toBe('Ollama, on this machine');
    expect(endpointVia('http://gpu-box:11434/v1', { OLLAMA_HOST: 'gpu-box' })).toBe('Ollama, gpu-box:11434');
    expect(endpointVia('http://gpu-box:11434/v1', {})).toBe('gpu-box:11434');
    expect(endpointVia('http://127.0.0.1:11434/v1', { OLLAMA_HOST: '127.0.0.1:11500' })).toBe('Ollama, on this machine');
    expect(openAIBase({ OPENAI_BASE_URL: 'http://localhost:11434/v1/' })).toBe('http://localhost:11434/v1');
    expect(openAIBase({})).toBe('https://api.openai.com/v1');
    expect(anthropicBase({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:5555/t/0123456789abcdef0123456789abcdef/anthropic' })).toBe('https://api.anthropic.com');
    expect(ollamaBase({ OLLAMA_HOST: '0.0.0.0:11500' })).toBe('http://127.0.0.1:11500');
    expect(ollamaBase({})).toBe('http://127.0.0.1:11434');
  });
});

describe('which ready tasks a listed model can answer', () => {
  const task = (golden: string, provider: string | null, callName: string, status: Task['status'] = 'ready'): Task => ({ golden, name: golden.split('/').at(-1)!, status, note: null, runId: 'r', takeover: { callNo: 5, why: 'w', from: 'config' }, scope: null, scopes: [null], rewards: null, checks: [], after: { live: [], stubbed: [] }, prefix: 4, model: 'm', provider, callName, tokensAfter: null });
  const choice = (id: string, flags: string[], baseUrl: string | null = null, provider?: string) => ({ id, flags, baseUrl, ...(provider ? { provider } : {}) });

  it('reads how tasks score asks a model from the flags it takes', () => {
    expect(choiceTarget(choice('q', ['--model', 'q', '--base-url', 'http://127.0.0.1:11434/v1'], 'http://127.0.0.1:11434/v1'))).toEqual({ route: 'openai-chat', scoreBase: 'http://127.0.0.1:11434/v1' });
    expect(choiceTarget(choice('h', ['--model', 'anthropic:h']))).toEqual({ route: 'anthropic', scoreBase: null });
    expect(choiceTarget(choice('g', ['--model', 'openai:g']))).toEqual({ route: 'openai-chat', scoreBase: null });
    expect(choiceTarget(choice('s', ['--model', 's']))).toEqual({ route: 'same', scoreBase: null });
  });

  it('answers every cloud through a translation, refuses another model of a cloud, and a model of another provider', () => {
    const tasks = [
      task('goldens/azure', 'azure', 'POST /openai/deployments/gpt-prod/chat/completions'),
      task('goldens/converse', 'bedrock', 'POST /model/amazon.nova-pro-v1%3A0/converse'),
      task('goldens/gemini', 'gemini', 'POST /v1beta/models/gemini-2.5-flash:generateContent'),
      task('goldens/blocked', 'anthropic', 'POST /v1/messages', 'blocked'),
    ];
    // A model at your endpoint answers all three ready tasks; a blocked one isn't counted.
    expect(modelReach(choice('q', ['--model', 'q', '--base-url', 'http://127.0.0.1:11434/v1'], 'http://127.0.0.1:11434/v1'), tasks)).toEqual({ tasks: ['goldens/azure', 'goldens/converse', 'goldens/gemini'], refused: [] });
    expect(modelReach(choice('h', ['--model', 'anthropic:h']), tasks).tasks).toHaveLength(3);
    // Another Gemini model answers the Gemini task only: Azure's deployment picks its model, and the other is another provider's recording.
    const gemini = modelReach(choice('gemini-2.5-pro', ['--model', 'gemini-2.5-pro'], null, 'gemini'), tasks);
    expect(gemini.tasks).toEqual(['goldens/gemini']);
    expect(gemini.refused.map((r) => r.why)).toEqual(['it was recorded on Azure OpenAI, and gemini-2.5-pro is asked of the Gemini API', 'it was recorded on Amazon Bedrock, and gemini-2.5-pro is asked of the Gemini API']);
    expect(modelReach(choice('gpt-other', ['--model', 'gpt-other'], null, 'azure'), tasks).refused[0]!.why).toContain('the deployment in the URL picks the model');
  });

  it('scores the model a cloud recording used on that recording, nothing switched, and still no other model of that cloud', () => {
    const own = (golden: string, provider: string, callName: string, model: string): Task => ({ ...task(golden, provider, callName), model });
    const tasks = [
      own('goldens/azure', 'azure', 'POST /openai/deployments/gpt-prod/chat/completions', 'gpt-prod'),
      own('goldens/converse', 'bedrock', 'POST /model/amazon.nova-pro-v1%3A0/converse', 'amazon.nova-pro-v1:0'),
      own('goldens/vertex', 'vertex', 'POST /v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-5:rawPredict', 'claude-sonnet-5'),
    ];
    // Each answers its own recording: the deployment, the signed URL and the regional address stay as the agent made them.
    expect(modelReach(choice('gpt-prod', ['--model', 'gpt-prod'], null, 'azure'), tasks).tasks).toEqual(['goldens/azure']);
    expect(modelReach(choice('amazon.nova-pro-v1:0', ['--model', 'amazon.nova-pro-v1:0'], null, 'bedrock'), tasks).tasks).toEqual(['goldens/converse']);
    expect(modelReach(choice('claude-sonnet-5', ['--model', 'claude-sonnet-5'], null, 'vertex'), tasks).tasks).toEqual(['goldens/vertex']);
    // Another model of the cloud still can't be asked there, and the recorded one not on another provider's recording.
    const lite = modelReach(choice('amazon.nova-lite-v1:0', ['--model', 'amazon.nova-lite-v1:0'], null, 'bedrock'), tasks);
    expect(lite.tasks).toEqual([]);
    expect(lite.refused.find((r) => r.golden === 'goldens/converse')!.why).toContain('request signature covers the model in its URL');
    expect(modelReach(choice('gpt-prod', ['--model', 'gpt-prod'], null, 'azure'), tasks).refused.map((r) => [r.golden, r.elsewhere])).toEqual([['goldens/converse', true], ['goldens/vertex', true]]);
  });

  it('says first why its own provider\'s task refuses a model, and groups the tasks it leaves out by why', () => {
    const tasks = [
      task('goldens/azure', 'azure', 'POST /openai/deployments/gpt-prod/chat/completions'),
      task('goldens/bedrock-claude', 'bedrock', 'POST /model/anthropic.claude-sonnet-5-v1%3A0/invoke'),
      task('goldens/converse', 'bedrock', 'POST /model/amazon.nova-pro-v1%3A0/converse'),
      task('goldens/gemini', 'gemini', 'POST /v1beta/models/gemini-2.5-flash:generateContent'),
      task('goldens/vertex', 'vertex', 'POST /v1/projects/p/locations/us-east5/publishers/google/models/gemini-2.5-flash:generateContent'),
    ];
    // Another model of Bedrock: the Azure task is listed first, but Bedrock's own refusal says more.
    const nova = modelReach(choice('amazon.nova-lite-v1:0', ['--model', 'amazon.nova-lite-v1:0'], null, 'bedrock'), tasks);
    expect(nova.tasks).toEqual([]);
    expect(nova.refused[0]!.elsewhere).toBe(true);
    expect(mainRefusal(nova)).toMatchObject({ name: 'bedrock-claude', elsewhere: false });
    expect(mainRefusal({ tasks: [], refused: [] })).toBeNull();
    // A Gemini model answers its own task: the three recorded on other clouds are one reason, not three.
    const gemini = modelReach(choice('gemini-2.5-flash', ['--model', 'gemini-2.5-flash'], null, 'gemini'), tasks);
    expect(gemini.tasks).toEqual(['goldens/gemini']);
    expect(refusedLine({ provider: 'gemini' }, gemini)).toBe('azure, bedrock-claude, converse, vertex: recorded on Azure OpenAI, Amazon Bedrock and Vertex AI, not the Gemini API');
    // Reasons of their own are grouped by their words, after the tasks recorded elsewhere.
    expect(refusedLine({ provider: 'bedrock' }, nova)).toBe(`azure, gemini, vertex: recorded on Azure OpenAI, the Gemini API and Vertex AI, not Amazon Bedrock; bedrock-claude, converse: ${nova.refused.find((r) => r.name === 'bedrock-claude')!.why}`);
    expect(refusedLine({ provider: 'gemini' }, { tasks: ['goldens/gemini'], refused: [] })).toBeNull();
  });
});
