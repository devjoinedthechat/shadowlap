import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { tool } from '../src/index.js';
import { VERSION } from '../src/version.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('the SDK names itself to the sidecar', () => {
  let server: Server | undefined;
  const url = process.env.SHADOWLAP_URL;
  afterEach(async () => {
    if (url === undefined) delete process.env.SHADOWLAP_URL;
    else process.env.SHADOWLAP_URL = url;
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  });

  it('with x-shadowlap-sdk: node/<version> on every call', async () => {
    const seen: Array<[string, string | undefined]> = [];
    server = createServer((req: IncomingMessage, res) => {
      req.resume();
      req.on('end', () => {
        seen.push([req.url ?? '', req.headers['x-shadowlap-sdk'] as string | undefined]);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(req.url?.endsWith('/resolve') ? { origin: 'live', callNo: 1 } : { ok: true }));
      });
    });
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready));
    process.env.SHADOWLAP_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
    const add = tool('add', { effect: 'pure' }, async ({ a, b }: { a: number; b: number }) => a + b);
    expect(await add({ a: 1, b: 2 })).toBe(3);
    expect(seen).toEqual([
      ['/token/v1/calls/resolve', `node/${VERSION}`],
      ['/token/v1/calls/1/complete', `node/${VERSION}`],
    ]);
  });

  it('whose version is the package\'s', () => {
    expect(VERSION).toBe((JSON.parse(readFileSync(`${ROOT}packages/sdk/package.json`, 'utf8')) as { version: string }).version);
  });
});

describe('the SDK as Node loads it', () => {
  // Node takes the package's `node` entry, which brings AsyncLocalStorage with a static import, so a
  // scope holds from the first call even on a Node without process.getBuiltinModule (before 20.16).
  it('keeps a scope without process.getBuiltinModule', async () => {
    const code = `
      delete process.getBuiltinModule;
      process.env.SHADOWLAP_URL = 'http://127.0.0.1:9/never-asked';
      const { scope, currentScope } = await import('@shadowlap/sdk');
      const inner = await scope('researcher', async () => { await new Promise((r) => setTimeout(r, 1)); return scope('search', () => currentScope()); });
      console.log(JSON.stringify(inner));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8' });
    expect(JSON.parse(stdout.trim())).toBe('researcher/search');
  });
});
