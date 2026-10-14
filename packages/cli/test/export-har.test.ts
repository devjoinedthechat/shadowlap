import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
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
