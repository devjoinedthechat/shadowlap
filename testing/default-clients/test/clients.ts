import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { message, startMockAnthropic, text, type MockServer as AnthropicMock } from '@shadowlap-testing/mock-anthropic';
import { startMockGemini, turn as geminiTurn, type MockServer as GeminiMock } from '@shadowlap-testing/mock-gemini';
import { startMockOpenAI, turn as openaiTurn, type MockServer as OpenAIMock } from '@shadowlap-testing/mock-openai';
import { providers } from '@shadowlap/sidecar';

/**
 * What the tests here share: agents that build their model clients the default way, the providers
 * they call as mocks on this machine, each of which logs every request it gets with its headers, and
 * the environment of a CI job without secrets, in which the shadowlap CLI runs them.
 */

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const HERE = fileURLToPath(new URL('../', import.meta.url));
export const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
export const node = (agent: string) => [process.execPath, join(HERE, agent)];

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'azure' | 'bedrock';
export interface Seen {
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The text a request ends with, from any of the shapes here. */
const lastText = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: { text?: string }) => p?.text ?? '').join('') : JSON.stringify(content);
const echo = (content: unknown) => `echo: ${lastText(content)}`;

/** A front of its own for a provider the mocks don't speak: it logs each request, then answers it. */
async function front(handle: (path: string, body: Record<string, unknown>, res: ServerResponse) => void, seen: Seen[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://front');
      seen.push({ path: url.pathname + url.search, headers: req.headers });
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        // not JSON
      }
      handle(url.pathname, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) }).end(data);
};

export interface Providers {
  /** Each provider's upstream, as SHADOWLAP_UPSTREAM_<PROVIDER> names it. */
  urls: Record<ProviderId, string>;
  /** The requests each provider got, in order. */
  seen(provider: ProviderId): Seen[];
  /** Every request any provider got. */
  all(): Seen[];
  close(): Promise<void>;
}

/**
 * The providers, each on a port of its own so in-process capture tells them apart by host: the
 * Anthropic, OpenAI and Gemini mocks, and fronts that answer Azure OpenAI (as OpenAI does) and
 * Bedrock (InvokeModel as Anthropic does, and Converse). Every answer echoes the prompt, so a changed
 * prompt is a changed request.
 */
export async function startProviders(): Promise<Providers> {
  const anthropic: AnthropicMock = await startMockAnthropic({ eventDelayMs: () => 0, script: ({ request: r }) => ({ message: message([text(echo(r.messages.at(-1)?.content))]) }) });
  const openai: OpenAIMock = await startMockOpenAI({ script: ({ request: r }) => ({ turn: openaiTurn(echo(r.messages.at(-1)?.content)) }) });
  const gemini: GeminiMock = await startMockGemini({ script: ({ request: r }) => ({ turn: geminiTurn(echo(r.contents.at(-1)?.parts)) }) });
  const azureSeen: Seen[] = [];
  const bedrockSeen: Seen[] = [];
  const said = (body: Record<string, unknown>) => echo((body.messages as Array<{ content?: unknown }> | undefined)?.at(-1)?.content);
  const azure = await front((path, body, res) => {
    const m = /^\/openai\/deployments\/([^/]+)\/chat\/completions$/.exec(path);
    if (!m) return json(res, 404, { error: { message: `no route ${path}` } });
    json(res, 200, { id: `chatcmpl-${azureSeen.length}`, object: 'chat.completion', created: 1, model: decodeURIComponent(m[1]), choices: [{ index: 0, message: { role: 'assistant', content: said(body) }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  }, azureSeen);
  const bedrock = await front((path, body, res) => {
    const invoke = /^\/model\/([^/]+)\/invoke$/.exec(path);
    if (invoke) return json(res, 200, { id: `msg_${bedrockSeen.length}`, type: 'message', role: 'assistant', model: decodeURIComponent(invoke[1]), content: [{ type: 'text', text: said(body) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } });
    if (/^\/model\/[^/]+\/converse$/.test(path)) return json(res, 200, { output: { message: { role: 'assistant', content: [{ text: said(body) }] } }, stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, metrics: { latencyMs: 1 } });
    json(res, 404, { message: `no route ${path}` });
  }, bedrockSeen);
  const seen = (p: ProviderId): Seen[] =>
    p === 'anthropic' ? anthropic.requests.map((r) => ({ path: '/v1/messages', headers: r.headers })) : p === 'openai' ? openai.requests.map((r) => ({ path: '/v1/chat/completions', headers: r.headers })) : p === 'gemini' ? gemini.requests.map((r) => ({ path: r.path, headers: r.headers })) : p === 'azure' ? azureSeen : bedrockSeen;
  return {
    urls: { anthropic: anthropic.url, openai: openai.url, gemini: gemini.url, azure: azure.url, bedrock: bedrock.url },
    seen,
    all: () => [...seen('anthropic'), ...seen('openai'), ...seen('gemini'), ...azureSeen, ...bedrockSeen],
    async close() {
      await Promise.all([anthropic.close(), openai.close(), gemini.close(), new Promise((r) => azure.server.close(r)), new Promise((r) => bedrock.server.close(r))]);
    },
  };
}

/** Every variable any provider's SDKs take a credential from. */
const CREDENTIALS = providers.flatMap((p) => p.keys?.credentials ?? []);

/** A folder for a test's project and stores, and one that stands for a home with no sign-ins in it. */
/**
 * Adds `paths` to the git index of `dir`, made a repository if it isn't one, as CI's checkout holds
 * the goldens a repository committed: `shadowlap test` runs the command of a pack the repository
 * tracks without asking, and asks of any other, which a job without a terminal doesn't run. Added
 * whatever ignores them: a store kept in `dir` itself gives it a `.gitignore` of everything.
 */
export function committed(dir: string, ...paths: string[]): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['add', '-f', '--', ...paths], { cwd: dir, stdio: 'ignore' });
}

export function workdir(prefix: string): { dir: string; empty: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const empty = mkdtempSync(join(tmpdir(), 'sl-no-sign-in-'));
  return { dir, empty, remove: () => [dir, empty].forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })) };
}

