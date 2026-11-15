import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { importHar } from '../src/import-har.js';
import { importLitellm, providerEndpoint, readLitellmGroups } from '../src/import-litellm.js';

/**
 * The record shape here is a real one, captured from LiteLLM 1.101 behind the repository's mock
 * OpenAI server, trimmed. The header list in particular is what a proxy actually sees, including
 * the `x-stainless-*` set the official clients send.
 */
const body = (question: string) => ({ model: 'gpt-4.1-mini', max_tokens: 64, messages: [{ role: 'user', content: question }] });
const answer = { id: 'chatcmpl-1', created: 1_700_000_010, model: 'gpt-4.1-mini', object: 'chat.completion', choices: [{ finish_reason: 'stop', index: 0, message: { content: 'ok', role: 'assistant' } }], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } };

const record = (over: Record<string, unknown> = {}) => ({
  format: 'shadowlap-capture',
  v: 1,
  url: 'http://127.0.0.1:4410/v1/chat/completions',
  method: 'POST',
  requestHeaders: {
    host: '127.0.0.1:4410',
    'user-agent': 'OpenAI/JS 7.16.0',
    'x-stainless-retry-count': '0',
    'x-shadowlap-run': 'incident-42',
    'content-type': 'application/json',
    'content-length': '96',
  },
  requestBody: body('what is a fork'),
  status: 200,
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: JSON.stringify(answer),
  startedAt: 1_789_745_374_433,
  runKey: 'incident-42',
  timeMs: 180,
  ...over,
});

const file = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const open = () => Store.open(':memory:');

describe('import litellm', () => {
  it('maps a gateway route onto the provider endpoint the agent believed it was calling', () => {
    // A capture carries the gateway's own URL, which matches no provider host; the route says which
    // dialect the agent was speaking, and that is what it will send again on replay.
    expect(providerEndpoint('http://litellm.internal/v1/chat/completions')).toEqual({ host: 'api.openai.com', path: '/v1/chat/completions' });
    expect(providerEndpoint('http://litellm.internal/chat/completions')).toEqual({ host: 'api.openai.com', path: '/v1/chat/completions' });
    expect(providerEndpoint('http://gw/v1/messages')).toEqual({ host: 'api.anthropic.com', path: '/v1/messages' });
    expect(providerEndpoint('http://gw/v1/responses')?.path).toBe('/v1/responses');
    expect(providerEndpoint('http://gw/health')).toBeNull();
  });

  it('imports a run with its usage and model', () => {
    const store = open();
    const [run] = importLitellm(store, file(record()), { source: 'cap.jsonl' });
    expect(run.key).toBe('incident-42');
    expect(run.imported).toHaveLength(1);
    expect(run.imported[0]).toMatchObject({ name: 'POST /v1/chat/completions', provider: 'openai', model: 'gpt-4.1-mini' });
    const [call] = store.getCalls(run.run.runId);
    expect(call.end?.meta.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(call.end?.meta.latencyMs).toBe(180);
    expect(run.run.meta?.covers).toEqual(['api']);
    store.close();
  });

  it('makes one run per correlation id, because a gateway serves the whole fleet', () => {
    const store = open();
    const runs = importLitellm(
      store,
      file(
        record({ runKey: 'a', requestBody: body('one') }),
        record({ runKey: 'b', requestBody: body('two') }),
        record({ runKey: 'a', requestBody: body('three') }),
      ),
      { source: 'cap.jsonl' },
    );
    expect(runs.map((r) => [r.key, r.imported.length])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    // Two runs, so two different run ids: the conversations do not get mixed.
    expect(new Set(runs.map((r) => r.run.runId)).size).toBe(2);
    store.close();
  });

  it('keeps calls with no correlation id together, under a null key', () => {
    const store = open();
    const noKey = record();
    delete (noKey as Record<string, unknown>).runKey;
    const runs = importLitellm(store, file(noKey, { ...noKey, requestBody: body('second') }), { source: 'cap.jsonl' });
    expect(runs).toHaveLength(1);
    expect(runs[0].key).toBeNull();
    expect(runs[0].imported).toHaveLength(2);
    store.close();
  });

  it('counts a repeated identical request as a second occurrence within its run', () => {
    const store = open();
    const [run] = importLitellm(store, file(record(), record()), { source: 'cap.jsonl' });
    expect(store.getCalls(run.run.runId).map((c) => c.occurrence)).toEqual([1, 2]);
    store.close();
  });

  it('tolerates a half-written last line, because a proxy appends while serving', () => {
    const store = open();
    const groups = readLitellmGroups(file(record()) + '{"format":"shadowlap-cap');
    expect(groups[0].calls).toHaveLength(1);
    expect(groups[0].skipped.map((s) => s.reason)).toEqual(['not JSON (a partly written line?)']);
    store.close();
  });

  it('skips a route it does not recognise, and refuses a file that is not a capture', () => {
    const store = open();
    const groups = readLitellmGroups(file(record({ url: 'http://127.0.0.1:4410/health' })));
    expect(groups[0].calls).toHaveLength(0);
    expect(groups[0].skipped[0].reason).toMatch(/not a route/);
    expect(() => readLitellmGroups('{"hello":"world"}')).toThrow(/not a shadowlap capture/);
    expect(() => readLitellmGroups('')).toThrow(/not a shadowlap capture/);
    store.close();
  });

  it('reads only shadowlap captures', () => {
    expect(() => readLitellmGroups(file(record({ format: 'other-capture' })))).toThrow(/not a shadowlap capture/);
  });

  it('keeps a streamed response as an event stream, so the agent still parses it', () => {
    const store = open();
    const sse = 'data: {"object":"chat.completion.chunk"}\n\ndata: [DONE]\n\n';
    const [run] = importLitellm(
      store,
      file(record({ requestBody: { ...body('s'), stream: true }, responseHeaders: { 'content-type': 'text/event-stream' }, responseBody: sse })),
      { source: 'cap.jsonl' },
    );
    const [call] = store.getCalls(run.run.runId);
    expect(call.end?.meta.headers?.['content-type']).toBe('text/event-stream');
    expect(store.getBlob(call.end!.responseRef!)!.toString('utf8')).toBe(sse);
    store.close();
  });

  it('fingerprints the same request identically to the HAR importer', () => {
    // A fourth format, one identity: what captured a request must not change what it matches.
    const a = open();
    const [fromGateway] = importLitellm(a, file(record()), { source: 'cap.jsonl' });
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
                url: 'https://api.openai.com/v1/chat/completions',
                headers: [{ name: 'content-type', value: 'application/json' }],
                postData: { mimeType: 'application/json', text: JSON.stringify(body('what is a fork')) },
              },
              response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], content: { mimeType: 'application/json', text: JSON.stringify(answer) } },
            },
          ],
        },
      },
      { source: 'in.har' },
    );
    expect(a.getCalls(fromGateway.run.runId)[0].fingerprint).toBe(b.getCalls(fromHar.run.runId)[0].fingerprint);
    a.close();
    b.close();
  });
});
