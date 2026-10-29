import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BodyTooLarge, readBody, type BodyLimits } from '../src/body.js';

/**
 * The one reader of a request's body, which the sidecar, the CLI's servers and the collector share:
 * whole or not at all. There were five, with four ways of meeting a body over the limit, and the MCP
 * proxy's resolved what it had read when the connection failed.
 */

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A server that reads each request's body with `limits` and answers what came of it; `seen` gets each outcome. */
async function server(limits: BodyLimits): Promise<{ url: string; seen: Array<{ body?: string; error?: string; status?: number }> }> {
  const seen: Array<{ body?: string; error?: string; status?: number }> = [];
  const s = createServer((req: IncomingMessage, res: ServerResponse) => {
    readBody(req, limits).then(
      (body) => {
        seen.push({ body: body.toString('utf8') });
        res.end(`read ${body.length}`);
      },
      (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        seen.push({ error: e.message, ...(e instanceof BodyTooLarge ? { status: e.status } : {}) });
        if (!res.destroyed) res.writeHead(e instanceof BodyTooLarge ? 413 : 400).end(e.message);
      },
    );
  });
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
}

/** Sends `body`, and what came back: the status and text, or the error the connection ended with. */
function send(url: string, body: Buffer): Promise<{ status?: number; text?: string; error?: string }> {
  return new Promise((resolve) => {
    const req = request(url, { method: 'POST', headers: { 'content-length': String(body.length) } }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode!, text }));
      res.on('error', (err) => resolve({ error: err.message }));
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.end(body);
  });
}

/** Lets what a server does on a connection's end run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("a request's body", () => {
  it('is read whole, up to its limit and at it', async () => {
    const { url, seen } = await server({ limit: 1024 });
    expect(await send(url, Buffer.alloc(1024, 'a'))).toEqual({ status: 200, text: 'read 1024' });
    expect(await send(url, Buffer.alloc(0))).toEqual({ status: 200, text: 'read 0' });
    expect(seen).toEqual([{ body: 'a'.repeat(1024) }, { body: '' }]);
  });

  it('is refused past its limit, with nothing of it read, the rest thrown away so the 413 gets back', async () => {
    const { url, seen } = await server({ limit: 64 * 1024, drain: 16 * 64 * 1024 });
    expect(await send(url, Buffer.alloc(70_000, 'b'))).toEqual({ status: 413, text: 'the request is over 64 KB' });
    expect(seen).toEqual([{ error: 'the request is over 64 KB', status: 413 }]);
    expect(new BodyTooLarge(32 * 1024 * 1024).message).toBe('the request is over 32 MB');
    expect(new BodyTooLarge(1024 ** 3).message).toBe('the request is over 1 GB');
  });

  it('drops the connection past what it drains, and at once by default', async () => {
    const drained = await server({ limit: 1024, drain: 4096 });
    expect((await send(drained.url, Buffer.alloc(64 * 1024))).status).toBeUndefined();
    const at = await server({ limit: 1024 });
    expect((await send(at.url, Buffer.alloc(64 * 1024))).status).toBeUndefined();
    await settle();
    expect(drained.seen).toEqual([{ error: 'the request is over 1 KB', status: 413 }]);
    expect(at.seen).toEqual([{ error: 'the request is over 1 KB', status: 413 }]);
  });

  it('is never a part: a client that leaves halfway gets no body read', async () => {
    const { url, seen } = await server({ limit: 1024 * 1024 });
    await new Promise<void>((resolve) => {
      const req = request(url, { method: 'POST', headers: { 'content-length': '1000' } });
      req.on('error', () => resolve());
      req.write(Buffer.alloc(500, 'c'), () => setTimeout(() => (req.destroy(), resolve()), 50));
    });
    await settle();
    expect(seen).toEqual([{ error: 'the client closed the connection before its request was all sent' }]);
  });
});
