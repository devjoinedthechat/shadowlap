import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store, storeApiRequest } from '@shadowlap/engine';

/**
 * Where `export otel` sends a trace: a file asked for with `--out` stays on the machine, even where
 * OTEL_EXPORTER_OTLP_ENDPOINT names a collector (a dashboard job inherits the dashboard's
 * environment, and its trace dialog offers "a file"); the collector gets it with `--endpoint`, or
 * from the environment when no file is asked for.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

let cwd: string;
let runId: string;
let server: Server;
let collector: string;
const received: string[] = [];

beforeAll(async () => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-otel-out-')));
  const store = Store.open(join(cwd, '.shadowlap', 'shadowlap.db'));
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd } });
  runId = run.runId;
  const api = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'a'.repeat(64), occurrence: 1 };
  const answer = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Hello.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  store.appendCallStart({ runId, callNo: 1, ...api, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'Say hello.' }] }), meta: { provider: 'anthropic' }, at: 1 });
  store.appendCallEnd(api, { runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from(JSON.stringify(answer))), outcome: 'ok', meta: { provider: 'anthropic', status: 200, model: 'claude-test' }, at: 2 });
  store.endRun(runId, 'completed', 3);
  store.close();
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  collector = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
beforeEach(() => {
  received.length = 0;
});

function otel(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'export', 'otel', runId, ...args], { cwd, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', OTEL_EXPORTER_OTLP_ENDPOINT: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('export otel: where the trace goes', () => {
  it('writes a file asked for with --out and sends it nowhere, whatever the environment names', async () => {
    const r = await otel(['--out', 'trace.json'], { OTEL_EXPORTER_OTLP_ENDPOINT: collector });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, 'trace.json'), 'utf8'))).toHaveProperty('resourceSpans');
    expect(r.err).toContain('wrote 2 spans');
    expect(r.err).not.toContain('sent');
    expect(received).toEqual([]);
  });

  it('sends to the environment’s collector when no file is asked for, and to --endpoint alongside a file', async () => {
    const env = await otel([], { OTEL_EXPORTER_OTLP_ENDPOINT: collector });
    expect(env.code, env.err).toBe(0);
    expect(env.out).toBe('');
    expect(received).toEqual(['POST /v1/traces']);
    received.length = 0;
    const both = await otel(['--out', 'both.json', '--endpoint', collector]);
    expect(both.code, both.err).toBe(0);
    expect(existsSync(join(cwd, 'both.json'))).toBe(true);
    expect(received).toEqual(['POST /v1/traces']);
  });
});
