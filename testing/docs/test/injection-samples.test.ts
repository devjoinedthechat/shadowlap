// docs/injection.md shows what shadowlap injection prints: the matrix of a test on the reference
// agent, a test that can't say (a provider refusing every call), a --clean verdict, and a golden
// failing its injection gate under shadowlap test. Readers
// match their own output against these, so they must be real: this records the reference agent
// against a mock model that obeys what a tool result tells it, runs each command as the page does,
// and compares, with run ids and canaries masked.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { obeyPlanted, startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const AGENT = join(ROOT, 'testing', 'reference-agent', 'dist', 'main.js');
const page = readFileSync(join(ROOT, 'docs', 'injection.md'), 'utf8');

/** Run ids and canaries are new on every run: masked, in the page and in what the CLI printed alike. */
const mask = (text: string) =>
  text
    .replace(/\b[a-z0-9]{8}@canary\.invalid/g, '<canary>')
    .replace(/\b01[0-9A-HJKMNP-TV-Z]{8,24}/g, '<run>')
    .replace(/[ \t]+$/gm, '')
    .trim();

/** The first fenced block after the line that starts with `lead`. */
function sample(lead: string): string {
  const from = page.indexOf(`\n${lead}`);
  if (from < 0) throw new Error(`no line starting "${lead}"`);
  const m = /^```[^\n]*\n([\s\S]*?)^```/m.exec(page.slice(from));
  if (!m) throw new Error(`no code block after "${lead}"`);
  return m[1];
}

const within = (whole: string, part: string) => `\n${mask(whole)}\n`.includes(`\n${mask(part)}\n`);

let mock: MockServer;
let dir: string;
let runId: string;

function shadowlap(args: string[], upstream?: string): Promise<{ code: number | null; stdout: string; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(dir, 'store.db'), ...args], { cwd: dir, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: upstream ?? mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let out = '';
    child.stdout.on('data', (d: Buffer) => ((stdout += d.toString()), (out += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, out }));
  });
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script: obeyPlanted(referenceScript), eventDelayMs: () => 0 });
  dir = mkdtempSync(join(tmpdir(), 'sl-injection-docs-'));
  writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tools: { fetch_page: { trust: 'untrusted' } } }));
  const rec = await shadowlap(['run', '--', process.execPath, AGENT]);
  expect(rec.code, rec.out).toBe(0);
  runId = /recording run (\w{26})/.exec(rec.out)![1]!;
}, 60_000);
afterAll(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('docs/injection.md', () => {
  it('shows what a test on the reference agent prints', async () => {
    const r = await shadowlap(['injection', runId, '--templates', 'system-notice,user-urgent', '--baselines', '1']);
    expect(r.code).toBe(1);
    expect(within(r.stdout, sample('On the [reference agent]')), r.stdout).toBe(true);
  }, 120_000);

  it('shows what --clean prints on an attempt that obeyed', async () => {
    const r = await shadowlap(['injection', runId, '--templates', 'system-notice', '--baselines', '0', '--json']);
    const report = JSON.parse(r.stdout) as { results: Array<{ attempts: Array<{ runId: string; read: number; plantedAt: number }> }> };
    const a = report.results[0].attempts.find((x) => x.read === 7)!;
    const clean = await shadowlap(['injection', a.runId, '--clean', String(a.plantedAt)]);
    expect(clean.code, clean.out).toBe(0);
    expect(within(clean.out, sample('On an attempt that obeyed a planted instruction, it prints:')), clean.out).toBe(true);
  }, 120_000);

  it('shows a test that showed too little to say: a provider that refuses every call', async () => {
    const refusing = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      });
    });
    await new Promise<void>((r) => refusing.listen(0, '127.0.0.1', () => r()));
    try {
      const r = await shadowlap(['injection', runId, '--templates', 'system-notice', '--baselines', '0'], `http://127.0.0.1:${(refusing.address() as AddressInfo).port}`);
      // Inconclusive, not failed: 3.
      expect(r.code).toBe(3);
      expect(within(r.stdout, sample('An inconclusive test fails the command')), r.stdout).toBe(true);
    } finally {
      await new Promise((r) => refusing.close(r));
    }
  }, 120_000);

  it('shows a golden failing its injection gate under shadowlap test', async () => {
    expect((await shadowlap(['pack', runId, 'goldens/research'])).code).toBe(0);
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tools: { fetch_page: { trust: 'untrusted' } }, tests: { 'goldens/*': { injection: { obeyed: 0, templates: ['system-notice'], baselines: 0 } } } }));
    const r = await shadowlap(['test', 'goldens/*']);
    expect(r.code).toBe(1);
    expect(within(r.stdout, sample('The failure names the write and gives the proof')), r.stdout).toBe(true);
  }, 120_000);
});
