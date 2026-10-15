import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiRequest, Store } from '@shadowlap/engine';
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
  const body = (question: string) => ({ model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: question }] });
  writeFileSync(
    join(cwd, 'recording.json'),
    JSON.stringify([
      { scope: 'https://api.anthropic.com:443', method: 'POST', path: '/v1/messages', body: body('hi'), status: 200, response: JSON.parse(answer('hello')), rawHeaders: ['content-type', 'application/json'] },
      { scope: 'https://telemetry.example.com:443', method: 'POST', path: '/v1/collect', body: {}, status: 204, response: '' },
    ]),
  );
  writeFileSync(
    join(cwd, 'refund_cassette.json'),
    JSON.stringify({
      interactions: [
        {
          request: { method: 'POST', uri: 'https://api.anthropic.com/v1/messages', body: JSON.stringify(body('refund?')), headers: { 'content-type': ['application/json'] } },
          response: { status: { code: 200, message: 'OK' }, headers: { 'content-type': ['application/json'] }, body: { string: answer('no') } },
        },
      ],
      version: 1,
    }),
  );
  // One agent run spread over two worker files, its calls interleaved with another run's.
  const at = (runKey: string, question: string, startedAt: number) => JSON.stringify({ ...JSON.parse(capture(runKey, question)), startedAt });
  writeFileSync(join(cwd, 'worker-1.jsonl'), [at('incident-50', 'first', 1000), at('incident-51', 'other', 1500), at('incident-50', 'third', 3000)].join('\n') + '\n');
  writeFileSync(join(cwd, 'worker-2.jsonl'), [at('incident-50', 'second', 2000)].join('\n') + '\n');
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
    // The file's name, never its folder, which is this machine's and would travel with the store.
    expect(run).toMatchObject({ source: 'traffic.har', key: null, calls: { model: 2, tool: 0 }, labels: ['imported'] });
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
    // A dashboard job links each run it made.
    expect(r.events.filter((e) => e.type === 'link')).toEqual(json.runs.map((x: { runId: string }) => ({ type: 'link', label: `Open ${x.runId.slice(0, 10)}`, href: `#/run/${x.runId}` })));
  });

  it('records the name given with --name as the source: a dashboard upload is kept under another', async () => {
    writeFileSync(join(cwd, '01K5CQ4N7G0000000000000000-traffic.har'), JSON.stringify({ log: { version: '1.2', entries: [harEntry('https://api.anthropic.com/v1/messages', 'hi')] } }));
    const r = await shadowlap(['import', 'har', '01K5CQ4N7G0000000000000000-traffic.har', '--name', 'traffic.har', '--json']);
    expect(r.code).toBe(0);
    const [run] = JSON.parse(r.out).runs;
    expect(run.source).toBe('traffic.har');
    const store = Store.open(db);
    try {
      expect(store.getRun(run.runId)!.meta?.imported?.from).toBe('traffic.har');
      expect(store.listEvents({ kinds: ['capture.imported'] }).find((e) => e.runId === run.runId)).toMatchObject({ ref: 'traffic.har' });
    } finally {
      store.close();
    }
    const refused = await shadowlap(['import', 'har', 'traffic.har', '--name', '../elsewhere/traffic.har']);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/--name: a file name, without folders/);
  });

  it('puts an agent run back together from the files of several workers, in the order its calls started', async () => {
    const r = await shadowlap(['import', 'litellm', 'worker-1.jsonl', 'worker-2.jsonl', '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json.entries).toBe(4);
    expect(json.runs.map((x: { key: string; source: string; calls: { model: number } }) => [x.key, x.source, x.calls.model])).toEqual([
      ['incident-50', 'worker-1.jsonl, worker-2.jsonl', 3],
      ['incident-51', 'worker-1.jsonl', 1],
    ]);
    const store = Store.open(db);
    try {
      const questions = store.getCalls(json.runs[0].runId).map((c) => (loadApiRequest(store, c.requestRef!) as { messages: Array<{ content: string }> }).messages[0]!.content);
      expect(questions).toEqual(['first', 'second', 'third']);
    } finally {
      store.close();
    }
  });

  it('gives the same object for nock and VCR, through the CLI', async () => {
    const nock = await shadowlap(['import', 'nock', 'recording.json', '--json']);
    expect(nock.code).toBe(0);
    const n = JSON.parse(nock.out);
    expect(n).toMatchObject({ format: 'nock', entries: 2, runs: [{ source: 'recording.json', key: null, calls: { model: 1, tool: 0 }, labels: ['imported'] }], skipped: [{ reason: 'not a model API host' }] });
    expect(nock.events).toEqual([{ type: 'run', runId: n.runs[0].runId, role: 'imported' }, { type: 'result', data: n }]);
    const vcr = await shadowlap(['import', 'vcr', 'refund_cassette.json', '--json']);
    expect(vcr.code).toBe(0);
    expect(JSON.parse(vcr.out)).toMatchObject({ format: 'vcr', entries: 1, runs: [{ source: 'refund_cassette.json', calls: { model: 1, tool: 0 } }], skipped: [] });
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

  it('takes a capture with more entries skipped than a function call takes arguments', () => {
    // A long browser session: one model call among 150,000 requests to other hosts. Spreading the
    // skipped entries into push() threw "Maximum call stack size exceeded" past about 110,000.
    const store = Store.open(':memory:');
    const other = harEntry('https://telemetry.example.com/v1/collect', 'x');
    const entries = [harEntry('https://api.anthropic.com/v1/messages', 'hi'), ...Array.from({ length: 150_000 }, () => other)];
    const result = importHar(store, { log: { entries } }, { source: 'session.har' });
    const json = settleImport(store, { format: 'har', entries: entries.length, runs: [{ key: null, result }], env: {} });
    expect(json.runs).toHaveLength(1);
    expect(json.skipped).toHaveLength(150_000);
    store.close();
  });
});
