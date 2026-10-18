import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recorded } from '../src/index.js';

/**
 * Where recorded() puts a test's recording: one per test, however its name reads. A stand-in host
 * answers the recordings protocol and keeps the directories tests ask for.
 */
let server: Server;
let project: string;
const asked: string[] = [];
let saved: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const json = JSON.parse(body || '{}') as { recording?: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.endsWith('/v1/recordings/start')) {
        asked.push(json.recording!);
        res.end(JSON.stringify({ runId: 'r1', mode: 'record', recording: json.recording }));
      } else {
        res.end(JSON.stringify({ ok: true, mode: 'record', runId: 'r1', recording: 'x', calls: 1, replayed: 0, message: null, report: null }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  project = mkdtempSync(join(tmpdir(), 'sl-recording-names-'));
  saved = process.env.SHADOWLAP_TEST_HOST;
  process.env.SHADOWLAP_TEST_HOST = JSON.stringify({ shadowlap: '0.1.0', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/t/token`, root: project, env: {}, capture: { node: '', python: '' } });
});
afterAll(async () => {
  if (saved === undefined) delete process.env.SHADOWLAP_TEST_HOST;
  else process.env.SHADOWLAP_TEST_HOST = saved;
  rmSync(project, { recursive: true, force: true });
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  asked.length = 0;
});

const file = () => join(project, 'long.spec.mjs');
const folder = () => join(project, '__recordings__', basename(file()));
/** The directory recorded() asks for, for a Vitest test with this full name. */
async function pathFor(name: string): Promise<string> {
  await recorded(async (_context: unknown) => {})({ task: { name, file: { filepath: file() } } });
  return asked.at(-1)!;
}
/** A recording on disk, made by the test with this name. */
function recordingAt(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ format: 'shadowlap-pack', version: 1, runs: [{ runId: 'r0', command: { argv: ['<test>', name], cwd: project } }] }));
}
const hash = (name: string) => createHash('sha256').update(name).digest('hex').slice(0, 8);

describe('recorded() names a recording after its test', () => {
  it('keeps a name that needs nothing else', async () => {
    expect(await pathFor('answers one item')).toBe(join(folder(), 'answers-one-item'));
  });

  it('gives two names that share their first 130 characters a recording each', async () => {
    const long = 'classifies '.repeat(13);
    const a = await pathFor(`${long}a refund`);
    const b = await pathFor(`${long}a triage`);
    expect(a).not.toBe(b);
    expect(basename(a)).toBe(`${'classifies-'.repeat(11).slice(0, 120)}-${hash(`${long}a refund`)}`);
    expect(basename(b).length).toBeLessThanOrEqual(129);
  });

  it('moves a name off another test’s recording when they differ only in punctuation', async () => {
    recordingAt(join(folder(), 'balance'), 'balance?');
    expect(await pathFor('balance?')).toBe(join(folder(), 'balance'));
    expect(await pathFor('balance!')).toBe(join(folder(), `balance-${hash('balance!')}`));
  });

  it('still finds a long name’s recording where an earlier version cut it, for the test that made it', async () => {
    const long = `${'summarises '.repeat(12)}the thread`;
    const cut = long.replace(/[^\w.-]+/g, '-').slice(0, 120);
    recordingAt(join(folder(), cut), long);
    expect(await pathFor(long)).toBe(join(folder(), cut));
    expect(await pathFor(`${long} again`)).toBe(join(folder(), `${cut}-${hash(`${long} again`)}`));
  });
});
