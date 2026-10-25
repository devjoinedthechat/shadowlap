// docs/downstream-services.md tells how to record a service the agent calls over HTTP: declare its
// host, and the agent's calls to it are recorded as tools, so its answers replay. This holds the
// page's claims to the CLI with an agent that asks a pricing service for a quote and then asks a
// refunds service to refund it, both small servers here: the calls are recorded without their
// headers, a replay serves them with both services stopped once the request id the agent makes up is
// normalized, a golden of the run passes `shadowlap test` that way, `--live-tool` asks the pricing
// service again, the refund is never sent again after a fork, and `--fail-at` and `--override`
// answer for the service.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const page = readFileSync(join(ROOT, 'docs', 'downstream-services.md'), 'utf8');

const AGENT = `import { randomBytes, randomUUID } from 'node:crypto';
const headers = { 'content-type': 'application/json', authorization: 'Bearer s3cret-token-7f2a', traceparent: \`00-\${randomBytes(16).toString('hex')}-\${randomBytes(8).toString('hex')}-01\` };
const quote = await fetch(\`\${process.env.PRICING_URL}/v1/quote\`, { method: 'POST', headers, body: JSON.stringify({ order: 'A-17', request_id: randomUUID() }) });
const priced = quote.ok ? await quote.json() : null;
const refund = await fetch(\`\${process.env.REFUNDS_URL}/v1/refunds\`, { method: 'POST', headers, body: JSON.stringify({ order: 'A-17', amount: priced?.total ?? 0 }) });
console.log('RESULT ' + JSON.stringify({ quote: quote.status, total: priced?.total ?? null, refund: refund.status, refunded: await refund.text() }));
`;

interface Service {
  server: Server;
  url: string;
  host: string;
  calls: number;
}

async function service(answer: (body: string) => unknown): Promise<Service> {
  const s = { calls: 0 } as Service;
  s.server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      s.calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer(body)));
    });
  });
  await new Promise<void>((resolve) => s.server.listen(0, '127.0.0.1', resolve));
  s.host = `127.0.0.1:${(s.server.address() as AddressInfo).port}`;
  s.url = `http://${s.host}`;
  return s;
}
const stop = (s: Service) => new Promise<void>((resolve) => s.server.close(() => resolve()));

let dir: string;
let pricing: Service;
let refunds: Service;
let run: string;
let quoteName: string;

interface Ran {
  code: number | null;
  out: string;
  result: { quote: number; total: number | null; refund: number; refunded: string } | null;
}

function shadowlap(args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { ...process.env, PRICING_URL: pricing.url, REFUNDS_URL: refunds.url, SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(dir, '.home'), NO_COLOR: '1', CI: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      resolve({ code, out, result: line ? JSON.parse(line.slice('RESULT '.length)) : null });
    });
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sl-downstream-'));
  pricing = await service(() => ({ order: 'A-17', total: 180 }));
  refunds = await service((body) => ({ refunded: (JSON.parse(body) as { amount: number }).amount }));
  quoteName = `POST ${pricing.host}/v1/quote`;
  writeFileSync(join(dir, 'agent.mjs'), AGENT);
  writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ http: { [pricing.host]: 'read', [refunds.host]: 'write' } }));
  const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
  expect(recorded.code, recorded.out).toBe(0);
  expect(recorded.result).toEqual({ quote: 200, total: 180, refund: 200, refunded: '{"refunded":180}' });
  run = /Recorded ([0-9A-Z]{26})/.exec(recorded.out)![1]!;
}, 60_000);

