import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * The trace importers through the CLI: OpenTelemetry from a file, Langfuse, LangSmith, Phoenix and
 * Logfire from a local server standing in for their APIs. Then the point of it: replaying your own agent against a
 * trace that kept everything it sends serves every call from the trace, with nothing live.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./trace-agent.mjs', import.meta.url));
const OPENAI_AGENT = fileURLToPath(new URL('./trace-agent-openai.mjs', import.meta.url));
const fixture = (name: string) => readFileSync(new URL(`./fixtures/traces/${name}`, import.meta.url), 'utf8');

let cwd: string;
let db: string;
let api: Server;
let host: string;
let mock: MockServer;

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, LANGFUSE_HOST: '', LANGSMITH_ENDPOINT: '', ...NO_STORE_ENV, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

const LANGFUSE_ID = '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07';
const LANGSMITH_ID = '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b3c';
const KEYS = { LANGFUSE_PUBLIC_KEY: 'pk-lf-0e5c-public', LANGFUSE_SECRET_KEY: 'sk-lf-9d1f-do-not-store', LANGSMITH_API_KEY: 'lsv2_pt_7a1c_do_not_store' };
const PHOENIX_ID = '4a2db41deabc4aec332fb9fbfa0fc3e2';
const LOGFIRE_ID = '01a16460e2f311342463057f62b79fa9';
const PHOENIX_KEY = 'phx_6b1d_do_not_store';
const LOGFIRE_TOKEN = 'pylf_v1_us_donotstore7a1c';
/** Where Phoenix and Logfire would be found otherwise, cleared so a developer's own setup can't reach the tests. */
const NO_STORE_ENV = { PHOENIX_ENDPOINT: '', PHOENIX_COLLECTOR_ENDPOINT: '', PHOENIX_BASE_URL: '', PHOENIX_API_KEY: '', PHOENIX_PROJECT_NAME: '', LOGFIRE_BASE_URL: '', LOGFIRE_READ_TOKEN: '' };

