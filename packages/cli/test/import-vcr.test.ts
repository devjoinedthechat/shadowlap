import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { importNock } from '../src/import-nock.js';
import { importVcr, readVcr } from '../src/import-vcr.js';

const body = { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };
const answer = { id: 'msg_1', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 12, output_tokens: 3 } };

const interaction = (over: Record<string, unknown> = {}) => ({
  request: {
    method: 'POST',
    uri: 'https://api.anthropic.com/v1/messages',
    body: JSON.stringify(body),
    headers: { 'content-type': ['application/json'], 'anthropic-version': ['2023-06-01'], 'x-api-key': ['sk-ant-secret'] },
  },
  response: { status: { code: 200, message: 'OK' }, headers: { 'content-type': ['application/json'] }, body: { string: JSON.stringify(answer) } },
  ...over,
});

const cassette = (...interactions: unknown[]) => ({ version: 1, interactions });
const open = () => Store.open(':memory:');

describe('import vcr', () => {
  it('imports a cassette interaction with its usage and stop reason', () => {
    const store = open();
    const { run, imported, skipped } = importVcr(store, cassette(interaction()), { source: 'cassette.json' });
    expect(imported).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    const [call] = store.getCalls(run.runId);
    expect(call.name).toBe('POST /v1/messages');
    expect(call.end?.meta.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(call.end?.meta.stopReason).toBe('end_turn');
    expect(run.meta?.covers).toEqual(['api']);
    store.close();
  });

  it('joins VCR list-valued headers and drops credentials', () => {
    const store = open();
    const { run } = importVcr(store, cassette(interaction()), { source: 'cassette.json' });
    const [call] = store.getCalls(run.runId);
    expect(call.meta.fingerprintHeaders).toEqual({ 'anthropic-version': '2023-06-01' });
    expect(JSON.stringify(call.meta)).not.toContain('sk-ant-secret');
    store.close();
  });

  it('reads a base64 body, a bare status number and a plain string body', () => {
    const store = open();
    const { run, imported } = importVcr(
      store,
      cassette(
        interaction({ response: { status: 200, headers: { 'content-type': ['application/json'] }, body: { base64_string: Buffer.from(JSON.stringify(answer)).toString('base64') } } }),
        interaction({ response: { status: { code: 200 }, headers: { 'content-type': ['application/json'] }, body: JSON.stringify(answer) } }),
      ),
      { source: 'cassette.json' },
    );
    expect(imported).toHaveLength(2);
    for (const call of store.getCalls(run.runId)) {
      expect(call.end?.meta.status).toBe(200);
      expect(store.getBlob(call.end!.responseRef!)!.toString('utf8')).toBe(JSON.stringify(answer));
    }
    store.close();
  });

  it('explains what to do with a YAML cassette', () => {
    expect(() => readVcr({ http_interactions: [] })).toThrow(/json serializer/);
  });

  it('skips interactions without a uri', () => {
    const store = open();
    const { imported, skipped } = importVcr(store, cassette(interaction(), { request: { method: 'POST' } }), { source: 'cassette.json' });
    expect(imported).toHaveLength(1);
    expect(skipped.map((s) => s.reason)).toEqual(['not a VCR interaction: needs request.uri']);
    store.close();
  });

  it('fingerprints the same call identically to the nock importer', () => {
    // Three formats, one identity: a recording captured with any of them replays against the same code.
    const a = open();
    const fromVcr = importVcr(a, cassette(interaction()), { source: 'cassette.json' });
    const b = open();
    const fromNock = importNock(
      b,
      [
        {
          scope: 'https://api.anthropic.com:443',
          method: 'POST',
          path: '/v1/messages',
          body,
          reqheaders: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
          status: 200,
          response: answer,
          rawHeaders: ['content-type', 'application/json'],
        },
      ],
      { source: 'rec.json' },
    );
    expect(a.getCalls(fromVcr.run.runId)[0].fingerprint).toBe(b.getCalls(fromNock.run.runId)[0].fingerprint);
    a.close();
    b.close();
  });
});