afterAll(async () => {
  for (const s of [pricing, refunds]) if (s?.server.listening) await stop(s);
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('a service the agent calls, recorded as an HTTP tool', () => {
  it('is the answer the compare page gives where it lists a separate service as not recorded', () => {
    const compare = readFileSync(join(ROOT, 'docs', 'compare.md'), 'utf8');
    expect(compare).toMatch(/a separate service, or another machine, does not\.[^\n]*\(\.\/downstream-services\.md\)/);
    expect(readFileSync(join(ROOT, 'docs', 'index.md'), 'utf8')).toContain('(./downstream-services.md)');
  });

  it('is a tool call named after its method, host and path, with no request headers kept', async () => {
    const shown = JSON.parse((await shadowlap(['show', run, '--json'])).out) as { calls: Array<{ callNo: number; kind: string; name: string; effect: string }> };
    expect(shown.calls.map((c) => [c.kind, c.name, c.effect])).toEqual([
      ['tool', quoteName, 'read'],
      ['tool', `POST ${refunds.host}/v1/refunds`, 'write'],
    ]);
    const request = (await shadowlap(['show', run, '--request', '1'])).out;
    expect(request).toContain('"request_id"');
    expect(request).not.toMatch(/s3cret|traceparent|authorization/i);
    expect(page).toContain('`POST pricing.internal.example.com/v1/quote`');
  });

  it('replays with both services stopped, once the id the agent makes up per call is normalized', async () => {
    await stop(pricing);
    await stop(refunds);
    const before = { pricing: pricing.calls, refunds: refunds.calls };
    // A new request id in every request: the first call forks, as the page says.
    const forked = await shadowlap(['replay', run, '--strict']);
    expect(forked.code).toBe(1);
    expect(forked.out).toMatch(/Diverged at call 1 \(tool POST 127\.0\.0\.1:\d+\/v1\/quote\)/);
    // The page's normalizer, for this host.
    const command = /```sh\n(shadowlap normalize add [^\n]+)\n```/.exec(page)![1];
    expect(command).toContain("--name 'POST pricing.internal.example.com/v1/quote' --path '$.args.body.request_id'");
    const added = await shadowlap(['normalize', 'add', '--kind', 'tool', '--name', quoteName, '--path', '$.args.body.request_id', '--replace', '<id>']);
    expect(added.code, added.out).toBe(0);
    const clean = await shadowlap(['replay', run, '--strict']);
    expect(clean.code, clean.out).toBe(0);
    expect(clean.out).toContain('Replay clean: 2/2 calls replayed');
    expect(clean.result).toEqual({ quote: 200, total: 180, refund: 200, refunded: '{"refunded":180}' });
    expect({ pricing: pricing.calls, refunds: refunds.calls }).toEqual(before);
  });

  it('makes a golden that passes shadowlap test with neither service there', async () => {
    expect((await shadowlap(['pack', run, join('goldens', 'refund')])).code).toBe(0);
    const tested = await shadowlap(['test', 'goldens/*']);
    expect(tested.code, tested.out).toBe(0);
    expect(tested.out).toMatch(/1 passed, 0 failed · 0 upstream requests/);
  });

  it('asks the service again with --live-tool, and never sends the write again after the fork', async () => {
    pricing.server.listen(Number(pricing.host.split(':')[1]), '127.0.0.1');
    refunds.server.listen(Number(refunds.host.split(':')[1]), '127.0.0.1');
    await Promise.all([pricing, refunds].map((s) => new Promise((r) => (s.server.listening ? r(null) : s.server.once('listening', r)))));
    const before = { pricing: pricing.calls, refunds: refunds.calls };
    const live = await shadowlap(['replay', run, '--live-tool', quoteName]);
    expect(live.code, live.out).toBe(0);
    expect(live.result).toMatchObject({ quote: 200, total: 180, refund: 409 });
    const stubbed = await shadowlap(['replay', run, '--live-tool', quoteName, '--writes', 'stub']);
    expect(stubbed.result).toMatchObject({ refund: 200, refunded: '{"shadowlap":"stubbed"}' });
    expect({ pricing: pricing.calls, refunds: refunds.calls }).toEqual({ pricing: before.pricing + 2, refunds: before.refunds });
    expect(page).toContain(`--live-tool 'POST pricing.internal.example.com/v1/quote'`);
  });

  it('answers for the service with --fail-at and --override, without calling it', async () => {
    const before = { pricing: pricing.calls, refunds: refunds.calls };
    const failed = await shadowlap(['replay', run, '--fail-at', '1=503']);
    expect(failed.result).toMatchObject({ quote: 503, total: null, refund: 409 });
    const overridden = await shadowlap(['replay', run, '--override', '1={"total": 0}']);
    expect(overridden.result).toMatchObject({ quote: 200, total: 0, refund: 409 });
    expect({ pricing: pricing.calls, refunds: refunds.calls }).toEqual(before);
    expect(page).toContain(`--fail-at <call>=503`);
    expect(page).toContain(`--override <call>='{"total": 0}'`);
  });
});
