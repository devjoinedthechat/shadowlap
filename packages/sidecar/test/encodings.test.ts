import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '../src/server.js';
import { requestUpstream } from '../src/upstream.js';

/**
 * Answers in a content encoding. The agent's own accept-encoding goes upstream, so a provider may
 * answer compressed: what Node can decode (gzip, deflate, brotli, zstd) is decoded for the recording
 * and the agent alike; an encoding it can't decode goes on to the agent as it came, with its
 * content-encoding, and a replay serves it the same way.
 */

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const zstd = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;

describe('an answer in a content encoding', () => {
  it.skipIf(!zstd)('is decoded from zstd, which httpx asks for where zstandard is installed', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'zstd' });
      res.end(zstd!(Buffer.from('{"ok":true}')));
    });
    const res = await requestUpstream(url, 'GET', { 'accept-encoding': 'gzip, deflate, br, zstd' }, null);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('that Node cannot decode reaches the agent as it came, with its encoding, and replays the same', async () => {
    const raw = Buffer.from([0x1f, 0x9d, 0x90, 0x7b, 0x22]);
    const url = await serve((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'compress' });
        res.end(raw);
      });
    });
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: url } });
    const ask = (runId: string) =>
      new Promise<{ headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        const req = httpRequest(`${sidecar.envFor(runId).ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'accept-encoding': 'compress' } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }));
      });
    try {
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
      const live = await ask(run.runId);
      expect(live.headers['content-encoding']).toBe('compress');
      expect(live.body).toEqual(raw);
      sidecar.endRun(run.runId, 'completed');
      const [call] = store.getCalls(run.runId);
      expect(call!.end!.meta.headers?.['content-encoding']).toBe('compress');
      expect(store.getBlob(call!.end!.responseRef!)).toEqual(raw);

      const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['agent'], cwd: '/' }, offline: true });
      const again = await ask(replay.runId);
      expect(again.headers['content-encoding']).toBe('compress');
      expect(again.body).toEqual(raw);
      expect(sidecar.endRun(replay.runId, 'completed').summary.divergence).toBeNull();
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('is decoded as it streams, so a compressed stream reaches the agent event by event', async () => {
    const events = ['event: message_start\ndata: {"type":"message_start"}\n\n', 'event: ping\ndata: {"type":"ping"}\n\n'];
    let release = () => {};
    const url = await serve((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
        const gzip = zlib.createGzip();
        gzip.pipe(res);
        gzip.write(events[0]);
        gzip.flush(zlib.constants.Z_SYNC_FLUSH);
        // The second event only once the agent has the first.
        release = () => gzip.end(events[1]);
      });
    });
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: url } });
    try {
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
      const got = await new Promise<string[]>((resolve, reject) => {
        const seen: string[] = [];
        const req = httpRequest(`${sidecar.envFor(run.runId).ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'accept-encoding': 'gzip' } }, (res) => {
          expect(res.headers['content-encoding']).toBeUndefined();
          res.on('data', (c: Buffer) => {
            seen.push(c.toString('utf8'));
            if (seen.length === 1) release();
          });
          res.on('end', () => resolve(seen));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }));
      });
      expect(got.join('')).toBe(events.join(''));
      expect(got[0]).toBe(events[0]);
      sidecar.endRun(run.runId, 'completed');
      expect(store.getBlob(store.getCalls(run.runId)[0]!.end!.responseRef!)!.toString('utf8')).toBe(events.join(''));
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
