import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer, type Script } from '@shadowlap-testing/mock-anthropic';
import { inputIdentity } from '../src/run-agent.js';

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
const GUARD = fileURLToPath(new URL('../guard/', import.meta.url));

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

/**
 * A person typing is played here through a pipe, each answer written once its prompt shows: CI has
 * no terminal. That can't be recorded on Windows. Node and Python can't tell one pipe from another
 * there, so input through a pipe isn't recorded (a terminal's or a file's is), and a file can't wait
 * for a prompt: readline hands the lines that come before a question to no one.
 */
const TYPED_THROUGH_A_PIPE = process.platform !== 'win32';

/**
 * How input given all at once reaches the agent: through a pipe, as `printf … | shadowlap run` gives
 * it, or on Windows, where a pipe's input isn't recorded, from a file, as `< answers.txt` gives it.
 */
const ALL_AT_ONCE: 'pipe' | 'file' = process.platform === 'win32' ? 'file' : 'pipe';

let cwd: string;
let db: string;
let mock: MockServer;
const env = () => ({ ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, PYTHONPATH: PY_SDK });

interface Outcome {
  code: number | null;
  out: string;
}

/** What the CLI and its agent printed, its lines ended by \n: Python on Windows ends them with \r\n. */
const outcome = (code: number | null, out: string): Outcome => ({ code, out: out.replace(/\r\n/g, '\n') });

/** Runs the CLI with stdin ignored, as a test, a blame or a verify starts an agent. */
function shadowlap(args: string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('exit', (code) => resolve(outcome(code, out)));
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
    child.on('exit', (code) => resolve(outcome(code, out)));
  });
}

let inputFiles = 0;

