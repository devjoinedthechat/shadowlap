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
 * The trace importers through the CLI: OpenTelemetry from a file, Langfuse and LangSmith from a
 * local server standing in for their APIs. Then the point of it: replaying your own agent against a
 * trace that kept everything it sends serves every call from the trace, with nothing live.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./trace-agent.mjs', import.meta.url));
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
      env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, LANGFUSE_HOST: '', LANGSMITH_ENDPOINT: '', ...env },
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
    expect(json.runs[0]).toMatchObject({ source: join(cwd, 'otel-traces.json'), key: '4bf92f3577b34da6a3ce929d0e0e4736', calls: { model: 2, tool: 1 }, labels: ['imported', 'otel'] });
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
    const badId = await shadowlap(['import', 'langsmith', '../../etc/passwd', '--host', host], KEYS);
    expect(badId.code).toBe(1);
    expect(badId.err).toContain('not a trace id');
  });
});