beforeAll(async () => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-import-trace-')));
  db = join(cwd, 'store.db');
  writeFileSync(join(cwd, 'otel-traces.json'), fixture('otel-genai.json'));
  // The same trace with the tool definitions left out, as most instrumentations do by default.
  const stripped = JSON.parse(fixture('otel-genai.json')) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string }> }> }> }> };
  for (const s of stripped.resourceSpans[0]!.scopeSpans[0]!.spans) s.attributes = s.attributes.filter((a) => a.key !== 'gen_ai.tool.definitions');
  writeFileSync(join(cwd, 'otel-no-tools.json'), JSON.stringify(stripped));

  const langfuse = JSON.parse(fixture('langfuse-trace.json')) as unknown;
  const langsmith = (JSON.parse(fixture('langsmith-runs.json')) as { pages: unknown[] }).pages;
  const phoenix = JSON.parse(fixture('phoenix-spans.json')) as { data: unknown[] };
  const logfire = JSON.parse(fixture('logfire-records.json')) as { data: Array<{ trace_id: string }> };
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const basic = `Basic ${Buffer.from(`${KEYS.LANGFUSE_PUBLIC_KEY}:${KEYS.LANGFUSE_SECRET_KEY}`).toString('base64')}`;
      if (req.url === `/api/public/traces/${LANGFUSE_ID}`) return req.headers.authorization === basic ? send(200, langfuse) : send(401, { message: 'Invalid credentials' });
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/v1/projects/support-agent/spans') {
        if (req.headers.authorization !== `Bearer ${PHOENIX_KEY}`) return send(401, 'Unauthorized');
        return send(200, { data: url.searchParams.get('trace_id') === PHOENIX_ID ? phoenix.data : [], next_cursor: null });
      }
      if (url.pathname.startsWith('/v1/projects/')) return send(404, 'Not Found');
      if (req.url === '/v2/query' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${LOGFIRE_TOKEN}`) return send(401, { detail: 'Invalid read token' });
        const id = /trace_id = '([0-9a-f]{32})'/.exec((JSON.parse(body) as { sql: string }).sql)?.[1];
        return send(200, { schema: { fields: [] }, data: logfire.data.filter((r) => r.trace_id === id) });
      }
      if (req.url === '/runs/query' && req.method === 'POST') {
        if (req.headers['x-api-key'] !== KEYS.LANGSMITH_API_KEY) return send(401, { detail: 'Invalid token' });
        const q = JSON.parse(body) as { trace: string; cursor?: string };
        if (q.trace !== LANGSMITH_ID) return send(200, { runs: [], cursors: { next: null } });
        return send(200, q.cursor ? langsmith[1] : langsmith[0]);
      }
      send(404, { message: 'not found' });
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  // Any call that reaches the model provider shows up here; a replay served by the trace makes none.
  mock = await startMockAnthropic({ script: () => ({ message: message([text('answered live')]) }) });
});
afterAll(async () => {
  await mock.close();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('shadowlap import otel', () => {
  it('prints the run with its trace id, labels and what the trace kept', async () => {
    const r = await shadowlap(['import', 'otel', 'otel-traces.json', '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json).toMatchObject({ format: 'otel', entries: 5, skipped: [] });
    expect(json.kept).toEqual({ traces: 1, spans: 5, modelCalls: 2, modelCallsImported: 2, withSettings: 2, withToolDefinitions: 2, toolCalls: 1, toolCallsKept: 1 });
    expect(json.runs).toHaveLength(1);
    expect(json.runs[0]).toMatchObject({ source: 'otel-traces.json', key: '4bf92f3577b34da6a3ce929d0e0e4736', calls: { model: 2, tool: 1 }, labels: ['imported', 'otel'] });
  });

  it('reads traces and the log records with their messages from separate files', async () => {
    const [traces, logs] = fixture('otel-logs.jsonl').trim().split('\n');
    writeFileSync(join(cwd, 'traces.json'), traces!);
    writeFileSync(join(cwd, 'logs.json'), logs!);
    const alone = await shadowlap(['import', 'otel', 'traces.json', '--json']);
    expect(JSON.parse(alone.out).runs).toEqual([]);
    const r = await shadowlap(['import', 'otel', 'traces.json', 'logs.json', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).runs[0]).toMatchObject({ source: 'traces.json, logs.json', calls: { model: 2, tool: 0 } });
    expect((await shadowlap(['import', 'otel', 'traces.json', 'missing.json'])).err).toContain('missing.json: ');
  });

  it('replays an OpenAI agent traced with OpenInference exactly, from the requests its instrumentation logged', async () => {
    writeFileSync(join(cwd, 'phoenix.json'), fixture('otel-openinference.json'));
    const imported = JSON.parse((await shadowlap(['import', 'otel', 'phoenix.json', '--json'])).out);
    expect(imported.runs[0]).toMatchObject({ calls: { model: 2, tool: 1 } });
    const r = await shadowlap(['replay', imported.runs[0].runId, '--', process.execPath, OPENAI_AGENT], { SHADOWLAP_UPSTREAM_OPENAI: 'offline' });
    expect(r.err + r.out).toContain('Replay clean: 3/3 calls replayed (2 api, 1 tool), 0 upstream requests');
    // The tool's output came from the trace, not from running it.
    expect(r.out).toContain('answer: Order B-7 ($40) is delivered and within policy: refunded.');
  });

  it('says in words what it imported and what the trace kept', async () => {
    const r = await shadowlap(['import', 'otel', 'otel-traces.json']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Imported \S+ from otel-traces\.json: 2 model calls and 1 tool result \(2 anthropic\)\./);
    expect(r.out).toContain('Read 5 spans. It kept the messages of 2 of 2 model calls, settings for 2, tool definitions for 2, and the output of 1 of 1 tool call.');
    expect(r.out).toContain('A trace says what was sent, not what sent it.');
  });

  it('shows which tools the trace covers, and that the others run live', async () => {
    const imported = JSON.parse((await shadowlap(['import', 'otel', 'otel-traces.json', '--json'])).out);
    const shown = await shadowlap(['show', imported.runs[0].runId]);
    expect(shown.out).toContain('partial recording: api, tool:lookup_order only\u2009\u2014\u2009other tool, clock, random calls run live on replay');
    expect(shown.out).toContain('imported, otel');
  });

  it("says why a trace from Shadowlap's own export has nothing to replay", async () => {
    const imported = JSON.parse((await shadowlap(['import', 'otel', 'otel-traces.json', '--json'])).out);
    expect((await shadowlap(['export', 'otel', imported.runs[0].runId, '--out', 'exported.json'])).code).toBe(0);
    const again = await shadowlap(['import', 'otel', 'exported.json']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('which carries no prompt text: share the run as a pack instead');
  });

  it('replays your agent against a trace that kept everything it sends, with nothing live', async () => {
    const imported = JSON.parse((await shadowlap(['import', 'otel', 'otel-traces.json', '--json'])).out);
    const runId = imported.runs[0].runId as string;
    const before = mock.requests.length;
    const r = await shadowlap(['replay', runId, '--', process.execPath, AGENT]);
    expect(r.err + r.out).toContain('Replay clean: 3/3 calls replayed (2 api, 1 tool), 0 upstream requests');
    // The answer and the order came from the trace: the tool did not run, and no model was asked.
    expect(r.out).toContain('answer: Order A-1042 was delivered; it cost $240.');
    expect(mock.requests.length).toBe(before);
  });

  it('replays an agent on an SDK that names another API version just as clean: a trace keeps no version', async () => {
    const imported = JSON.parse((await shadowlap(['import', 'otel', 'otel-traces.json', '--json'])).out);
    const before = mock.requests.length;
    const r = await shadowlap(['replay', imported.runs[0].runId, '--', process.execPath, AGENT], { API_VERSION: '2026-10-21' });
    expect(r.err + r.out).toContain('Replay clean: 3/3 calls replayed (2 api, 1 tool), 0 upstream requests');
    expect(r.out).toContain('answer: Order A-1042 was delivered; it cost $240.');
    expect(mock.requests.length).toBe(before);
  });

  it('forks at the first model call when the trace left out what the agent sends, and runs live from there', async () => {
    const imported = JSON.parse((await shadowlap(['import', 'otel', 'otel-no-tools.json', '--json'])).out);
    expect(imported.kept.withToolDefinitions).toBe(0);
    const human = await shadowlap(['import', 'otel', 'otel-no-tools.json']);
    expect(human.out).toContain('Where the trace kept no tool definitions, a replay of an agent that sends tools forks at its first model call');
    const before = mock.requests.length;
    const r = await shadowlap(['replay', imported.runs[0].runId, '--', process.execPath, AGENT]);
    expect(r.err + r.out).toMatch(/Diverged at call 1 \(api POST \/v1\/messages\)/);
    expect(r.err + r.out).toContain('+ $.tools');
    expect(r.out).toContain('answer: answered live');
    expect(mock.requests.length).toBe(before + 1);
  });
});

describe('shadowlap import langfuse and langsmith', () => {
  it('imports a Langfuse trace with the keys on this machine, and never stores them', async () => {
    const r = await shadowlap(['import', 'langfuse', LANGFUSE_ID, '--host', host, '--json'], KEYS);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json).toMatchObject({ format: 'langfuse', entries: 7 });
    expect(json.kept).toMatchObject({ modelCalls: 3, modelCallsImported: 3, toolCalls: 2, toolCallsKept: 1 });
    expect(json.runs[0]).toMatchObject({ source: 'langfuse:7f3a9c2e', key: LANGFUSE_ID, calls: { model: 3, tool: 1 }, labels: ['imported', 'langfuse'] });
    const store = Store.open(db);
    try {
      const run = store.getRun(json.runs[0].runId)!;
      expect(run.meta?.covers).toEqual(['api', 'tool:lookup_order']);
      expect(store.listEvents({ kinds: ['capture.imported'] }).find((e) => e.runId === run.runId)).toMatchObject({ ref: 'langfuse:7f3a9c2e', data: { format: 'langfuse', modelCalls: 3, toolCalls: 1 } });
    } finally {
      store.close();
    }
    const bytes = readFileSync(db);
    for (const secret of Object.values(KEYS)) expect(bytes.includes(Buffer.from(secret))).toBe(false);
  });

  it('imports a LangSmith trace across pages and says where the key went', async () => {
    const r = await shadowlap(['import', 'langsmith', LANGSMITH_ID, '--host', host], KEYS);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Imported \S+ from langsmith:0192f4c1: 2 model calls and 1 tool result \(2 anthropic\)\./);
    expect(r.out).toContain('Read 5 runs. It kept the messages of 2 of 2 model calls, settings for 2, tool definitions for 2, and the output of 1 of 2 tool calls (the others run live on replay, with writes fenced).');
    expect(r.out).toContain(`The keys were read from the environment and sent to ${new URL(host).host} only; nothing of them is stored.`);
  });

  it('refuses without the keys, with keys the store rejects, and with a host the keys may not travel to in the clear', async () => {
    const noKeys = await shadowlap(['import', 'langfuse', LANGFUSE_ID, '--host', host], { LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '' });
    expect(noKeys.code).toBe(1);
    expect(noKeys.err).toContain('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
    const wrong = await shadowlap(['import', 'langsmith', LANGSMITH_ID, '--host', host], { ...KEYS, LANGSMITH_API_KEY: 'lsv2_wrong' });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('LangSmith refused the key (401)');
    const cleartext = await shadowlap(['import', 'langfuse', LANGFUSE_ID, '--host', 'http://langfuse.internal:3000'], KEYS);
    expect(cleartext.code).toBe(1);
    expect(cleartext.err).toContain('use https for langfuse.internal:3000');
    // --allow-http lets the keys go over plain http to a host on a network the person trusts.
    const allowed = await shadowlap(['import', 'langfuse', LANGFUSE_ID, '--host', 'http://0.0.0.0:1', '--allow-http'], KEYS);
    expect(allowed.err).toContain('could not reach 0.0.0.0:1');
    // A trace id is checked before it goes into a URL, and refused in one line like every other import error.
    const badId = await shadowlap(['import', 'langsmith', '../../etc/passwd', '--host', host], KEYS);
    expect(badId.code).toBe(1);
    expect(badId.err).toBe('shadowlap: not a trace id: "../../etc/passwd"\n');
  });
});

describe('shadowlap import phoenix and logfire', () => {
  it('imports a Phoenix trace from where its own client finds it, and never stores the key', async () => {
    const r = await shadowlap(['import', 'phoenix', PHOENIX_ID, '--json'], { PHOENIX_COLLECTOR_ENDPOINT: `${host}/v1/traces`, PHOENIX_PROJECT_NAME: 'support-agent', PHOENIX_API_KEY: PHOENIX_KEY });
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json).toMatchObject({ format: 'phoenix', entries: 6 });
    expect(json.kept).toMatchObject({ modelCalls: 3, modelCallsImported: 3, withToolDefinitions: 3, toolCalls: 2, toolCallsKept: 2 });
    expect(json.runs[0]).toMatchObject({ source: 'phoenix:4a2db41d', key: PHOENIX_ID, calls: { model: 3, tool: 2 }, labels: ['imported', 'phoenix'] });
    expect(readFileSync(db).includes(Buffer.from(PHOENIX_KEY))).toBe(false);
  });

  it('imports a Logfire trace with the read token, says where it went, and never stores it', async () => {
    const r = await shadowlap(['import', 'logfire', LOGFIRE_ID.toUpperCase(), '--host', host], { LOGFIRE_READ_TOKEN: LOGFIRE_TOKEN });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Imported \S+ from logfire:01a16460: 3 model calls and 2 tool results \(3 anthropic\)\./);
    expect(r.out).toContain('Read 6 spans. It kept the messages of 3 of 3 model calls, settings for 3, tool definitions for 3, and the output of 2 of 2 tool calls.');
    expect(r.out).toContain(`LOGFIRE_READ_TOKEN was read from the environment and sent to ${new URL(host).host} only; nothing of it is stored.`);
    expect(readFileSync(db).includes(Buffer.from(LOGFIRE_TOKEN))).toBe(false);
  });

  it('refuses without a read token, with one Logfire rejects, a project Phoenix lacks, an id that is no trace id, or --since in the future', async () => {
    const noToken = await shadowlap(['import', 'logfire', LOGFIRE_ID, '--host', host]);
    expect(noToken.code).toBe(1);
    expect(noToken.err).toContain('LOGFIRE_READ_TOKEN');
    const wrong = await shadowlap(['import', 'logfire', LOGFIRE_ID, '--host', host], { LOGFIRE_READ_TOKEN: 'pylf_v1_us_wrong' });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('Logfire refused the read token (401)');
    const noProject = await shadowlap(['import', 'phoenix', PHOENIX_ID, '--host', host, '--project', 'refunds'], { PHOENIX_API_KEY: PHOENIX_KEY });
    expect(noProject.code).toBe(1);
    expect(noProject.err).toContain('has no project refunds');
    // Each in one line, as every other import error is, without the command's help.
    const badId = await shadowlap(['import', 'phoenix', 'not-a-trace', '--host', host]);
    expect(badId.code).toBe(1);
    expect(badId.err).toBe('shadowlap: not a trace id: "not-a-trace" (it is 32 hex characters, as the trace\'s page shows it)\n');
    const future = await shadowlap(['import', 'logfire', LOGFIRE_ID, '--host', host, '--since', '2999-01-01'], { LOGFIRE_READ_TOKEN: LOGFIRE_TOKEN });
    expect(future.code).toBe(1);
    expect(future.err).toBe('shadowlap: --since: "2999-01-01" is not a moment in the past\n');
    const notWhen = await shadowlap(['import', 'logfire', LOGFIRE_ID, '--host', host, '--since', 'yesterday'], { LOGFIRE_READ_TOKEN: LOGFIRE_TOKEN });
    expect(notWhen.err).toBe('shadowlap: --since: a date (2026-09-30), a time (2026-09-30T14:00Z), or how long ago (30d, 12h), not "yesterday"\n');
  });

  it('names the variable that gave an address it refuses, never --host when none was given', async () => {
    const withPassword = await shadowlap(['import', 'phoenix', PHOENIX_ID], { PHOENIX_COLLECTOR_ENDPOINT: 'https://ops:hunter2@phoenix.northwind.example/v1/traces' });
    expect(withPassword.code).toBe(1);
    expect(withPassword.err).toBe('shadowlap: PHOENIX_COLLECTOR_ENDPOINT: leave credentials out of the URL; the keys come from the environment\n');
    const cleartext = await shadowlap(['import', 'logfire', LOGFIRE_ID], { LOGFIRE_READ_TOKEN: LOGFIRE_TOKEN, LOGFIRE_BASE_URL: 'http://logfire.northwind.example' });
    expect(cleartext.code).toBe(1);
    expect(cleartext.err).toMatch(/^shadowlap: LOGFIRE_BASE_URL: use https for logfire\.northwind\.example: /);
    // Given with --host, the refusal says so.
    const flag = await shadowlap(['import', 'logfire', LOGFIRE_ID, '--host', 'http://logfire.northwind.example'], { LOGFIRE_READ_TOKEN: LOGFIRE_TOKEN, LOGFIRE_BASE_URL: 'https://logfire-eu.pydantic.dev' });
    expect(flag.err).toMatch(/^shadowlap: --host: use https for logfire\.northwind\.example: /);
  });
});
