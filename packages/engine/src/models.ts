import { estimateCost, type Price } from './prices.js';
import type { Usage } from './types.js';

/**
 * Models to score on the tasks: the model the recordings used, every model each configured provider
 * lists (Anthropic's and OpenAI's `/v1/models`, with the keys already in the environment, and the
 * models Ollama has installed on this machine), and endpoints scored before. Each comes with what an
 * attempt would cost: its price times the tokens the recordings used after their takeovers. A model
 * on this machine costs nothing. Listing never waits long and never fails: a provider that doesn't
 * answer, or has no key, becomes a note.
 */

export interface ModelChoice {
  /** `Recorded with`, `Anthropic API`, `OpenAI API`, `Ollama, on this machine`, `Endpoints scored before`. */
  group: string;
  id: string;
  /** Where it runs, in words. */
  via: string;
  /** The OpenAI-compatible endpoint it is asked at, or null for a provider's own API. */
  baseUrl: string | null;
  /** What `shadowlap tasks score` takes to ask it: `--model …` and, for an endpoint, `--base-url …`. */
  flags: string[];
  /** USD per attempt, estimated; 0 on this machine; null without a price or a recording to estimate from. */
  perAttempt: number | null;
  /** It runs on this machine (a loopback endpoint): not a paid API. */
  local: boolean;
}

export interface ModelListing {
  choices: ModelChoice[];
  /** Providers that couldn't be listed, and why. */
  notes: Array<{ group: string; note: string }>;
  /** The tokens an attempt is expected to use after its takeover, which prices are estimated from. */
  tokens: Usage | null;
}

export interface ListModelsInput {
  /** The models the tasks' recordings asked at their takeovers, and each one's provider. */
  recorded: Array<{ model: string; provider: string | null }>;
  /** Models scored before: the model, the endpoint it was asked at, and where it ran. */
  scored?: Array<{ model: string; baseUrl: string | null; via: string | null }>;
  tokens: Usage | null;
  prices?: Record<string, Price>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Per listing request; they run at once. Default 1500 ms. */
  timeoutMs?: number;
}

export const OFFICIAL = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com/v1' } as const;
const OLLAMA = 'http://127.0.0.1:11434';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const trim = (u: string) => u.trim().replace(/\/+$/, '');

/** Whether a URL is on this machine. */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** Where OpenAI-compatible calls go: SHADOWLAP_UPSTREAM_OPENAI (a server root), OPENAI_BASE_URL (with /v1), or the API. */
export function openAIBase(env: NodeJS.ProcessEnv): string {
  const upstream = env.SHADOWLAP_UPSTREAM_OPENAI?.trim();
  if (upstream && /^https?:\/\//.test(upstream)) return `${trim(upstream)}/v1`;
  const base = env.OPENAI_BASE_URL?.trim();
  if (base && /^https?:\/\//.test(base) && !/\/t\/[0-9a-f]{32}(\/|$)/.test(base)) return trim(base);
  return OFFICIAL.openai;
}

/** Where Anthropic calls go: SHADOWLAP_UPSTREAM_ANTHROPIC, ANTHROPIC_BASE_URL, or the API. */
export function anthropicBase(env: NodeJS.ProcessEnv): string {
  for (const v of [env.SHADOWLAP_UPSTREAM_ANTHROPIC, env.ANTHROPIC_BASE_URL]) {
    const value = v?.trim();
    if (value && /^https?:\/\//.test(value) && !/\/t\/[0-9a-f]{32}(\/|$)/.test(value)) return trim(value);
  }
  return OFFICIAL.anthropic;
}

/** Ollama's address: OLLAMA_HOST (`host:port` or a URL), else its default on this machine. */
export function ollamaBase(env: NodeJS.ProcessEnv): string {
  const raw = env.OLLAMA_HOST?.trim();
  if (!raw) return OLLAMA;
  const url = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(url);
    // Ollama listens on 0.0.0.0 when told to; it is asked on this machine.
    if (u.hostname === '0.0.0.0') u.hostname = '127.0.0.1';
    if (!u.port && !/^https?:\/\/[^/]+:\d+/.test(url)) u.port = '11434';
    return trim(u.toString());
  } catch {
    return OLLAMA;
  }
}

/** Where a model at an endpoint runs, in words. */
export function endpointVia(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    if (isLoopback(baseUrl)) return u.port === '11434' ? 'Ollama, on this machine' : 'on this machine';
    if (`${u.protocol}//${u.host}` === new URL(OFFICIAL.openai).origin) return 'OpenAI API';
    return u.host;
  } catch {
    return 'your endpoint';
  }
}

/** OpenAI's list holds embeddings, speech and image models too; these are the ones a chat agent can use. */
function chatModel(id: string): boolean {
  return /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|tts|transcribe|search|image|embedding|moderation|instruct|dall-e|whisper)/.test(id);
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

function reason(err: unknown, what: string): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `${what} didn't answer in time`;
  if (e?.cause?.code === 'ECONNREFUSED') return `${what} isn't running`;
  return `${what} couldn't be listed (${e?.message ?? String(err)})`;
}

