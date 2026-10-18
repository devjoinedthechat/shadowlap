import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { isIgnored, watchAndRerun } from '../src/watch.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `ok()` holds, or fails after `ms`. */
async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe('--watch ignores', () => {
  it('skips generated, hidden and vendored paths', () => {
    // Shadowlap writes its own store while replaying; watching it would loop forever.
    for (const path of [
      '.shadowlap/shadowlap.db',
      '.shadowlap/shadowlap.db-wal',
      'node_modules/ai/index.js',
      '.git/index',
      '.venv/lib/python3.12/site-packages/x.py',
      'src/__pycache__/agent.cpython-312.pyc',
      'coverage/lcov.info',
      'packages/cli/node_modules/x/y.js',
      '.DS_Store',
    ]) {
      expect(isIgnored(path), path).toBe(true);
    }
  });

  // fs.watch reports a backslash path on Windows and a forward-slash one everywhere else, and a
  // test that writes paths portably uses forward slashes on both. Windows has to read either.
  it.runIf(process.platform === 'win32')('skips the backslash paths Windows reports', () => {
    for (const path of ['node_modules\\ai\\index.js', '.shadowlap\\shadowlap.db', 'packages\\cli\\node_modules\\x\\y.js']) {
      expect(isIgnored(path), path).toBe(true);
    }
    for (const path of ['src\\agent.ts', 'goldens\\run\\run.json']) {
      expect(isIgnored(path), path).toBe(false);
    }
  });

  it('watches source, including build output an edit produces', () => {
    // `dist/` is how a TypeScript agent's change actually reaches the replay.
    for (const path of ['agent.py', 'src/agent.ts', 'dist/agent.js', 'prompts/system.md', 'goldens/run/run.json']) {
      expect(isIgnored(path), path).toBe(false);
    }
  });
});

describe('--watch and what a replay writes itself', () => {
  it('replays once per save: never again for files the replay wrote, or for a save made while it ran', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-watch-'));
    const logs: string[] = [];
    let runs = 0;
    let editDuringRun = false;
    const stop = new AbortController();
    try {
      const watching = watchAndRerun({
        cwd: dir,
        debounceMs: 100,
        ignore: [join(dir, 'summary.json')],
        log: (m) => logs.push(m),
        signal: stop.signal,
        run: async () => {
          runs++;
          // What an agent and the replay write: a report, a temporary file it removes, a summary.
          writeFileSync(join(dir, 'report.txt'), 'the same report every time\n');
          writeFileSync(join(dir, 'scratch.tmp'), 'x');
          rmSync(join(dir, 'scratch.tmp'));
          if (editDuringRun) writeFileSync(join(dir, 'prompt.md'), 'edited while it ran\n');
          await sleep(300);
          writeFileSync(join(dir, 'summary.json'), '{}\n');
        },
      });
      await until(() => logs.some((l) => l.startsWith('watching')), 10_000, 'the first replay');
      expect(runs).toBe(1);
      expect(logs.join('\n')).toContain("changed while the replay ran: taken for the replay's own writes, so no replay follows");
      await sleep(1_500);
      expect(runs, 'its own writes start no replay').toBe(1);

      writeFileSync(join(dir, 'agent.js'), 'console.log(1)\n');
      await until(() => runs === 2, 10_000, 'the replay after a save');
      await sleep(1_500);
      expect(runs, 'one save, one replay').toBe(2);

      // A save while it runs is dropped, and said so.
      editDuringRun = true;
      writeFileSync(join(dir, 'agent.js'), 'console.log(2)\n');
      await until(() => runs === 3, 10_000, 'the replay after a second save');
      await sleep(1_500);
      expect(runs).toBe(3);
      expect(logs.at(-1)).toMatch(/prompt\.md/);
      stop.abort();
      await watching;
    } finally {
      stop.abort();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

/** One model call, then the report the agent writes into the project on every run. */
const AGENT = `import { writeFileSync } from 'node:fs';
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'small-model', max_tokens: 64, messages: [{ role: 'user', content: 'Write the report.' }] }),
});
writeFileSync('report.txt', JSON.stringify(await res.json()) + '\\n');
`;

describe('shadowlap replay --watch', () => {
  let mock: MockServer;
  let project: string;
  beforeAll(async () => {
    mock = await startMockAnthropic({ script: () => ({ message: message([text('Done.')]) }) });
    project = mkdtempSync(join(tmpdir(), 'sl-watch-cli-'));
    writeFileSync(join(project, 'agent.mjs'), AGENT);
  });
  afterAll(async () => {
    await mock.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('replays once per save when the agent, the store and the summary all write into the project', async () => {
    const env = { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' };
    const recorded = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [CLI, '--db', 'runs.db', 'run', '--', process.execPath, 'agent.mjs'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', () => resolve(out));
    });
    const runId = /recording run (\w{26})/.exec(recorded)![1]!;
    const watcher = spawn(process.execPath, [CLI, '--db', 'runs.db', 'replay', runId, '--watch', '--summary-json', 'out.json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    watcher.stdout.on('data', (d: Buffer) => (out += d.toString()));
    watcher.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const replays = () => out.split('Replay clean').length - 1;
    const exited = new Promise((resolve) => watcher.on('exit', resolve));
    try {
      await until(() => out.includes('watching'), 20_000, 'the first replay');
      await sleep(2_000);
      expect(replays(), out).toBe(1);
      writeFileSync(join(project, 'scenario.js'), '// one edit\n');
      await until(() => replays() >= 2, 20_000, 'the replay after the save');
      await sleep(2_500);
      expect(replays(), out).toBe(2);
    } finally {
      watcher.kill('SIGTERM');
      await exited;
    }
  }, 60_000);
});
