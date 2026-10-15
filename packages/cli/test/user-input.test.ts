import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer, type Script } from '@shadowlap-testing/mock-anthropic';

/**
 * What a person types is recorded as `user_input` calls, so an interactive agent replays, tests and
 * blames with no one at the keyboard. Recordings here are made the way a person makes them: the
 * answer is typed when the prompt appears. Replays start the agent with stdin ignored, as `test`,
 * `blame` and `verify` do.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const READLINE_AGENT = fileURLToPath(new URL('./readline-agent.mjs', import.meta.url));
const CHAT = fileURLToPath(new URL('../../../examples/support-chat/support_chat.py', import.meta.url));
const PY_SDK = fileURLToPath(new URL('../../../sdks/python', import.meta.url));
// The example's scripted model, so the chat here is the one its README walks through.
const MOCK_MODEL = fileURLToPath(new URL('../../../examples/support-chat/mock_model.mjs', import.meta.url));

function pythonAvailable(): string | null {
  for (const cmd of ['python3', 'python']) {
    try {
      const v = execFileSync(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      if (/Python 3\.(9|[1-9]\d)/.test(v)) return cmd;
    } catch {
      // try the next one
    }
  }
  return null;
}
const PYTHON = pythonAvailable();

let cwd: string;
let db: string;
let mock: MockServer;
const env = () => ({ ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, PYTHONPATH: PY_SDK });

interface Outcome {
  code: number | null;
  out: string;
}

/** Runs the CLI with stdin ignored, as a test, a blame or a verify starts an agent. */
function shadowlap(args: string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

/** Runs the CLI with a person at its input: each answer is typed once the prompt shows, then the input ends. */
function converse(args: string[], prompt: string, answers: string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    const queue = [...answers];
    let out = '';
    let pending = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      pending += c.toString();
      if (!pending.endsWith(prompt)) return;
      pending = '';
      const next = queue.shift();
      setTimeout(() => (next === undefined ? child.stdin.end() : child.stdin.write(`${next}\n`)), 20);
    });
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

