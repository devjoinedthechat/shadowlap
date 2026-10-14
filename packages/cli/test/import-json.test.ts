import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { settleImport, sourceName } from '../src/import-report.js';
import { importHar } from '../src/import-har.js';

/**
 * `shadowlap import … --json` is what a dashboard job runs, so its output has to name every run
 * made by its full id, with where it came from and what it holds, whatever the format. The job also
 * hears about each run over its events descriptor, and the activity feed gets a line per run.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

let cwd: string;
let db: string;

interface Outcome {
  code: number | null;
  out: string;
  err: string;
  events: Array<Record<string, unknown>>;
}

function shadowlap(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', SHADOWLAP_EVENTS_FD: '3', SHADOWLAP_AUTHOR: 'maya@example.com', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let events = '';
    child.stdout!.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr!.on('data', (c: Buffer) => (err += c.toString()));
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (c: Buffer) => (events += c.toString()));
    child.on('close', (code) => resolve({ code, out, err, events: events.trim() ? events.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : [] }));
  });
}

const answer = (text: string) => JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 12, output_tokens: 3 } });
const harEntry = (url: string, question: string) => ({
  startedDateTime: '2026-09-18T10:00:00.000Z',
  time: 420,
  request: {
    method: 'POST',
    url,
    headers: [{ name: 'content-type', value: 'application/json' }, { name: 'x-api-key', value: 'sk-ant-secret' }],
    postData: { mimeType: 'application/json', text: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: question }] }) },
  },
  response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], content: { mimeType: 'application/json', text: answer('hello') } },
});
const capture = (runKey: string | undefined, question: string) =>
  JSON.stringify({
    format: 'shadowlap-capture',
    v: 1,
    url: 'http://litellm.internal/v1/messages',
    method: 'POST',
    requestHeaders: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    requestBody: { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: question }] },
    status: 200,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: answer('ok'),
    startedAt: 1_789_745_374_433,
    timeMs: 180,
    ...(runKey ? { runKey } : {}),
  });

beforeAll(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-import-json-')));
  db = join(cwd, 'store.db');
  writeFileSync(join(cwd, 'traffic.har'), JSON.stringify({ log: { version: '1.2', entries: [harEntry('https://api.anthropic.com/v1/messages', 'hi'), harEntry('https://telemetry.example.com/v1/collect', 'x'), harEntry('https://api.anthropic.com/v1/messages', 'again')] } }));
  writeFileSync(join(cwd, 'gateway.jsonl'), [capture('incident-42', 'one'), capture('incident-43', 'two'), capture('incident-42', 'three'), '{"half a line'].join('\n') + '\n');
  writeFileSync(join(cwd, 'empty.har'), JSON.stringify({ log: { version: '1.2', entries: [harEntry('https://telemetry.example.com/v1/collect', 'x')] } }));
});
afterAll(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('import --json', () => {
  it('names the run by its full id, with its source, its call counts and every entry skipped', async () => {
    const r = await shadowlap(['import', 'har', 'traffic.har', '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json).toMatchObject({ format: 'har', entries: 3, skipped: [{ url: 'https://telemetry.example.com/v1/collect', reason: 'not a model API host' }] });
    expect(json.runs).toHaveLength(1);
    const [run] = json.runs;
    expect(run.runId).toMatch(/^[0-9A-Z]{26}$/);
    expect(run).toMatchObject({ source: join(cwd, 'traffic.har'), key: null, calls: { model: 2, tool: 0 }, labels: ['imported'] });
    expect(run.imported.map((c: { callNo: number; kind: string }) => [c.callNo, c.kind])).toEqual([
      [1, 'api'],
      [2, 'api'],
    ]);

    // A dashboard job hears about the run, then gets the same object as its result.
    expect(r.events).toEqual([{ type: 'run', runId: run.runId, role: 'imported' }, { type: 'result', data: json }]);

    // The run is labelled and has an author; the activity feed has a line for it.
    const store = Store.open(db);
    try {
      const stored = store.getRun(run.runId)!;
      expect(stored.meta?.labels).toEqual(['imported']);
      expect(stored.meta?.author).toBe('maya@example.com');
      const [event] = store.listEvents({ kinds: ['capture.imported'] }).filter((e) => e.runId === run.runId);
      expect(event).toMatchObject({ kind: 'capture.imported', actor: 'maya@example.com', ref: 'traffic.har', data: { format: 'har', key: null, modelCalls: 2, toolCalls: 0 } });
    } finally {
      store.close();
    }
  });

  it('lists every run one LiteLLM file makes, one per correlation id', async () => {
    const r = await shadowlap(['import', 'litellm', 'gateway.jsonl', '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json.format).toBe('litellm');
    expect(json.entries).toBe(4);
    expect(json.runs.map((x: { key: string; calls: { model: number } }) => [x.key, x.calls.model])).toEqual([
      ['incident-42', 2],
      ['incident-43', 1],
    ]);
    expect(new Set(json.runs.map((x: { runId: string }) => x.runId)).size).toBe(2);
    expect(json.skipped).toEqual([{ url: 'line 4', reason: 'not JSON (a partly written line?)' }]);
    expect(r.events.filter((e) => e.type === 'run')).toEqual(json.runs.map((x: { runId: string }) => ({ type: 'run', runId: x.runId, role: 'imported' })));
  });

  it('prints an empty list and fails when nothing could be imported, keeping no empty run', async () => {
    const before = Store.open(db);
    const count = before.allRuns().length;
    before.close();
    const r = await shadowlap(['import', 'har', 'empty.har', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ format: 'har', entries: 1, runs: [], skipped: [{ reason: 'not a model API host' }] });
    const after = Store.open(db);
    expect(after.allRuns()).toHaveLength(count);
    after.close();
  });

  it('keeps the human output as it was without --json', async () => {
    const r = await shadowlap(['import', 'har', 'traffic.har']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Imported \S+: 2 model calls \(2 anthropic\)\./);
    expect(r.out).toContain('1 entry skipped (--json lists them).');
    expect(r.out).toContain('shadowlap replay');
  });
});

describe('settleImport', () => {
  it('names a source by its file, or by its trace store and id', () => {
    expect(sourceName('/home/me/captures/traffic.har')).toBe('traffic.har');
    expect(sourceName('langfuse:7f3a9c2e')).toBe('langfuse:7f3a9c2e');
    expect(sourceName('langsmith:0192f4c1')).toBe('langsmith:0192f4c1');
  });

  it('outside a dashboard job only settles and describes', () => {
    const store = Store.open(':memory:');
    const result = importHar(store, { log: { entries: [harEntry('https://api.anthropic.com/v1/messages', 'hi')] } }, { source: 'x.har' });
    const json = settleImport(store, { format: 'har', entries: 1, runs: [{ key: null, result }], env: {} });
    expect(json.runs[0]).toMatchObject({ runId: result.run.runId, source: 'x.har', calls: { model: 1, tool: 0 } });
    expect(store.listEvents()).toHaveLength(1);
    store.close();
  });
});
