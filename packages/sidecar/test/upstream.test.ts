import { createServer, request, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { requestUpstream, Sidecar } from '../src/server.js';

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

describe('a model call upstream when the sidecar closes', () => {
  it('is answered while its agent waits for it, and ended once its agent has gone, so no slow model keeps the process running', async () => {
    // The upstream holds every request until the test answers it; `cut` says whether one ended unanswered.
    const held: Array<{ body: string; res: ServerResponse; cut: Promise<boolean> }> = [];
    const url = await serve((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => held.push({ body, res, cut: new Promise((resolve) => res.on('close', () => resolve(!res.writableFinished))) }));
    });
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: url } });
    try {
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      const ask = (content: string) => {
        const body = JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content }] });
        // No keep-alive: an agent's connection ends with it, as a process's does when it exits.
        const req = request(`${sidecar.envFor(run.runId).ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' } });
        const answer = new Promise<{ status: number; body: string } | null>((resolve) => {
          req.on('response', (res) => {
            let text = '';
            res.on('data', (d) => (text += d));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
          });
          req.on('error', () => resolve(null));
        });
        req.end(body);
        return { req, answer };
      };
      const waits = ask('an agent that waits');
      const gone = ask('an agent stopped by Ctrl-C');
      await until(() => held.length === 2);
      // Stopped part way: its connection to the sidecar closes while its model call is upstream.
      gone.req.destroy();
      const closed = sidecar.close();
      // The agent still connected gets its answer: closing waits for it.
      const answered = held.find((h) => h.body.includes('waits'))!;
      answered.res.writeHead(200, { 'content-type': 'application/json' });
      answered.res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }));
      expect(await waits.answer).toMatchObject({ status: 200, body: expect.stringContaining('"done"') });
      await closed;
      // Nobody is left to read the other one's answer: closing ended it, without waiting for one.
      const orphan = held.find((h) => h.body.includes('Ctrl-C'))!;
      expect(await Promise.race([orphan.cut, new Promise((resolve) => setTimeout(() => resolve('still waiting upstream'), 5_000))])).toBe(true);
    } finally {
      for (const h of held) if (!h.res.writableEnded) h.res.destroy();
      store.close();
    }
  });
});

async function until(ready: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !ready(); await new Promise((resolve) => setTimeout(resolve, 10))) {
    if (Date.now() > end) throw new Error('timed out waiting');
  }
}
