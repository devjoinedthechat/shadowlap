// docs/ci.md gives CI steps to copy: when a recording fails, install the CLI, replay the suite into a
// store that is kept, find the replay of the recording that failed, and export it as one HTML file. A
// step that exports the wrong run looks like it works, so this runs the step exactly as the page prints
// it, with bash and jq as CI has them, against a suite where picking the wrong run is easy: a recording
// that fails next to one marked `fork` that passes, and a recording whose attempts don't all fail. The
// step also runs when another step failed, or when the recording passes the second time: then it must
// say so and pass. Installing the CLI needs the network, so that step is only read.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const GOLDEN = join(ROOT, 'testing', 'golden', 'reference-agent');

/** The `run:` scripts of the YAML block in docs/ci.md that exports a run as HTML, in order: a `run: |` block, or a one-line `run:`. */
function scripts(): string[] {
  const page = readFileSync(join(ROOT, 'docs', 'ci.md'), 'utf8');
  const block = [...page.matchAll(/^```yaml\n([\s\S]*?)^```/gm)].map((m) => m[1]!).find((b) => b.includes('export html'));
  if (!block) throw new Error('docs/ci.md has no YAML step that exports a run as HTML');
  const lines = block.split('\n');
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const found: string[] = [];
  lines.forEach((line, at) => {
    const one = /^\s*run: (?!\|)(.+)$/.exec(line);
    if (one) found.push(one[1]!.trim());
    if (!/^\s*run: \|\s*$/.test(line)) return;
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() && indentOf(l) <= indentOf(line)) break;
      body.push(l);
    }
    const cut = Math.min(...body.filter((l) => l.trim()).map(indentOf));
    found.push(body.map((l) => l.slice(cut)).join('\n'));
  });
  return found;
}

/** The script that replays the suite again and exports the replay that failed. */
function recipe(): string {
  const script = scripts().find((s) => s.includes('export html'));
  if (!script) throw new Error('the step that exports a run has no `run: |` script');
  return script;
}

const hasTools = process.platform !== 'win32' && [['bash', '--version'], ['jq', '--version']].every(([cmd, arg]) => spawnSync(cmd!, [arg!]).status === 0);

let mock: MockServer;
let flaky = false;
let attemptsSeen = 0;
const work: string[] = [];

/** The attempt a request belongs to, from the mark its conversation's first answer carries (see below). */
function attemptOf(request: { messages: Array<{ role: string; content: unknown }> }): number {
  const first = request.messages.find((m) => m.role === 'assistant');
  return Number(/\(attempt (\d+)\)/.exec(JSON.stringify(first?.content ?? ''))?.[1] ?? 0);
}

