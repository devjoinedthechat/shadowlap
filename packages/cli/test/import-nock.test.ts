import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { importHar } from '../src/import-har.js';
import { importNock, readNock } from '../src/import-nock.js';

const body = { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };
const answer = { id: 'msg_1', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 12, output_tokens: 3 } };

const def = (over: Record<string, unknown> = {}) => ({
  scope: 'https://api.anthropic.com:443',
  method: 'POST',
  path: '/v1/messages',
  body,
  reqheaders: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant-secret' },
  status: 200,
  response: answer,
  rawHeaders: ['content-type', 'application/json', 'request-id', 'req_1'],
  ...over,
});

const open = () => Store.open(':memory:');

describe('import nock', () => {
  it('imports a model call with its usage, model and stop reason', () => {
    const store = open();
    const { run, imported, skipped } = importNock(store, [def()], { source: 'rec.json' });
    expect(imported).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    expect(imported[0]).toMatchObject({ name: 'POST /v1/messages', provider: 'anthropic', model: 'claude-haiku-4-5' });

    const [call] = store.getCalls(run.runId);
    expect(call.end?.meta.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(call.end?.meta.stopReason).toBe('end_turn');
    expect(call.end?.meta.headers?.['request-id']).toBe('req_1'); // rawHeaders is a flat pair list
    expect(run.meta?.covers).toEqual(['api']);
    store.close();
  });

  it('accepts both an array and { nockDefs }', () => {
    expect(readNock([def()]).calls).toHaveLength(1);
    expect(readNock({ nockDefs: [def()] }).calls).toHaveLength(1);
    expect(() => readNock({ something: 'else' })).toThrow(/not a nock recording/);
  });

  it('rejoins the chunks of a streamed response', () => {
    const store = open();
    const chunks = ['event: message_start\ndata: {"type":"message_start"}\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n'];
    const { run } = importNock(store, [def({ response: chunks, rawHeaders: ['content-type', 'text/event-stream'] })], { source: 'rec.json' });
    const [call] = store.getCalls(run.runId);
    const bytes = store.getBlob(call.end!.responseRef!)!;
    expect(bytes.toString('utf8')).toBe(chunks.join(''));
    store.close();
  });

  it('never stores credentials from reqheaders', () => {
    const store = open();
    const { run } = importNock(store, [def()], { source: 'rec.json' });
    const [call] = store.getCalls(run.runId);
    expect(JSON.stringify(call.meta)).not.toContain('sk-ant-secret');
    expect(call.meta.fingerprintHeaders).toEqual({ 'anthropic-version': '2023-06-01' });
    store.close();
  });

  it('skips entries that are not nock definitions, and non-model hosts', () => {
    const store = open();
    const { imported, skipped } = importNock(store, [def(), { method: 'POST' }, def({ scope: 'https://example.com' })], { source: 'rec.json' });
    expect(imported).toHaveLength(1);
    expect(skipped.map((s) => s.reason)).toEqual(['not a nock definition: needs scope and path', 'not a model API host']);
    store.close();
  });

  it('fingerprints the same call identically to the HAR importer', () => {
    // Two formats describing one request must produce one identity, or a recording captured with
    // one tool and replayed against the other would fork at call 1.
    const a = open();
    const fromNock = importNock(a, [def()], { source: 'rec.json' });

    const b = open();
    const fromHar = importHar(
      b,
      {
        log: {
          version: '1.2',
          entries: [
            {
              request: {
                method: 'POST',
                url: 'https://api.anthropic.com/v1/messages',
                headers: [
                  { name: 'content-type', value: 'application/json' },
                  { name: 'anthropic-version', value: '2023-06-01' },
                  { name: 'x-api-key', value: 'sk-ant-secret' },
                ],
                postData: { mimeType: 'application/json', text: JSON.stringify(body) },
              },
              response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], content: { mimeType: 'application/json', text: JSON.stringify(answer) } },
            },
          ],
        },
      },
      { source: 'in.har' },
    );

    expect(a.getCalls(fromNock.run.runId)[0].fingerprint).toBe(b.getCalls(fromHar.run.runId)[0].fingerprint);
    a.close();
    b.close();
  });
});

const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

describe('a capture is untrusted input', () => {
  it('escapes control characters in headers and bounds their size', () => {
    const store = open();
    const { run } = importNock(
      store,
      [
        def({
          rawHeaders: ['content-type', 'application/json', 'x-evil', ESC + '[2Jcleared the screen', 'x-long', 'y'.repeat(20_000)],
          reqheaders: { 'anthropic-version': '2023-06-01', 'x-sneaky': 'a' + BELL + 'b' },
        }),
      ],
      { source: 'rec.json' },
    );
    const [call] = store.getCalls(run.runId);
    const headers = call.end!.meta.headers!;
    // Escaped for display, not passed through to whatever renders it.
    expect(headers['x-evil']).toBe('BACKSLASHx1b[2Jcleared the screen'.replace('BACKSLASH', String.fromCharCode(92)));
    expect(headers['x-evil']).not.toContain(ESC);
    expect(headers['x-long'].length).toBe(8192);
    expect(JSON.stringify(call.meta)).not.toContain(BELL);
    store.close();
  });

  it('keeps a legitimate fingerprint header byte for byte', () => {
    const store = open();
    const { run } = importNock(store, [def()], { source: 'rec.json' });
    expect(store.getCalls(run.runId)[0].meta.fingerprintHeaders).toEqual({ 'anthropic-version': '2023-06-01' });
    store.close();
  });
});
