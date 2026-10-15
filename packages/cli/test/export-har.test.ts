import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Store, type Normalizer } from '@shadowlap/engine';
import { runToHar } from '../src/export-har.js';
import { importHar } from '../src/import-har.js';

const body = (n: number) => ({ model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: `q${n}` }] });
const response = (n: number) =>
  JSON.stringify({ id: `msg_${n}`, model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: `a${n}` }], usage: { input_tokens: 10 + n, output_tokens: 2 } });

const entry = (n: number) => ({
  startedDateTime: new Date(1_800_000_000_000 + n * 1000).toISOString(),
  time: 100 + n,
  request: {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: [
      { name: 'content-type', value: 'application/json' },
      { name: 'anthropic-version', value: '2023-06-01' },
      { name: 'x-api-key', value: 'sk-ant-secret' },
    ],
    postData: { mimeType: 'application/json', text: JSON.stringify(body(n)) },
  },
  response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], content: { mimeType: 'application/json', text: response(n) } },
});

const har = (...entries: unknown[]) => ({ log: { version: '1.2', entries } });

describe('export har', () => {
  it('writes a valid HAR log with one entry per model call', () => {
    const store = Store.open(':memory:');
    const { run } = importHar(store, har(entry(1), entry(2)), { source: 'in.har' });
    const { har: out, entries, skipped } = runToHar(store, run, store.getCalls(run.runId));

    expect(entries).toBe(2);
    expect(skipped).toHaveLength(0);
    const log = (out as { log: { version: string; creator: { name: string }; entries: Array<Record<string, any>> } }).log;
    expect(log.version).toBe('1.2');
    expect(log.creator.name).toBe('shadowlap');
    expect(log.entries).toHaveLength(2);
    const [first] = log.entries;
    expect(first.request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(first.request.method).toBe('POST');
    expect(first.response.content.encoding).toBe('base64');
    expect(first.timings).toBeDefined();
    store.close();
  });

  it('never writes a credential, even though the capture had one', () => {
    const store = Store.open(':memory:');
    const { run } = importHar(store, har(entry(1)), { source: 'in.har' });
    const { har: out } = runToHar(store, run, store.getCalls(run.runId));
    expect(JSON.stringify(out)).not.toContain('sk-ant-secret');
    store.close();
  });

  it('round-trips: importing what it exported gives the same fingerprints', () => {
    const a = Store.open(':memory:');
    const first = importHar(a, har(entry(1), entry(2), entry(1)), { source: 'in.har' });
    const before = a.getCalls(first.run.runId);
    const { har: exported } = runToHar(a, first.run, before);

    const b = Store.open(':memory:');
    const second = importHar(b, exported, { source: 'roundtrip.har' });
    const after = b.getCalls(second.run.runId);

    expect(after).toHaveLength(before.length);
    // The fixed point that matters: a re-imported recording still matches the same requests.
    expect(after.map((c) => c.fingerprint)).toEqual(before.map((c) => c.fingerprint));
    expect(after.map((c) => c.occurrence)).toEqual(before.map((c) => c.occurrence));
    expect(after.map((c) => c.name)).toEqual(before.map((c) => c.name));
    expect(after.map((c) => c.end?.meta.usage)).toEqual(before.map((c) => c.end?.meta.usage));
    a.close();
    b.close();
  });

  it('leaves out calls that never completed, and says so', () => {
    const store = Store.open(':memory:');
    const { run } = importHar(store, har(entry(1)), { source: 'in.har' });
    const calls = store.getCalls(run.runId);
    const pending = [{ ...calls[0], end: null }];
    const { entries, skipped } = runToHar(store, run, pending);
    expect(entries).toBe(0);
    expect(skipped).toEqual([{ callNo: 1, reason: 'the call never completed' }]);
    store.close();
  });
});

// ---- redaction ----

const SECRET = 'sk-live-9f8e7d6c5b4a';
const secretEntry = () => ({
  startedDateTime: new Date(1_800_000_000_000).toISOString(),
  time: 120,
  request: {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: [
      { name: 'content-type', value: 'application/json' },
      { name: 'anthropic-version', value: '2023-06-01' },
      { name: 'anthropic-beta', value: `tenant-${SECRET}` },
    ],
    postData: {
      mimeType: 'application/json',
      text: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 64, metadata: { user_id: 'maya@example.com' }, messages: [{ role: 'user', content: `Rotate the key ${SECRET} for maya@example.com.` }] }),
    },
  },
  response: {
    status: 200,
    headers: [
      { name: 'content-type', value: 'text/event-stream' },
      { name: 'request-id', value: `req-${SECRET}` },
    ],
    content: {
      mimeType: 'text/event-stream',
      text: `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-haiku-4-5","usage":{"input_tokens":10,"output_tokens":1}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Rotated ${SECRET}."}}\n\n`,
    },
  },
});
const RULES: Normalizer[] = [
  { pattern: '/sk-live-[a-z0-9]+/', replace: '<KEY>' },
  { kind: 'api', path: '$.metadata.user_id', replace: '<USER>' },
  { pattern: 'email', replace: '<EMAIL>' },
];
/** Everything the HAR says, the base64 response bodies decoded. */
const everything = (har: unknown) => {
  const log = (har as { log: { entries: Array<{ response: { content: { text: string } } }> } }).log;
  return JSON.stringify(har) + log.entries.map((e) => Buffer.from(e.response.content.text, 'base64').toString('utf8')).join('\n');
};