beforeAll(async () => {
  // The model the reference agent talks to: when the system prompt says "Never send email." it finishes
  // without emailing, so a recording marked `fork` passes a check that the email never happens. With
  // `flaky`, only every other attempt obeys. Each attempt is numbered by its first request, and its first
  // answer carries the number, which every later request of that attempt sends back: so an attempt is
  // told apart by its own conversation, even when attempts run at the same time.
  mock = await startMockAnthropic({
    script: (ctx) => {
      const attempt = ctx.assistantTurns === 0 ? ++attemptsSeen : attemptOf(ctx.request);
      const obeys = JSON.stringify(ctx.request.system ?? '').includes('Never send email.') && (!flaky || attempt % 2 === 0);
      if (obeys && ctx.assistantTurns === 9) {
        return { message: { id: `msg_final_${ctx.requestNo}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Done. Summary kept here, not emailed.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } } as never };
      }
      const result = referenceScript(ctx);
      if (!flaky || ctx.assistantTurns !== 0 || !('message' in result)) return result;
      const content = result.message.content.map((b) => (b.type === 'text' ? { ...b, text: `${b.text} (attempt ${attempt})` } : b));
      return { message: { ...result.message, content } };
    },
  });
});
afterAll(async () => {
  await mock?.close();
  for (const dir of work) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The golden's run id, as `shadowlap test` names the recording it replays: the pack's last run. */
const goldenId = (dir: string) => (JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs: Array<{ runId: string }> }).runs.at(-1)!.runId;

/**
 * A project with the reference agent's golden under each name in `packs`, each a recording of its own
 * (a run id of its own), the given `tests`, and `shadowlap` on the PATH. The recorded command runs
 * `testing/reference-agent`, which a link makes reachable from the project.
 */
function project(packs: string[], tests: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'shadowlap-ci-recipe-'));
  work.push(dir);
  const original = goldenId(GOLDEN);
  packs.forEach((name, i) => {
    const pack = join(dir, 'goldens', name);
    cpSync(GOLDEN, pack, { recursive: true });
    const id = `${original.slice(0, 22)}${'ZYXW'[i]!.repeat(4)}`;
    for (const file of ['run.json', 'calls.jsonl']) writeFileSync(join(pack, file), readFileSync(join(pack, file), 'utf8').split(original).join(id));
  });
  writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tests }));
  symlinkSync(join(ROOT, 'testing'), join(dir, 'testing'), 'dir');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'shadowlap'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(dir, 'bin', 'shadowlap'), 0o755);
  return dir;
}

/**
 * Runs the step's script as GitHub Actions runs a `run:` on Linux: bash -e -o pipefail. By default the
 * agent has a change, which forks it at call 3, its first model call.
 */
function runStep(dir: string, change: Record<string, string> = { AGENT_SYSTEM_SUFFIX: 'Never send email.' }): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url,
      SHADOWLAP_GUARD: 'off',
      SHADOWLAP_TELEMETRY: '0',
      NO_COLOR: '1',
      ...change,
    };
    if (!change.AGENT_SYSTEM_SUFFIX) delete env.AGENT_SYSTEM_SUFFIX;
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', recipe()], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

/** The runs an exported HTML file holds, the one it was exported for first. */
function runsIn(file: string): string[] {
  const data = /<script type="application\/json" id="shadowlap-data">([\s\S]*?)<\/script>/.exec(readFileSync(file, 'utf8'))?.[1];
  if (!data) throw new Error(`${file} holds no run data`);
  return (JSON.parse(data.split('<\\/').join('</')) as { runIds: string[] }).runIds;
}

/** The replays `shadowlap test` made in the kept store, of the recording in `pack`. */
function replaysOf(dir: string, pack: string) {
  const store = Store.open(join(dir, 'replays.db'));
  try {
    const golden = goldenId(join(dir, 'goldens', pack));
    return store.allRuns().filter((r) => r.parentRunId === golden && !r.meta?.imported);
  } finally {
    store.close();
  }
}

describe('the CI steps in docs/ci.md that keep a failed replay', () => {
  it('install the CLI from npm before they use it, at the version the action names', () => {
    const [install, ...rest] = scripts();
    expect(rest).toEqual([recipe()]);
    const version = (JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }).version;
    expect(install).toMatch(new RegExp(`^npm install -g shadowlap@${version.replace(/\./g, '\\.')}\\s+# the version the action step names$`));
  });

  it('read every run they need to: ls is not left at its default of 50', () => {
    expect(recipe()).toMatch(/ls --json -n \d{4,}/);
  });
});

describe.skipIf(!hasTools)('the CI step in docs/ci.md that keeps a failed replay', () => {
  it('says so, and passes, when no recording fails the second time', async () => {
    const dir = project(['passes'], {});
    const r = await runStep(dir, {});
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('✓ passes: 30/30 replayed');
    expect(r.out).toContain('No recording failed on the second run');
    expect(r.out).not.toMatch(/jq: |No such file/);
    expect(existsSync(join(dir, 'failed-run.html'))).toBe(false);
  }, 120_000);

  it('exports the recording that failed, not a recording marked fork that passed beside it', async () => {
    const dir = project(['a-diverges', 'b-forks'], { 'goldens/b-forks': { fork: true, expect: { tools: { send_email: 0 } } } });
    const r = await runStep(dir);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('✗ a-diverges: diverged at call 3');
    expect(r.out).toContain('✓ b-forks: forked at call 3');

    const [failed] = replaysOf(dir, 'a-diverges');
    const [passed] = replaysOf(dir, 'b-forks');
    expect(failed && passed).toBeTruthy();
    // The file is the failed replay, with the recording it replayed.
    expect(runsIn(join(dir, 'failed-run.html'))).toEqual([failed!.runId, goldenId(join(dir, 'goldens', 'a-diverges'))]);
  }, 120_000);

  it('of a recording\'s attempts, exports one that failed', async () => {
    // The first attempt emails and fails, the second passes: the latest replay is the one that passed.
    flaky = true;
    attemptsSeen = 0;
    try {
      const dir = project(['flaky'], { 'goldens/flaky': { fork: true, repeat: 2, expect: { tools: { send_email: 0 } } } });
      const r = await runStep(dir);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('✗ flaky: 1 of 2 attempts passed, 2 needed');

      const attempts = replaysOf(dir, 'flaky');
      const failed = attempts.find((a) => a.meta?.checks?.some((c) => !c.ok));
      const passed = attempts.find((a) => a.meta?.checks?.every((c) => c.ok));
      expect(failed && passed, JSON.stringify(attempts.map((a) => a.meta?.checks))).toBeTruthy();
      expect(runsIn(join(dir, 'failed-run.html'))).toEqual([failed!.runId, goldenId(join(dir, 'goldens', 'flaky'))]);
    } finally {
      flaky = false;
    }
  }, 120_000);
});