/** Runs the CLI with all the input given at once, through a pipe or from a file (ALL_AT_ONCE). */
function piped(args: string[], input: string, via: 'pipe' | 'file' = ALL_AT_ONCE): Promise<Outcome> {
  return new Promise((resolve) => {
    let stdin: 'pipe' | number = 'pipe';
    if (via === 'file') {
      const file = join(cwd, `input-${++inputFiles}.txt`);
      writeFileSync(file, input);
      stdin = openSync(file, 'r');
    }
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd, env: env(), stdio: [stdin, 'pipe', 'pipe'] });
    // The CLI has a copy of its own: this one would only keep Windows from deleting the file.
    if (typeof stdin === 'number') closeSync(stdin);
    let out = '';
    child.stdout!.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr!.on('data', (c: Buffer) => (out += c.toString()));
    child.on('exit', (code) => resolve(outcome(code, out)));
    child.stdin?.end(input);
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

/** Every run's id, whether it is marked as made with input recorded, and the run it replayed. */
function runsMarked(): Array<{ runId: string; inputs: boolean; parent: string | null }> {
  const store = Store.open(db);
  try {
    return store.allRuns().map((r) => ({ runId: r.runId, inputs: r.meta?.inputs === true, parent: r.parentRunId }));
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
  // The example's model, and a careful one that won't refund on its own: blame's rescue.
  const careful: Script = (ctx) => {
    const last = ctx.request.messages.at(-1);
    if (ctx.request.model === 'careful-model' && typeof last?.content === 'string' && /refund/i.test(last.content)) {
      return { message: message([text('A refund of $240 needs a manager; I have passed it on. Anything else?')], { model: ctx.request.model }) };
    }
    return supportScript(ctx);
  };
  mock = await startMockAnthropic({ script: careful, eventDelayMs: () => 0 });
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
    it.skipIf(!TYPED_THROUGH_A_PIPE)(`records rl.question (${style}) as a person answers it, and replays it with no one there`, async () => {
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

  it('records the answers in a file given as the input, as `< answers.txt` gives them', async () => {
    const rec = await piped(['run', '--', process.execPath, READLINE_AGENT, 'lines'], 'from a file\n', 'file');
    expect(rec.code, rec.out).toBe(0);
    expect(inputsOf(latestRecording()).map((i) => i.result)).toEqual([{ result: { text: 'from a file' } }, { error: { name: 'EOFError', message: 'end of input' } }]);
  });

  it.runIf(process.platform === 'win32')('leaves input through a pipe unrecorded on Windows, where it could be any pipe', async () => {
    const rec = await piped(['run', '--', process.execPath, READLINE_AGENT, 'lines'], 'first\n', 'pipe');
    expect(rec.code, rec.out).toBe(0);
    // The agent read it as it would have without Shadowlap.
    expect(rec.out).toContain('heard first (5)');
    expect(inputsOf(latestRecording())).toEqual([]);
  });

  it.skipIf(!TYPED_THROUGH_A_PIPE)('asks again after the fork with --live-input, where no one answers', async () => {
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
    // Both runs say they were made with input recorded, so a replay of either treats a new read as a change.
    const marked = runsMarked();
    expect(marked.find((r) => r.runId === runId)?.inputs).toBe(true);
    expect(marked.find((r) => r.parent === runId)?.inputs).toBe(true);
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

  it('is blamed with no one at the keyboard: the answers come from the recording, in order, after each fork', async () => {
    const rec = await piped(['run', '--', PYTHON!, CHAT], 'My blender arrived broken. Order A-1042.\nA refund, please.\nNo, thanks!\n');
    expect(rec.out).toContain('Refunded $240.');
    const runId = latestRecording();
    const blame = await shadowlap(['blame', runId, '--expect', '{"tools":{"issue_refund":0}}', '--model', 'careful-model', '--attempts', '1', '--json']);
    expect(blame.code, blame.out).toBe(0);
    const report = JSON.parse(blame.out.slice(blame.out.indexOf('{'))) as { outcome: string };
    // Model call #6 answered "A refund, please." with the refund: asked again, it escalates and the run passes.
    expect(report).toMatchObject({ outcome: 'blamed', blamed: { callNo: 6 }, lost: { callNo: 8 } });
    // Every probe was a full conversation: the answers after its fork were served from the recording.
    const store = Store.open(db);
    try {
      const probes = store.allRuns().filter((r) => r.meta?.probe?.of === runId);
      expect(probes.length).toBeGreaterThan(1);
      for (const probe of probes) {
        const inputs = store.getCalls(probe.runId).filter((c) => c.meta.input === true);
        expect(inputs.map((c) => c.origin)).toEqual(['replayed', 'replayed', 'replayed', 'replayed']);
      }
    } finally {
      store.close();
    }
  });

  it('is verified with no one at the keyboard: the fix must stop the refund and keep the replacement chat good', async () => {
    await piped(['run', '--', PYTHON!, CHAT], 'My blender arrived broken. Order A-1042.\nA refund, please.\nNo, thanks!\n');
    const refund = latestRecording();
    await piped(['run', '--', PYTHON!, CHAT], 'My blender arrived broken. Order A-1042.\nA replacement, please.\nNo, thanks!\n');
    const replacement = latestRecording();
    expect(replacement).not.toBe(refund);
    const verify = await shadowlap(['verify', '--fixes', refund, '--keeps', replacement, '--expect', '{"tools":{"issue_refund":0}}', '--model', 'careful-model', '--attempts', '1', '--json']);
    expect(verify.code, verify.out).toBe(0);
    const report = JSON.parse(verify.out.slice(verify.out.indexOf('{'))) as { verdict: string; runs: Array<{ runId: string; outcome: string; runs: Array<{ runId: string }> }> };
    expect(report.verdict).toBe('accepted');
    expect(report.runs.map((r) => [r.runId, r.outcome])).toEqual([
      [refund, 'fixed'],
      [replacement, 'kept'],
    ]);
    // Each attempt had the whole conversation: the answers after the fork came from its recording, in order.
    const store = Store.open(db);
    try {
      for (const attempt of report.runs.flatMap((r) => r.runs)) {
        const inputs = store.getCalls(attempt.runId).filter((c) => c.meta.input === true);
        expect(inputs.map((c) => c.origin)).toEqual(['replayed', 'replayed', 'replayed', 'replayed']);
      }
    } finally {
      store.close();
    }
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

describe('the input shadowlap was given', () => {
  it('is named by dev:ino, and on Windows only when it is a file', () => {
    // A pipe on macOS: an inode beyond a double's precision, which Node's big integers give signed.
    expect(inputIdentity({ dev: 0n, ino: -6917529027641081856n, isFile: () => false }, 'darwin')).toBe('0:11529215046068469760');
    // A pipe on Windows, as Node sees it: no device, and this process's handle for it as the inode.
    expect(inputIdentity({ dev: 0n, ino: 476n, isFile: () => false }, 'win32')).toBeNull();
    // A file on Windows: its volume's 32-bit serial number, and its 64-bit file id.
    expect(inputIdentity({ dev: 1787198591n, ino: 562949953421400n, isFile: () => true }, 'win32')).toBe('1787198591:562949953421400');
  });

  it.skipIf(!PYTHON)('is found by Python on Windows, which from 3.12 on gives all 64 bits of the volume\'s serial number', () => {
    // The guard's own check, with what os.fstat gives on Windows for a file and for a pipe.
    const script = [
      'import stat, sys, types',
      'sys.path.insert(0, sys.argv[1])',
      'import _shadowlap_input as m',
      'serial, file_id = 0x0A6A8E956A8E7C7F, 562949953421400',
      'file = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_dev=serial, st_ino=file_id)',
      'pipe = types.SimpleNamespace(st_mode=stat.S_IFIFO, st_dev=0, st_ino=0)',
      'def origin(st, named):',
      '    m.os = types.SimpleNamespace(name="nt", isatty=lambda fd: False, fstat=lambda fd: st, environ={"SHADOWLAP_STDIN": named})',
      '    return m._stdin_origin()',
      'print(origin(file, "%d:%d" % (serial & 0xFFFFFFFF, file_id)), origin(file, "1:%d" % file_id), origin(pipe, "0:0"))',
    ].join('\n');
    // Without SHADOWLAP_URL the module only defines its functions: nothing is installed.
    const out = execFileSync(PYTHON!, ['-c', script, GUARD], { env: { ...process.env, SHADOWLAP_URL: '' } }).toString();
    expect(out.trim()).toBe('person None None');
  });
});
