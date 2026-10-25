import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * HTTP hosts declared under "http" in shadowlap.config.json, through the CLI: an agent that calls a
 * search service (read) and a webhook (write) with plain fetch is recorded without wrapping anything,
 * replays without calling either, and after a fork searches live while its webhook post is blocked.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./http-agent.mjs', import.meta.url));

let mock: MockServer;
let cwd: string;
const hits = { search: 0, webhook: 0 };
const servers: Server[] = [];
const urls: Record<string, string> = {};

function serve(name: 'search' | 'webhook', handler: (body: Record<string, unknown>) => unknown): Promise<string> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits[name]++;
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=secret' });
      res.end(JSON.stringify(handler(JSON.parse(raw || '{}') as Record<string, unknown>)));
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('answered')]) }) });
  urls.search = await serve('search', (b) => ({ hits: [{ text: `about ${String(b.query)} #1` }, { text: `about ${String(b.query)} #2` }] }));
  urls.webhook = await serve('webhook', () => ({ ok: true }));
  cwd = mkdtempSync(join(tmpdir(), 'fp-http-'));
  const host = (u: string) => new URL(u).host;
  writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ http: { [host(urls.search)]: 'read', [host(urls.webhook)]: 'write' } }));
});
afterAll(async () => {
  await mock.close();
  for (const s of servers) s.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SEARCH_URL: urls.search, WEBHOOK_URL: urls.webhook, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}
const agentLine = (stdout: string) => JSON.parse(stdout.split('\n').find((l) => l.startsWith('{'))!) as { hits: number; answer: string; notify: number };

describe('HTTP hosts recorded as tools', () => {
  it('records the calls, replays them without touching the services, and fences the write after a fork', async () => {
    const recorded = await shadowlap(['run', '--guard', 'warn', '--', process.execPath, AGENT]);
    expect(recorded.code, recorded.out).toBe(0);
    expect(recorded.out).not.toMatch(/bypassed Shadowlap/);
    expect(agentLine(recorded.stdout)).toEqual({ hits: 2, answer: 'answered', notify: 200 });
    expect(hits).toEqual({ search: 1, webhook: 1 });
    const runId = /recording run (\w{26})/.exec(recorded.out)![1];

    const shown = JSON.parse((await shadowlap(['show', runId, '--json'])).stdout) as { calls: Array<{ kind: string; name: string; effect: string | null; origin: string }> };
    const port = (u: string) => new URL(u).port;
    expect(shown.calls.map((c) => [c.kind, c.name, c.effect])).toEqual([
      ['tool', `POST 127.0.0.1:${port(urls.search)}/query`, 'read'],
      ['api', 'POST /v1/messages', null],
      ['tool', `POST 127.0.0.1:${port(urls.webhook)}/notify`, 'write'],
    ]);

    const replay = await shadowlap(['replay', runId, '--strict']);
    expect(replay.code, replay.out).toBe(0);
    expect(replay.out).toMatch(/Replay clean: 3\/3 calls replayed/);
    expect(agentLine(replay.stdout)).toEqual({ hits: 2, answer: 'answered', notify: 200 });
    expect(hits).toEqual({ search: 1, webhook: 1 });

    const fork = await shadowlap(['replay', runId], { QUERY: 'shipping times' });
    expect(fork.code, fork.out).toBe(0);
    expect(fork.out).toMatch(/Diverged at call 1 \(tool POST 127\.0\.0\.1:\d+\/query\)/);
    expect(fork.out).toMatch(/- "refund policy"/);
    expect(agentLine(fork.stdout)).toEqual({ hits: 2, answer: 'answered', notify: 409 });
    expect(hits).toEqual({ search: 2, webhook: 1 });
  });
});
