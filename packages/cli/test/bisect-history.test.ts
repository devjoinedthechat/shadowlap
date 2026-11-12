import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type GateHistory } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { runBisect } from '../src/bisect.js';
import { NO_HISTORY } from '../src/golden-test.js';

/**
 * A golden gated against its history is judged against that history at every commit of a search,
 * as `shadowlap test` judges it (E35). Each commit's replay is stood in for here, passing until the
 * commit that marks summaries as drafts, so what is asserted is what every replay is given.
 */
const seen = vi.hoisted(() => [] as Array<GateHistory | null>);
vi.mock('../src/golden-test.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/golden-test.js')>();
  return {
    ...actual,
    testRecording: vi.fn((_run: unknown, _spec: unknown, ctx: { cwd: string; history?: GateHistory | null }) => {
      seen.push(ctx.history ?? null);
      const bad = readFileSync(join(ctx.cwd, 'marker.txt'), 'utf8').includes('DRAFT');
      return Promise.resolve({ attempts: [], interrupted: false, verdict: bad ? 'failed' : 'passed', failure: bad ? { message: 'check failed: output includes "DRAFT"', details: '' } : null, kind: bad ? 'checks' : 'passed', shown: { ended: { summary: { divergence: null } }, checks: [] } });
    }),
  };
});

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = `import { readFileSync } from 'node:fs';
const marker = readFileSync(new URL('./marker.txt', import.meta.url), 'utf8').trim();
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'small-model', max_tokens: 64, messages: [{ role: 'user', content: 'Summarize ticket T-1.' }] }),
});
const body = await res.json();
console.log(marker + body.content.map((b) => b.text ?? '').join(''));
`;
const GATE = { fork: true, gate: { baseline: 'history', min: 1, max: 2 } };

let mock: MockServer;
let project = '';
const at: Record<string, string> = {};
const git = (args: string[]) => execFileSync('git', args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const step = (name: string, files: Record<string, string>) => {
  for (const [f, content] of Object.entries(files)) writeFileSync(join(project, f), content);
  git(['add', '.']);
  git(['commit', '-q', '-m', name]);
  at[name] = git(['rev-parse', '--short', 'HEAD']);
};
/** The CLI outside any CI, so a session's branch is the one checked out. */
const shadowlap = (args: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' };
    for (const k of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE']) delete env[k];
    const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
const bisect = async (target: string) => {
  seen.length = 0;
  const log: string[] = [];
  const report = await runBisect({ opts: { db: join(project, '.shadowlap', 'shadowlap.db') }, target, good: at['Start'], bad: 'HEAD', build: null, cwd: project, projectDir: project, timeoutMs: null, guard: 'off', log: (l) => log.push(l), confirm: () => Promise.resolve(true) });
  return { report, log };
};

beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('Ticket summarized.')]) }) });
  project = mkdtempSync(join(tmpdir(), 'sl-bisect-history-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  step('Start', { '.gitignore': '.shadowlap/\n', 'agent.mjs': AGENT, 'marker.txt': '\n' });
  const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
  expect(recorded.code, recorded.out).toBe(0);
  const runId = /recording run (\w{26})/.exec(recorded.out)![1];
  for (const g of ['goldens/kept', 'goldens/fresh']) expect((await shadowlap(['pack', runId, g])).code).toBe(0);
  writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tests: { baselineBranch: 'main', 'goldens/kept': GATE, 'goldens/fresh': GATE } }));
  // One session on the baseline branch that passed: goldens/kept's history.
  const tested = await shadowlap(['test', 'goldens/kept']);
  expect(tested.code, tested.out).toBe(0);
  step('Mark summaries as drafts', { 'marker.txt': 'DRAFT: \n' });
});
afterAll(async () => {
  await mock.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('bisect of a golden gated against its history', () => {
  it('judges every commit against the sessions that passed on the baseline branch', async () => {
    const { report, log } = await bisect('goldens/kept');
    expect(report).toMatchObject({ outcome: 'found', first: { short: at['Mark summaries as drafts'] } });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const h of seen) expect(h).toMatchObject({ sessions: 1, attempts: 1, passes: 1 });
    expect(log.join('\n')).not.toContain(NO_HISTORY);
  });

  it('says once, under its first line, when there is no history yet', async () => {
    const { report, log } = await bisect('goldens/fresh');
    expect(report.outcome).toBe('found');
    for (const h of seen) expect(h).toMatchObject({ attempts: 0 });
    expect(log.filter((l) => l === `  ${NO_HISTORY}`)).toHaveLength(1);
    expect(log[log.indexOf(`  ${NO_HISTORY}`) - 1]).toMatch(/^▸ goldens\/fresh · good /);
  });
});