/** Runs the CLI with all the input given at once, as a pipe or a file gives it. */
function piped(args: string[], input: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

function latestRecording(): string {
  const store = Store.open(db);
  try {
    return store.allRuns().find((r) => r.mode === 'record')!.runId;
  } finally {
    store.close();
  }
}

function inputsOf(runId: string) {
  const store = Store.open(db);
  try {
    return store
      .getCalls(runId)
      .filter((c) => c.meta.input === true)
      .map((c) => ({ name: c.name, effect: c.effect, prompt: store.getJson<{ args: { prompt: string } }>(c.requestRef!)!.args.prompt, outcome: c.end!.outcome, result: store.getJson<{ result?: unknown; error?: { name: string } }>(c.end!.responseRef!) }));
  } finally {
    store.close();
  }
}

beforeAll(async () => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-user-input-')));
  db = join(cwd, 'store.db');
  const { supportScript } = (await import(MOCK_MODEL)) as { supportScript: Script };
  mock = await startMockAnthropic({ script: supportScript, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('recorded user input: Node readline', () => {
  for (const [style, prompt] of [
    ['promises', '> '],
    ['callback', '? '],
    ['promisify', '# '],
  ] as const) {
    it(`records rl.question (${style}) as a person answers it, and replays it with no one there`, async () => {
      const rec = await converse(['run', '--', process.execPath, READLINE_AGENT, style], prompt, ['first', 'second one', '']);
      expect(rec.code).toBe(0);
      expect(rec.out).toContain('heard second one (10)');
      const runId = latestRecording();
      expect(inputsOf(runId)).toEqual([
        { name: 'user_input', effect: 'read', prompt, outcome: 'ok', result: { result: { text: 'first' } } },
        { name: 'user_input', effect: 'read', prompt, outcome: 'ok', result: { result: { text: 'second one' } } },
        { name: 'user_input', effect: 'read', prompt, outcome: 'ok', result: { result: { text: '' } } },
      ]);

      const replay = await shadowlap(['replay', runId]);
      expect(replay.code).toBe(0);
      expect(replay.out).toContain('Replay clean: 5/5 calls replayed (0 api, 5 tool)');
      // The interface closes when the conversation does, not when the ignored input ends.
      expect(replay.out.indexOf('[closed]')).toBeGreaterThan(replay.out.indexOf('heard second one (10)'));
    });
  }

  it('records lines read with for await, and the end of the input', async () => {
    const rec = await piped(['run', '--', process.execPath, READLINE_AGENT, 'lines'], 'first\nsecond one\n');
    expect(rec.code).toBe(0);
    const runId = latestRecording();
    expect(inputsOf(runId).map((i) => [i.prompt, i.outcome, i.result])).toEqual([
      ['', 'ok', { result: { text: 'first' } }],
      ['', 'ok', { result: { text: 'second one' } }],
      ['', 'error', { error: { name: 'EOFError', message: 'end of input' } }],
    ]);
    const replay = await shadowlap(['replay', runId]);
    expect(replay.out).toContain('Replay clean: 5/5 calls replayed');
    expect(replay.out).toMatch(/heard first \(5\)\nheard second one \(10\)\n[\s\S]*\[done\]/);
  });

  it('asks again after the fork with --live-input, where no one answers', async () => {
    await converse(['run', '--', process.execPath, READLINE_AGENT, 'promises'], '> ', ['first', 'second one', '']);
    const runId = latestRecording();
    writeFileSync(join(cwd, 'other.json'), JSON.stringify({ text: 'other' }));
    const served = await shadowlap(['replay', runId, '--override', '1=@other.json']);
    expect(served.out).toContain('heard other (5)');
    expect(served.out).toContain('heard second one (10)');
    const live = await shadowlap(['replay', runId, '--override', '1=@other.json', '--live-input']);
    expect(live.out).toContain('heard other (5)');
    expect(live.out).not.toContain('heard second one');
  });
});

describe.skipIf(!PYTHON)('recorded user input: Python', () => {
  it('records each input() of the support chat, and replays the chat with no one typing', async () => {
    const rec = await piped(['run', '--', PYTHON!, CHAT], 'My blender arrived broken. Order A-1042.\nA replacement, please.\nNo, thanks!\n');
    expect(rec.code).toBe(0);
    expect(rec.out).toContain('Done: a replacement ships today as S-5531. Anything else?');
    const runId = latestRecording();
    expect(inputsOf(runId).map((i) => [i.prompt, i.result])).toEqual([
      ['How can I help? ', { result: { text: 'My blender arrived broken. Order A-1042.' } }],
      ['> ', { result: { text: 'A replacement, please.' } }],
      ['> ', { result: { text: 'No, thanks!' } }],
      ['> ', { error: { name: 'EOFError', message: 'end of input' } }],
    ]);

    const replay = await shadowlap(['replay', runId]);
    expect(replay.code).toBe(0);
    expect(replay.out).toContain('Replay clean: 11/11 calls replayed (5 api, 6 tool), 0 upstream requests');
    expect(replay.out).toContain('Glad I could help. Have a good day.');
  });

  it('answers differently as the user: the run forks there, and the later answers come in order', async () => {
    const runId = latestRecording();
    writeFileSync(join(cwd, 'reply.json'), JSON.stringify({ text: 'A refund, please.' }));
    const fork = await shadowlap(['replay', runId, '--override', '5=@reply.json']);
    expect(fork.out).toContain('Forked at call 6');
    expect(fork.out).toContain('- "A replacement, please."');
    expect(fork.out).toContain('+ "A refund, please."');
    // The refund is a write after the fork: blocked. Then the recorded "No, thanks!" ends the chat.
    expect(fork.out).toContain('issue_refund blocked after divergence');
    expect(fork.out).toContain('Glad I could help. Have a good day.');
  });

  it('passes as a golden under shadowlap test, which starts the agent with no one at the keyboard', async () => {
    const runId = latestRecording();
    expect((await shadowlap(['pack', runId, 'goldens/chat'])).code).toBe(0);
    const test = await shadowlap(['test', 'goldens/chat']);
    expect(test.out).toMatch(/1 passed/);
    expect(test.code).toBe(0);
  });

  it('leaves a child process that reads a pipe from its parent alone: that is not a person typing', async () => {
    const script = "import subprocess, sys\nr = subprocess.run([sys.executable, '-c', 'print(input().upper())'], input='from the parent\\n', capture_output=True, text=True)\nprint(r.stdout.strip())\nprint(input('you? '))";
    const rec = await piped(['run', '--', PYTHON!, '-c', script], 'from a person\n');
    expect(rec.out).toContain('FROM THE PARENT');
    expect(inputsOf(latestRecording()).map((i) => i.result)).toEqual([{ result: { text: 'from a person' } }]);
  });

  it('records the lines of sys.stdin, a last line without a line ending included', async () => {
    const rec = await piped(['run', '--', PYTHON!, '-c', 'import sys\nfor line in sys.stdin: print(repr(line))'], 'one\ntwo');
    expect(rec.out).toContain("'one\\n'\n'two'");
    const runId = latestRecording();
    expect(inputsOf(runId).map((i) => i.result)).toEqual([{ result: { text: 'one' } }, { result: { text: 'two', newline: false } }, { error: { name: 'EOFError', message: 'end of input' } }]);
    const replay = await shadowlap(['replay', runId]);
    expect(replay.out).toContain("'one\\n'\n'two'");
    expect(replay.out).toContain('Replay clean: 3/3 calls replayed');
  });
});
