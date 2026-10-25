import { createServer, type Server } from 'node:http';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text } from '@shadowlap-testing/mock-anthropic';
import { Sidecar, sdkBasesFromEnvironment } from '../src/index.js';

/**
 * An OpenAI-compatible server whose API root doesn't end in /v1 (GitHub Models' `.../inference`,
 * Gemini's `.../v1beta/openai`): the SDK sends `/chat/completions` straight under its base URL, and
 * so does the sidecar, while the call keeps its name.
 */
let server: Server;
let origin: string;
const paths: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    paths.push(req.url ?? '');
    req.resume();
    req.on('end', () => {
      if (req.url !== '/inference/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `no route ${req.url}` } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'gpt-5', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const ask = (sidecar: Sidecar, runId: string) =>
  new OpenAI({ apiKey: 'k', baseURL: sidecar.envFor(runId).OPENAI_BASE_URL, maxRetries: 0 }).chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });

describe('an SDK base URL with no /v1 under it', () => {
  it('gets the SDK\'s own path, recorded under the usual call name, and replays', async () => {
    const store = Store.open(':memory:');
    const base = `${origin}/inference`;
    const sidecar = await Sidecar.start({ store, upstreams: { openai: base }, sdkBases: { openai: base } });
    try {
      paths.length = 0;
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
      expect((await ask(sidecar, rec.runId)).choices[0].message.content).toBe('hello');
      sidecar.endRun(rec.runId, 'completed');
      expect(paths).toEqual(['/inference/chat/completions']);
      expect(store.getCalls(rec.runId).map((c) => c.name)).toEqual(['POST /v1/chat/completions']);

      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['a'], cwd: '.' } });
      expect((await ask(sidecar, rep.runId)).choices[0].message.content).toBe('hello');
      expect(sidecar.endRun(rep.runId, 'completed').summary.divergence).toBeNull();
      expect(paths).toHaveLength(1);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('leaves an upstream given as a root alone (SHADOWLAP_UPSTREAM_OPENAI), and one that isn\'t the base', async () => {
    for (const sdkBases of [{}, { openai: `${origin}/elsewhere` }]) {
      const store = Store.open(':memory:');
      const sidecar = await Sidecar.start({ store, upstreams: { openai: `${origin}/inference` }, sdkBases });
      try {
        paths.length = 0;
        const rec = sidecar.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
        await expect(ask(sidecar, rec.runId)).rejects.toThrow(/404/);
        sidecar.endRun(rec.runId, 'completed');
        expect(paths).toEqual(['/inference/v1/chat/completions']);
      } finally {
        await sidecar.close();
        store.close();
      }
    }
  });

  it('is read from OPENAI_BASE_URL when it doesn\'t end in /v1', () => {
    expect(sdkBasesFromEnvironment({ OPENAI_BASE_URL: 'https://models.github.ai/inference/' })).toEqual({ openai: 'https://models.github.ai/inference' });
    expect(sdkBasesFromEnvironment({ OPENAI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/' })).toEqual({ openai: 'https://generativelanguage.googleapis.com/v1beta/openai' });
    for (const OPENAI_BASE_URL of [undefined, '', 'http://localhost:11434/v1', 'https://openrouter.ai/api/v1/', 'http://127.0.0.1:4000/t/0123456789abcdef0123456789abcdef/openai/v1', 'not a url', 'file:///tmp/x']) {
      expect(sdkBasesFromEnvironment({ OPENAI_BASE_URL })).toEqual({});
    }
  });
});

/**
 * The Vercel AI SDK's Anthropic provider reads ANTHROPIC_BASE_URL as an API root that ends in /v1, and
 * sends `/messages` under it: the call reaches the API at /v1/messages, under the name the official
 * SDKs' calls have, and replays from the recording.
 */
describe('an Anthropic base URL read as one that holds the /v1', () => {
  it('reaches /v1/messages, is named POST /v1/messages, and replays', async () => {
    const mock = await startMockAnthropic({ script: () => ({ message: message([text('escalated')]) }) });
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    // As @ai-sdk/anthropic sends it: `${baseURL}/messages`.
    const ask = async (runId: string) => {
      const res = await fetch(`${sidecar.envFor(runId).ANTHROPIC_BASE_URL}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'Refund order A-1042.' }] }),
      });
      return { status: res.status, body: (await res.json()) as { content?: Array<{ text: string }> } };
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
      const recorded = await ask(rec.runId);
      sidecar.endRun(rec.runId, 'completed');
      expect(recorded.status).toBe(200);
      expect(recorded.body.content?.[0]?.text).toBe('escalated');
      expect(mock.requests).toHaveLength(1);
      expect(store.getCalls(rec.runId).map((c) => c.name)).toEqual(['POST /v1/messages']);

      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['a'], cwd: '.' } });
      expect((await ask(rep.runId)).body.content?.[0]?.text).toBe('escalated');
      expect(sidecar.endRun(rep.runId, 'completed').summary.divergence).toBeNull();
      expect(mock.requests).toHaveLength(1);
    } finally {
      await sidecar.close();
      store.close();
      await mock.close();
    }
  });
});