const recordedProvider = (input: ListModelsInput) => {
  const providers = new Set(input.recorded.map((r) => r.provider ?? ''));
  return providers.size === 1 ? [...providers][0]! : null;
};

/** The model choices for a set of tasks. */
export async function listModelChoices(input: ListModelsInput): Promise<ModelListing> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 1500;
  const price = (id: string, local: boolean) => (local ? 0 : input.tokens ? estimateCost(id, input.tokens, input.prices) : null);
  const choices: ModelChoice[] = [];
  const notes: ModelListing['notes'] = [];
  const has = (id: string, baseUrl: string | null) => choices.some((c) => c.id === id && c.baseUrl === baseUrl);
  const add = (c: ModelChoice) => {
    if (!has(c.id, c.baseUrl)) choices.push(c);
  };
  const own = recordedProvider(input);

  for (const r of input.recorded) add({ group: 'Recorded with', id: r.model, via: 'the recorded model', baseUrl: null, flags: ['--model', r.model], perAttempt: price(r.model, false), local: false });

  const anthropic = async (): Promise<ModelChoice[]> => {
    const key = env.ANTHROPIC_API_KEY?.trim();
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
    const base = anthropicBase(env);
    const body = await getJson(fetchImpl, `${base}/v1/models?limit=100`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, timeoutMs);
    const data = isObject(body) && Array.isArray(body.data) ? body.data : [];
    return data.flatMap((m) => (isObject(m) && typeof m.id === 'string' ? [{ group: 'Anthropic API', id: m.id, via: 'Anthropic API', baseUrl: null, flags: ['--model', own === 'anthropic' ? m.id : `anthropic:${m.id}`], perAttempt: price(m.id, false), local: false }] : []));
  };
  const openai = async (): Promise<ModelChoice[]> => {
    const base = openAIBase(env);
    const official = base === OFFICIAL.openai;
    const key = env.OPENAI_API_KEY?.trim();
    if (official && !key) throw new Error('OPENAI_API_KEY is not set');
    const body = await getJson(fetchImpl, `${base}/models`, key ? { authorization: `Bearer ${key}` } : {}, timeoutMs);
    const data = isObject(body) && Array.isArray(body.data) ? body.data : [];
    const ids = data.flatMap((m) => (isObject(m) && typeof m.id === 'string' ? [m.id] : [])).filter((id) => !official || chatModel(id)).sort();
    const local = isLoopback(base);
    return ids.map((id) =>
      official
        ? { group: 'OpenAI API', id, via: 'OpenAI API', baseUrl: null, flags: ['--model', own === 'openai' ? id : `openai:${id}`], perAttempt: price(id, false), local: false }
        : { group: `OpenAI-compatible, ${endpointVia(base)}`, id, via: endpointVia(base), baseUrl: base, flags: ['--model', id, '--base-url', base], perAttempt: price(id, local), local },
    );
  };
  const ollama = async (): Promise<ModelChoice[]> => {
    const base = ollamaBase(env);
    const body = await getJson(fetchImpl, `${base}/api/tags`, {}, timeoutMs);
    const models = isObject(body) && Array.isArray(body.models) ? body.models : [];
    const local = isLoopback(base);
    const group = local ? 'Ollama, on this machine' : `Ollama, ${new URL(base).host}`;
    const names = models.flatMap((m) => (isObject(m) && typeof m.name === 'string' ? [m.name] : [])).sort();
    return names.map((name) => ({ group, id: name, via: group, baseUrl: `${base}/v1`, flags: ['--model', name, '--base-url', `${base}/v1`], perAttempt: price(name, local), local }));
  };

  const listed = await Promise.allSettled([anthropic(), openai(), ollama()]);
  const openaiAt = openAIBase(env);
  const ollamaAt = ollamaBase(env);
  const names = ['Anthropic API', openaiAt === OFFICIAL.openai ? 'OpenAI API' : `OpenAI-compatible, ${endpointVia(openaiAt)}`, isLoopback(ollamaAt) ? 'Ollama, on this machine' : `Ollama, ${new URL(ollamaAt).host}`];
  listed.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const c of r.value) add(c);
      if (!r.value.length) notes.push({ group: names[i]!, note: i === 2 ? 'no models installed' : 'no models listed' });
    } else {
      const err = r.reason as Error;
      notes.push({ group: names[i]!, note: /is not set$/.test(err?.message ?? '') ? err.message : reason(err, i === 2 ? 'Ollama' : names[i]!) });
    }
  });

  for (const s of input.scored ?? []) {
    if (has(s.model, s.baseUrl)) continue;
    const local = s.baseUrl ? isLoopback(s.baseUrl) : false;
    const flags = s.baseUrl ? ['--model', s.model, '--base-url', s.baseUrl] : ['--model', s.via === 'OpenAI API' ? `openai:${s.model}` : s.via === 'Anthropic API' ? `anthropic:${s.model}` : s.model];
    add({ group: 'Endpoints scored before', id: s.model, via: s.via ?? (s.baseUrl ? endpointVia(s.baseUrl) : 'the recorded provider'), baseUrl: s.baseUrl, flags, perAttempt: price(s.model, local), local });
  }
  return { choices, notes, tokens: input.tokens };
}
