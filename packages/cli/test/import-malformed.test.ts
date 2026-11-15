import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { importCaptured, type CapturedCall } from '../src/import-capture.js';
import { importHar } from '../src/import-har.js';
import { importLitellm } from '../src/import-litellm.js';
import { importNock } from '../src/import-nock.js';
import { importVcr } from '../src/import-vcr.js';

/**
 * A capture is a file from anywhere: an entry of the wrong shape is skipped with the reason, as one
 * with a bad URL is, the good entries beside it still come in, and nothing is left behind when an
 * import stops part way.
 */

const URL_ = 'https://api.anthropic.com/v1/messages';
const answer = JSON.stringify({ id: 'msg_1', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 1 } });
const request = JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
const open = () => Store.open(':memory:');

const harEntry = (over: { request?: Record<string, unknown>; response?: Record<string, unknown> } = {}) => ({
  request: { method: 'POST', url: URL_, headers: [{ name: 'content-type', value: 'application/json' }], postData: { mimeType: 'application/json', text: request }, ...over.request },
  response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], content: { mimeType: 'application/json', text: answer }, ...over.response },
});
const har = (...entries: unknown[]) => ({ log: { entries } });

describe('a malformed capture', () => {
  it('HAR: skips each entry of the wrong shape with the reason, and imports the rest', () => {
    const store = open();
    const { run, imported, skipped } = importHar(
      store,
      har(
        harEntry(),
        harEntry({ request: { method: 1 } }),
        harEntry({ request: { headers: [{ name: 'x', value: 5 }] } }),
        harEntry({ response: { content: { text: 5 } } }),
        null,
        harEntry({ response: { status: '200' } }),
        harEntry({ request: { postData: { text: { not: 'text' } } } }),
        harEntry({ request: { url: 7 } }),
      ),
      { source: 'bad.har' },
    );
    expect(imported).toHaveLength(1);
    expect(skipped).toEqual([
      { url: URL_, reason: "not a HAR entry: request.method isn't text" },
      { url: URL_, reason: "not a HAR entry: request.headers[0] isn't a name and a value in text" },
      { url: URL_, reason: "not a HAR entry: response.content.text isn't text" },
      { url: '(entry 5)', reason: "not a HAR entry: it isn't an object" },
      { url: URL_, reason: "not a HAR entry: response.status isn't a number" },
      { url: URL_, reason: "not a HAR entry: request.postData.text isn't text" },
      { url: '(entry 8)', reason: "not a HAR entry: request.url isn't text" },
    ]);
    expect(store.getRun(run.runId)).toMatchObject({ status: 'completed' });
    store.close();
  });

  it('VCR: skips an interaction that is null or of the wrong shape', () => {
    const store = open();
    const good = { request: { method: 'POST', uri: URL_, body: request, headers: { 'content-type': ['application/json'] } }, response: { status: { code: 200 }, headers: { 'content-type': ['application/json'] }, body: { string: answer } } };
    const { imported, skipped } = importVcr(store, { interactions: [good, null, 'text', { ...good, request: { ...good.request, method: ['POST'] } }] }, { source: 'cassette.json' });
    expect(imported).toHaveLength(1);
    expect(skipped).toEqual([
      { url: '(no uri)', reason: 'not a VCR interaction: needs request.uri' },
      { url: '(no uri)', reason: 'not a VCR interaction: needs request.uri' },
      { url: URL_, reason: "not a VCR interaction: request.method isn't text" },
    ]);
    store.close();
  });

  it('LiteLLM: skips a line that is null or of the wrong shape', () => {
    const store = open();
    const record = { format: 'shadowlap-capture', v: 1, url: 'http://127.0.0.1:4410/v1/messages', method: 'POST', requestHeaders: { 'content-type': 'application/json' }, requestBody: JSON.parse(request), status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: answer, runKey: 'r1' };
    const lines = [record, null, [1], { ...record, responseBody: 5 }, { ...record, url: 9 }, { ...record, status: 'ok' }, { ...record, runKey: { id: 1 } }].map((r) => JSON.stringify(r)).join('\n');
    const runs = importLitellm(store, lines, { source: 'captures.jsonl' });
    expect(runs.map((r) => r.imported.length)).toEqual([1]);
    expect(runs[0].skipped).toEqual([
      { url: 'line 2', reason: 'not a shadowlap capture record' },
      { url: 'line 3', reason: 'not a shadowlap capture record' },
      { url: 'http://127.0.0.1:4410/v1/messages', reason: "not a shadowlap capture record: responseBody isn't text" },
      { url: 'line 5', reason: "not a shadowlap capture record: url isn't text" },
      { url: 'http://127.0.0.1:4410/v1/messages', reason: "not a shadowlap capture record: status isn't a number" },
      { url: 'http://127.0.0.1:4410/v1/messages', reason: "not a shadowlap capture record: runKey isn't text" },
    ]);
    store.close();
  });

  it('nock: skips a definition whose method or status is of the wrong shape', () => {
    const store = open();
    const def = { scope: 'https://api.anthropic.com:443', method: 'POST', path: '/v1/messages', body: JSON.parse(request), status: 200, response: JSON.parse(answer), headers: { 'content-type': 'application/json' } };
    const { imported, skipped } = importNock(store, [def, null, { ...def, method: 2 }, { ...def, status: '200' }], { source: 'nock.json' });
    expect(imported).toHaveLength(1);
    expect(skipped).toEqual([
      { url: '(no scope or path)', reason: 'not a nock definition: needs scope and path' },
      { url: URL_, reason: "not a nock definition: method isn't text" },
      { url: URL_, reason: "not a nock definition: status isn't a number" },
    ]);
    store.close();
  });

  it('leaves no run behind when a call of the wrong shape gets past its reader', () => {
    const store = open();
    const bad = { url: URL_, method: 1, requestHeaders: {}, requestBody: null, status: 200, responseHeaders: {}, responseBytes: Buffer.from(answer) } as unknown as CapturedCall;
    // The writer checks the shape too, as the last line: a skip, not a raw error.
    expect(importCaptured(store, { calls: [bad], skipped: [] }, { source: 'x' }).skipped).toEqual([{ url: URL_, reason: "the call's method isn't text" }]);
    // And when writing fails part way, the run it started goes with it.
    const failing = { url: URL_, method: 'POST', requestHeaders: {}, requestBody: null, status: 200, responseHeaders: {}, get responseBytes(): Buffer {
      throw new Error('the disk went away');
    } } as unknown as CapturedCall;
    const before = store.allRuns().length;
    expect(() => importCaptured(store, { calls: [failing], skipped: [] }, { source: 'y' })).toThrow('the disk went away');
    expect(store.allRuns()).toHaveLength(before);
    store.close();
  });
});
