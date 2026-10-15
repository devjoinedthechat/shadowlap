import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError, send } from '@shadowlap/remote';

/**
 * The one way the drivers talk to a cloud: a slow transfer goes on as long as data keeps coming, a
 * stalled or cut-off one is tried again, and an answer larger than asked for fails without being
 * read.
 */

let server: Server;
let base: string;
let cutOnce = true;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/slow') {
      // 10 chunks, 150 ms apart: longer than the 1 s wait in all, and never idle for more than a
      // fraction of it, even on a busy machine.
      res.writeHead(200, { 'content-type': 'text/plain' });
      let n = 0;
      const tick = setInterval(() => {
        res.write(`chunk${n}\n`);
        if (++n === 10) {
          clearInterval(tick);
          res.end();
        }
      }, 150);
      return;
    }
    if (req.url === '/stall') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('a little, then nothing');
      return; // never ends
    }
    if (req.url === '/cut') {
      if (cutOnce) {
        cutOnce = false;
        res.writeHead(200, { 'content-length': '100' });
        res.write('only part');
        res.socket?.destroy();
        return;
      }
      res.writeHead(200);
      return res.end('whole');
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-length': String(10_000) });
      return res.end(Buffer.alloc(10_000));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('send', () => {
  it('lets a slow answer finish while data keeps coming', async () => {
    const started = Date.now();
    const res = await send({ method: 'GET', url: `${base}/slow` }, { timeoutMs: 1000, attempts: 1 });
    expect(res.body.toString().trim().split('\n')).toHaveLength(10);
    expect(Date.now() - started).toBeGreaterThan(1000);
  });

  it('gives up on an answer that stops, after trying again', async () => {
    const started = Date.now();
    await expect(send({ method: 'GET', url: `${base}/stall` }, { timeoutMs: 150, attempts: 2, retryDelayMs: 1 })).rejects.toThrow(/stopped sending its answer/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('tries again when an answer is cut off', async () => {
    const res = await send({ method: 'GET', url: `${base}/cut` }, { retryDelayMs: 1 });
    expect(res.body.toString()).toBe('whole');
  });

  it("doesn't read an answer larger than asked for, and doesn't retry it", async () => {
    await expect(send({ method: 'GET', url: `${base}/big` }, { maxBytes: 1000 })).rejects.toThrow(HttpError);
    await expect(send({ method: 'GET', url: `${base}/big` }, { maxBytes: 1000 })).rejects.toThrow(/over the 1000-byte limit/);
  });
});
