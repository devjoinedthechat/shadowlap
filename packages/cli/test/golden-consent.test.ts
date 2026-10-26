import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * `shadowlap test` replays a golden by running the command its pack recorded. A golden this machine
 * recorded is the user's own, and one the project's git repository tracks is reviewed as its code
 * is, which is where CI's goldens are: both run as before. A pack someone sent, outside the
 * repository or in it but not added, runs its command only once the user says yes, as `replay` asks
 * of an imported run: with `--yes`, or a yes at a terminal. Without a terminal, as in CI, it isn't
 * run, and the golden fails saying why. Every run of the agent leaves a line in its folder.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
/** An agent that says it ran, then asks its model one question, which its recording answers on replay. */
const AGENT = `import { appendFileSync } from 'node:fs';
appendFileSync('ran.log', 'ran\\n');
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-test' }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'refund?' }] }) });
console.log((await res.json()).content[0].text);
`;

let mock: MockServer;
let root: string;
let mine: string;
let repo: string;
let outside: string;

function shadowlap(cwd: string, db: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(root, 'home'), SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url };
    delete env.CI;
    // No terminal to ask at: stdin, stdout and stderr are pipes, as in CI.
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const runs = (dir: string) => (existsSync(join(dir, 'ran.log')) ? readFileSync(join(dir, 'ran.log'), 'utf8').split('\n').filter(Boolean).length : 0);
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('refund it')]) }) });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-golden-consent-')));
  // This machine's project: a run recorded here and packed as a golden it hasn't added to git.
  mine = join(root, 'mine');
  mkdirSync(mine);
  writeFileSync(join(mine, 'agent.mjs'), AGENT);
  const recorded = await shadowlap(mine, join(mine, 'store.db'), ['run', '--', process.execPath, 'agent.mjs']);
  expect(recorded.code, recorded.out).toBe(0);
  const runId = /Recorded (\w{26})/.exec(recorded.out)![1];
  const packed = await shadowlap(mine, join(mine, 'store.db'), ['pack', runId, join(mine, 'goldens', 'own')]);
  expect(packed.code, packed.out).toBe(0);
  // Another project, a git repository with a store of its own: the pack arrives from someone else.
  repo = join(root, 'repo');
  mkdirSync(join(repo, 'goldens'), { recursive: true });
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'agent.mjs'), AGENT);
  cpSync(join(mine, 'goldens', 'own'), join(repo, 'goldens', 'tracked'), { recursive: true });
  cpSync(join(mine, 'goldens', 'own'), join(repo, 'goldens', 'sent'), { recursive: true });
  git(repo, ['add', 'goldens/tracked']);
  outside = join(root, 'downloads', 'pack');
  cpSync(join(mine, 'goldens', 'own'), outside, { recursive: true });
  writeFileSync(join(repo, '.gitignore'), '.shadowlap/\nran.log\n');
}, 60_000);
afterAll(async () => {
  await mock.close();
  rmSync(root, { recursive: true, force: true });
});

describe('shadowlap test, given a golden', () => {
  it('runs one this machine recorded, and one the repository tracks, without asking', async () => {
    const before = runs(mine);
    const own = await shadowlap(mine, join(mine, 'store.db'), ['test', 'goldens/own']);
    expect(own.code, own.out).toBe(0);
    expect(runs(mine)).toBe(before + 1);
    const tracked = await shadowlap(repo, join(repo, 'store.db'), ['test', 'goldens/tracked']);
    expect(tracked.code, tracked.out).toBe(0);
    expect(runs(repo)).toBe(1);
  }, 60_000);

  it('runs a pack someone sent, outside the repository or not added, only after --yes, and without a terminal says why', async () => {
    const before = runs(repo);
    for (const pack of ['goldens/sent', outside]) {
      const refused = await shadowlap(repo, join(repo, 'store.db'), ['test', pack]);
      expect(refused.code, refused.out).toBe(1);
      expect(refused.out).toMatch(/was imported from a pack\. Replaying it runs the command it was recorded with/);
      expect(refused.out).toContain("Its pack isn't one this repository tracks. Pass --yes to run it");
      expect(refused.out).toContain("not run: its recorded command came from a pack this repository doesn't track");
      expect(runs(repo), pack).toBe(before);
    }
    const yes = await shadowlap(repo, join(repo, 'store.db'), ['test', 'goldens/sent', '--yes']);
    expect(yes.code, yes.out).toBe(0);
    expect(runs(repo)).toBe(before + 1);
  }, 60_000);

  it('asks of each sent pack when several are tested side by side, and runs none of them without a yes', async () => {
    const before = runs(repo);
    const both = await shadowlap(repo, join(repo, 'store.db'), ['test', 'goldens/sent', outside]);
    expect(both.code, both.out).toBe(1);
    expect(both.out.match(/not run: its recorded command came from a pack this repository doesn't track/g)).toHaveLength(2);
    expect(runs(repo)).toBe(before);
    // The repository's own golden beside them runs as ever.
    const mixed = await shadowlap(repo, join(repo, 'store.db'), ['test', 'goldens/tracked', 'goldens/sent']);
    expect(mixed.code, mixed.out).toBe(1);
    expect(runs(repo)).toBe(before + 1);
  }, 60_000);

  it('asks before a sent pack’s presets with --chaos too', async () => {
    const before = runs(repo);
    const refused = await shadowlap(repo, join(repo, 'store.db'), ['test', outside, '--chaos', '--presets', '500']);
    expect(refused.out).toContain("not run: its recorded command came from a pack this repository doesn't track");
    expect(runs(repo)).toBe(before);
  }, 60_000);
});
