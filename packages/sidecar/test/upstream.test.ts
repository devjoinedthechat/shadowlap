import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { requestUpstream } from '../src/server.js';

/**
 * The sidecar's requests to model providers and declared HTTP hosts. They replaced fetch(), which
 * ends a call whose response headers take more than five minutes (a non-streaming request to a slow
 * model) with "fetch failed". That limit is too long to test here; everything else fetch did, this
 * must still do.
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

describe('requestUpstream', () => {
  it('sends the body and headers, and streams the response as it arrives', async () => {
    const seen: string[] = [];
    const url = await serve((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push(`${req.method} ${req.headers['x-test']} ${req.headers['content-length']} ${body}`);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 150);
      });
    });
    const started = Date.now();
    const res = await requestUpstream(`${url}/v1/chat/completions`, 'POST', { 'x-test': 'yes' }, Buffer.from('{"a":1}'));
    expect(seen).toEqual(['POST yes 7 {"a":1}']);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const first = await reader.read();
    // The first event is readable before the server has finished.
    expect(new TextDecoder().decode(first.value)).toBe('data: one\n\n');
    expect(Date.now() - started).toBeLessThan(150);
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    expect(rest).toBe('data: two\n\n');
  });

  it('decodes a compressed body, as fetch did, since the encoding header is not passed on', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync('{"ok":true}'));
    });
    const res = await requestUpstream(url, 'GET', {}, null);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('gives a response without a body where HTTP has none', async () => {
    const url = await serve((req, res) => {
      res.writeHead(req.method === 'HEAD' ? 200 : 204, { 'x-kind': 'empty' });
      res.end();
    });
    for (const method of ['HEAD', 'DELETE']) {
      const res = await requestUpstream(url, method, {}, null);
      expect(res.body).toBeNull();
      expect(res.headers.get('x-kind')).toBe('empty');
    }
  });

  it('rejects when the upstream cannot be reached, and errors a body cut off part way', async () => {
    const closed = await serve((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    await expect(requestUpstream(closed, 'GET', {}, null)).rejects.toThrow(/ECONNREFUSED/);

    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('only part');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const res = await requestUpstream(url, 'GET', {}, null);
    await expect(res.text()).rejects.toThrow();
  });
});
