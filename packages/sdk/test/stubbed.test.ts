import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tool } from '../src/index.js';

/**
 * A write tool under `--writes stub`, as `shadowlap test --update` re-records a golden: it doesn't
 * run, and the agent gets what is recorded, so a replay of the new golden gives it the same value.
 */
let server: Server;
const completed: unknown[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.url?.includes('/complete')) completed.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url?.endsWith('/resolve') ? { origin: 'stubbed', callNo: 9 } : { ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.SHADOWLAP_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t/token`;
});
afterAll(async () => {
  delete process.env.SHADOWLAP_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('a stubbed write', () => {
  it('returns null without onFork, as its replay will: JSON keeps no undefined', async () => {
    let ran = 0;
    const issueRefund = tool('issue_refund', { effect: 'write' }, async (_args: { order_id: string }) => {
      ran++;
      return { refund_id: 'R-1' };
    });
    completed.length = 0;
    const got = await issueRefund({ order_id: 'A-1042' });
    expect(ran).toBe(0);
    expect(got).toBeNull();
    // What the agent serializes into its next request is the same live and on replay.
    expect(JSON.stringify(got)).toBe('null');
    expect(completed).toEqual([{ outcome: 'ok', result: null, latencyMs: 0 }]);
  });

  it('returns what onFork gives, and records it', async () => {
    const sendEmail = tool('send_email', { effect: 'write', onFork: (a: { to: string }) => ({ sent: false, to: a.to }) }, async (_a: { to: string }) => ({ sent: true }));
    const silent = tool('notify', { effect: 'write', onFork: (_a: { channel: string }) => undefined }, async (_a: { channel: string }) => undefined);
    completed.length = 0;
    expect(await sendEmail({ to: 'customer@example.com' })).toEqual({ sent: false, to: 'customer@example.com' });
    expect(await silent({ channel: 'on-call' })).toBeNull();
    expect(completed).toEqual([
      { outcome: 'ok', result: { sent: false, to: 'customer@example.com' }, latencyMs: 0 },
      { outcome: 'ok', result: null, latencyMs: 0 },
    ]);
  });
});