/**
 * The environment of a CI job without secrets: no key, no sign-in (an empty folder for the Anthropic
 * profile and the Azure CLI, no AWS shared files, no instance role), the mocks as the upstreams, and
 * `extra`. Azure OpenAI's endpoint is a resource's, and Bedrock's the region's: in-process capture
 * takes their calls by those hosts, offline too, and the sidecar sends them to the fronts. Of the
 * SHADOWLAP_ variables, only the run's own home for this machine's files is kept (testing/no-stray-stores.mjs).
 * PROMPT, which the agents ask the model, is left out too: on Windows it holds cmd's own prompt ($P$G).
 */
export function ciEnv(p: Providers, empty: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(out)) if ((k.startsWith('SHADOWLAP_') && k !== 'SHADOWLAP_HOME') || k.startsWith('AWS_') || k.startsWith('AZURE_') || CREDENTIALS.includes(k) || k.endsWith('_BASE_URL') || ['CI', 'NODE_OPTIONS', 'XDG_CONFIG_HOME', 'OPENAI_API_VERSION', 'PROMPT'].includes(k)) delete out[k];
  return {
    ...out,
    ANTHROPIC_CONFIG_DIR: empty,
    AZURE_CONFIG_DIR: empty,
    AWS_SHARED_CREDENTIALS_FILE: join(empty, 'aws-credentials'),
    AWS_CONFIG_FILE: join(empty, 'aws-config'),
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_REGION: 'us-east-1',
    AWS_DEFAULT_REGION: 'us-east-1',
    AZURE_OPENAI_ENDPOINT: 'https://shadowlap-test.openai.azure.com',
    OPENAI_API_VERSION: '2024-10-21',
    SHADOWLAP_TELEMETRY: '0',
    NO_COLOR: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    SHADOWLAP_UPSTREAM_ANTHROPIC: p.urls.anthropic,
    SHADOWLAP_UPSTREAM_OPENAI: p.urls.openai,
    SHADOWLAP_UPSTREAM_GEMINI: p.urls.gemini,
    SHADOWLAP_UPSTREAM_AZURE: p.urls.azure,
    SHADOWLAP_UPSTREAM_BEDROCK: p.urls.bedrock,
    ...extra,
  };
}

/** Runs `argv` in `cwd` with `env`, and says how it ended and what it printed. */
export function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** The line an agent prints with its answer, as JSON from Node or Python. */
export const answered = (prompt: string) => new RegExp(`\\{"answer": ?"echo: ${prompt}"\\}`);

/** The run id `shadowlap run` names as it starts recording. */
export const recorded = (out: string) => /recording run (\w{26})/.exec(out)?.[1] ?? '';

/** The one line a refused live call is answered with, naming the variable to set. */
export const refusal = (set: string) => `a live call needs a real key: set ${set}, or keep the replay offline`;