describe('export har: redaction', () => {
  it('applies every rule: path rules to the request, the others to the URL, headers and the streamed response', () => {
    const store = Store.open(':memory:');
    const { run } = importHar(store, har(secretEntry()), { source: 'in.har' });
    const plain = everything(runToHar(store, run, store.getCalls(run.runId)).har);
    expect(plain).toContain(SECRET); // what the rules are for

    const { har: out } = runToHar(store, run, store.getCalls(run.runId), { redact: RULES });
    const text = everything(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('maya@example.com');
    const [entry] = (out as { log: { entries: Array<Record<string, any>> } }).log.entries;
    expect(JSON.parse(entry.request.postData.text)).toMatchObject({ metadata: { user_id: '<USER>' }, messages: [{ content: 'Rotate the key <KEY> for <EMAIL>.' }] });
    expect(entry.request.headers).toContainEqual({ name: 'anthropic-beta', value: 'tenant-<KEY>' });
    expect(entry.response.headers).toContainEqual({ name: 'request-id', value: 'req-<KEY>' });
    expect(Buffer.from(entry.response.content.text, 'base64').toString('utf8')).toContain('Rotated <KEY>.');
    // The rules travel with the file, so a recording imported from it can match under them.
    expect((out as { log: { _shadowlap?: unknown } }).log._shadowlap).toEqual({ redactions: RULES });
    store.close();
  });

  it('masks the secret in the file the CLI writes, with the project\'s rules, unless --no-redact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-har-redact-'));
    try {
      const db = join(dir, 'store.db');
      const store = Store.open(db);
      const { run } = importHar(store, har(secretEntry()), { source: 'in.har' });
      store.close();
      writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ redact: RULES }));
      const cli = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
      const exec = (args: string[]) => promisify(execFile)(process.execPath, [cli, '--db', db, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0' }, encoding: 'utf8' });

      const { stdout } = await exec(['export', 'har', run.runId, 'out.har']);
      expect(stdout).toContain('3 redaction rules applied');
      const written = readFileSync(join(dir, 'out.har'), 'utf8');
      expect(everything(JSON.parse(written))).not.toContain(SECRET);

      await exec(['export', 'har', run.runId, 'raw.har', '--no-redact']);
      expect(everything(JSON.parse(readFileSync(join(dir, 'raw.har'), 'utf8')))).toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
