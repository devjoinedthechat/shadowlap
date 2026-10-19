import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReplayedError, ShadowlapInjectedFailure, tool } from '../src/index.js';

/**
 * Tool failures `shadowlap replay --fail-at <call>=timeout|error|<status>` asks for, as the SDK sees
 * them: a stand-in sidecar answers resolve, and the tool never runs nor completes.
 */
let server: Server;
let answer: unknown;
const paths: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    paths.push(req.url ?? '');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url?.endsWith('/resolve') ? answer : { ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.SHADOWLAP_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t/token`;
});
afterAll(async () => {
  delete process.env.SHADOWLAP_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

const injected = (kind: string, error: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ origin: 'replayed', callNo: 7, outcome: 'error', error, injected: { kind, ...extra } });

async function call(): Promise<{ error: unknown; ran: number }> {
  let ran = 0;
  const search = tool('search_web', { effect: 'read' }, async ({ query }: { query: string }) => {
    ran++;
    return { query };
  });
  paths.length = 0;
  try {
    await search({ query: 'refunds' });
    return { error: null, ran };
  } catch (error) {
    return { error, ran };
  }
}

describe('a tool --fail-at fails', () => {
  it('times out: a TimeoutError with ETIMEDOUT, without running or completing', async () => {
    answer = injected('timeout', { name: 'TimeoutError', message: 'search_web timed out', code: 'ETIMEDOUT' });
    const { error, ran } = await call();
    expect(ran).toBe(0);
    expect(error).toBeInstanceOf(ShadowlapInjectedFailure);
    expect(error).not.toBeInstanceOf(ReplayedError);
    const e = error as ShadowlapInjectedFailure;
    expect([e.name, e.message, e.code, e.injected, e.tool, e.args, e.failure]).toEqual(['TimeoutError', 'search_web timed out', 'ETIMEDOUT', true, 'search_web', { query: 'refunds' }, { kind: 'timeout' }]);
    expect(String(e)).toBe('TimeoutError: search_web timed out');
    expect(paths).toEqual(['/t/token/v1/calls/resolve']);
  });

  it('answers with an HTTP status, carried as status and statusCode', async () => {
    answer = injected('status', { name: 'HTTPError', message: 'HTTP 429 Too Many Requests', data: { status: 429 } }, { status: 429 });
    const { error, ran } = await call();
    expect(ran).toBe(0);
    expect(error).toMatchObject({ name: 'HTTPError', message: 'HTTP 429 Too Many Requests', status: 429, statusCode: 429, injected: true });
  });

  it('errors with exactly the message given', async () => {
    answer = injected('error', { name: 'Error', message: 'connection reset by peer' }, { message: 'connection reset by peer' });
    const { error } = await call();
    expect(error).toMatchObject({ name: 'Error', message: 'connection reset by peer', injected: true, status: undefined });
  });

  it('is still a replayed error when the answer carries no injected kind', async () => {
    answer = { origin: 'replayed', callNo: 7, outcome: 'error', error: { name: 'ValueError', message: 'bad query' } };
    const { error } = await call();
    expect(error).toBeInstanceOf(ReplayedError);
  });

  it('replays an error that reads as the recorded one, wherever the agent prints it', async () => {
    const original = new TypeError('order A-17 not found');
    answer = { origin: 'replayed', callNo: 7, outcome: 'error', error: { name: original.name, message: original.message } };
    const { error } = await call();
    expect(error).toBeInstanceOf(ReplayedError);
    const firstLine = (e: unknown) => inspect(e).split('\n')[0];
    expect([String(error), firstLine(error), (error as Error).stack?.split('\n')[0]]).toEqual([String(original), firstLine(original), original.stack?.split('\n')[0]]);
    const again = await call();
    expect((again.error as object).constructor).toBe((error as object).constructor);
  });

  it('refuses an origin it does not know rather than running the tool', async () => {
    answer = { origin: 'teleported', callNo: 7 };
    const { error, ran } = await call();
    expect(ran).toBe(0);
    expect(String(error)).toContain('unknown origin "teleported"');
  });
});
