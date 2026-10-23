import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { parseSegment } from '@shadowlap/remote';
import { startFakeS3, type FakeS3 } from '../../remote/test/fakes/s3.js';
import { storeSet, teamPush, type TeamEnv } from '../src/team.js';

/**
 * The team store commands through the CLI itself, as a user and CI run them: `shadowlap test
 * --push` on a branch and in a pull request's job, `pull --include-pr`, a run pushed while it
 * records and sent when `shadowlap run` ends it, and a store failure printed as a message.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const GOLDEN = join(ROOT, 'testing', 'golden', 'reference-agent');
const KEY = 'AKIDCLIEXAMPLE';
const SECRET = 'cli/secret/key';

let s3: FakeS3;
let work: string;
let noHome: string;

beforeAll(async () => {
  s3 = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'northwind-agent-runs', versioning: 'Enabled', encryption: 'aws:kms' });
  work = mkdtempSync(join(tmpdir(), 'sl-team-cli-'));
  noHome = join(work, 'no-home');
  mkdirSync(noHome);
});
afterAll(async () => {
  await s3.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const storeUrl = (folder: string) => `s3://northwind-agent-runs/${folder}?endpoint=${s3.url}`;
const baseEnv = () => ({ PATH: process.env.PATH ?? '', HOME: noHome, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', AWS_EC2_METADATA_DISABLED: 'true' });
const keys = { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET };

/** Runs the CLI without blocking this process, which serves the fake S3 it talks to. */
function shadowlap(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): { done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  return { done: new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr }))) };
}

function teamEnvFor(cwd: string, author: string): TeamEnv {
  return {
    cwd,
    dbPath: join(cwd, '.shadowlap', 'shadowlap.db'),
    env: { ...keys, SHADOWLAP_AUTHOR: author, NO_COLOR: '1' },
    now: () => Date.now(),
    open: { retryDelayMs: 1, home: noHome },
    io: { out: () => {}, err: () => {} },
  };
}

async function until<T>(fn: () => T | null | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A CI checkout: the goldens and the committed config naming the store. */
function checkout(name: string, folder: string): string {
  const dir = join(work, name);
  cpSync(GOLDEN, join(dir, 'goldens', 'reference-agent'), { recursive: true });
  writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ store: storeUrl(folder) }));
  return dir;
}

const golden = () => (JSON.parse(readFileSync(join(GOLDEN, 'run.json'), 'utf8')) as { runs: Array<{ runId: string }> }).runs[0]!.runId;

describe('the CLI with a team store', () => {
  it('pushes each test run, the golden and the report with test --push', async () => {
    const dir = checkout('ci', 'ci-e2e');
    const r = await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT, '--push'], { cwd: dir, env: { ...baseEnv(), ...keys, SHADOWLAP_AUTHOR: 'ci' } }).done;
    expect(r.stdout).toContain('1 passed, 0 failed');
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('pushed 2 runs and the report to s3://northwind-agent-runs/ci-e2e');

    const runs = [...s3.objects.keys()].filter((k) => k.startsWith('ci-e2e/runs/') && k.endsWith('/run.json')).map((k) => k.split('/')[2]!);
    expect(runs).toHaveLength(2);
    expect(runs).toContain(golden());
    const attempt = runs.find((id) => id !== golden())!;
    const doc = JSON.parse(s3.objects.get(`ci-e2e/runs/${attempt}/run.json`)!.body.toString()) as { run: { parentRunId: string; meta: { author?: string } } };
    expect(doc.run).toMatchObject({ parentRunId: golden(), meta: { author: 'ci' } });
    const segments = [...s3.objects.keys()].filter((k) => k.startsWith('ci-e2e/index/'));
    expect(segments.flatMap((k) => parseSegment(s3.objects.get(k)!.body, k).runs.map((e) => e.runId)).sort()).toEqual([...runs].sort());
    expect([...s3.objects.keys()].filter((k) => k.startsWith('ci-e2e/tests/'))).toHaveLength(1);
  });

  it("sends a pull request's test runs to its own folder, which pull --include-pr brings", async () => {
    const dir = checkout('pr', 'pr-e2e');
    const env = { ...baseEnv(), ...keys, SHADOWLAP_AUTHOR: 'ci', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/314/merge' };
    const r = await shadowlap(['test', 'goldens/reference-agent', '--cwd', ROOT, '--push'], { cwd: dir, env }).done;
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("GitHub Actions (pull_request): its runs go to pull request 314's own folder in the store");
    expect(r.stderr).toContain('pushed 2 runs and the report to s3://northwind-agent-runs/pr-e2e/pr/314');
    const written = [...s3.objects.keys()].filter((k) => k.startsWith('pr-e2e/'));
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((k) => k.startsWith('pr-e2e/pr/314/'))).toBe(true);

    // A teammate's pull leaves the pull request's runs out, unless asked.
    const mine = join(work, 'pr-teammate');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'shadowlap.config.json'), JSON.stringify({ store: storeUrl('pr-e2e') }));
    const plain = await shadowlap(['pull', '--json'], { cwd: mine, env: { ...baseEnv(), ...keys, SHADOWLAP_AUTHOR: 'maya@northwind.example' } }).done;
    expect(plain.code).toBe(0);
    expect(JSON.parse(plain.stdout)).toMatchObject({ pulled: [], pullRequests: [] });
    const withPr = await shadowlap(['pull', '--include-pr', '--json'], { cwd: mine, env: { ...baseEnv(), ...keys, SHADOWLAP_AUTHOR: 'maya@northwind.example' } }).done;
    expect(withPr.code).toBe(0);
    const out = JSON.parse(withPr.stdout) as { pullRequests: Array<{ number: string; pulled: string[] }> };
    expect(out.pullRequests.map((x) => [x.number, x.pulled.length])).toEqual([['314', 2]]);
  });

  it('sends a run pushed while it recorded when shadowlap run ends it', async () => {
    const dir = join(work, 'recording');
    mkdirSync(dir, { recursive: true });
    const t = teamEnvFor(dir, 'dana@northwind.example');
    storeSet(t, storeUrl('run-e2e'));
    const go = join(dir, 'go');
    // The agent runs until the test lets it end.
    const agent = "const fs = require('fs'); const t = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(t); }, 20);";
    const cli = shadowlap(['run', '--', process.execPath, '-e', agent, go], { cwd: dir, env: { ...baseEnv(), ...keys, SHADOWLAP_AUTHOR: 'dana@northwind.example' } });
    const runId = await until(() => {
      const store = Store.open(t.dbPath);
      try {
        return store.allRuns().find((r) => r.status === 'running')?.runId;
      } finally {
        store.close();
      }
    });
    expect(await teamPush(t, [runId])).toBe(0);
    expect(s3.objects.has(`run-e2e/runs/${runId}/run.json`)).toBe(false);
    writeFileSync(go, '');
    const r = await cli.done;
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`pushed ${runId.slice(0, 10)} to s3://northwind-agent-runs/run-e2e, as asked while it was recording`);
    expect(s3.objects.has(`run-e2e/runs/${runId}/run.json`)).toBe(true);
  });

  it("prints a store it can't reach as a message, not a stack", async () => {
    const dir = join(work, 'nocreds');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ store: storeUrl('nocreds') }));
    const r = await shadowlap(['pull'], { cwd: dir, env: { ...baseEnv(), SHADOWLAP_AUTHOR: 'x@northwind.example' } }).done;
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^✗ No AWS credentials found/m);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});
