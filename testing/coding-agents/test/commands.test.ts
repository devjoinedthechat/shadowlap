// The skill, the Cursor rule and the section docs/agents.md gives to paste tell a coding agent which
// shadowlap commands to run, word for word, and which JSON fields to read in what comes back.
// Nothing generates them from the CLI, so they drift: a flag renamed, a field moved, a command that
// now wants another argument. This test runs every command any of them names the way a coding agent
// would, against the reference agent and its scripted fake of the Anthropic API, and checks that
// what the instructions say to read is there. CI runs it in a job of its own as well
// (.github/workflows/coding-agents.yml).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '../../reference-agent/src/scenario.js';
import { ROOT, commandsIn, instructions, words } from './instructions.js';

const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const AGENT = join(ROOT, 'testing', 'reference-agent', 'dist', 'main.js');
const SLOW = 180_000;

interface Ran {
  argv: string[];
  code: number | null;
  stdout: string;
  stderr: string;
}

let mock: MockServer;
let project: string;
/** The reference agent's run as recorded: it researches, then emails a summary. */
let good: string;
/** The same agent crashing after its fifth model call: the run a fix must make pass. */
let crashed: string;
let files = 0;

function shadowlap(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      cwd: project,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(project, '.home'), NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ argv, code, stdout, stderr }));
  });
}

const json = <T = Record<string, unknown>>(text: string, what: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what} is not JSON:\n${text.slice(0, 2000)}`);
  }
};
/** The file a command wrote, named after `flag` in its arguments, as JSON. */
const written = <T = Record<string, unknown>>(r: Ran, flag: string): T => {
  const at = r.argv.indexOf(flag);
  const path = join(project, r.argv[at + 1]!);
  expect(existsSync(path), `${flag} ${r.argv[at + 1]} was not written`).toBe(true);
  return json<T>(readFileSync(path, 'utf8'), `${flag} ${r.argv[at + 1]}`);
};
const has = (r: Ran, flag: string) => r.argv.includes(flag);

interface Scenario {
  /** What each placeholder stands for in this command. */
  fill?: () => Record<string, string>;
  /** The exit statuses the instructions and the CLI reference give it. */
  exits?: number[];
  env?: NodeJS.ProcessEnv;
  /** That what the instructions say to read is there. */
  check?: (r: Ran) => void;
}

/**
 * How each command is run here, by its name: what its placeholders stand for in this project, and
 * what the instructions say comes back. A command the instructions name that isn't here fails the
 * test, so a new one gets its check.
 */
const SCENARIOS: Record<string, Scenario> = {
  run: {
    check: (r) => expect(r.stderr).toMatch(/Recorded [0-9A-Z]{26}: 30 calls/),
  },
  ls: {
    check: (r) => {
      const runs = json<Array<{ runId: string; status: string; labels: string[]; forkedAt: unknown }>>(r.stdout, 'ls --json');
      for (const run of runs) for (const key of ['status', 'labels', 'forkedAt']) expect(run, key).toHaveProperty(key);
      if (has(r, '--label')) expect(runs.map((x) => x.runId)).toEqual([crashed]);
      else expect(runs.map((x) => x.runId)).toEqual(expect.arrayContaining([good, crashed]));
    },
  },
  show: {
    check: (r) => {
      if (has(r, '--json')) {
        const shown = json<{ run: { runId: string }; summary: unknown; calls: unknown[] }>(r.stdout, 'show --json');
        expect(shown.run.runId).toBe(good);
        expect(shown.summary).toBeTruthy();
        expect(shown.calls).toHaveLength(30);
      } else if (has(r, '--request')) {
        // Call 9 is a model call: its request as sent, the whole conversation so far.
        expect(json<{ messages: unknown[] }>(r.stdout, 'show --request').messages.length).toBeGreaterThan(1);
      } else {
        expect(r.stdout).toContain('event: message_start');
      }
    },
  },
  search: {
    fill: () => ({ '<words>': 'replay' }),
    check: (r) => {
      const hits = json<Array<{ runId: string; callNo: number; field: string }>>(r.stdout, 'search --json');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]).toMatchObject({ runId: expect.any(String), callNo: expect.any(Number), field: expect.any(String) });
    },
  },
  'fix ls': {
    check: (r) => expect(json(r.stdout, 'fix ls --json')).toMatchObject({ fixes: expect.any(Array), counts: expect.any(Object) }),
  },
  replay: {
    fill: () => ({ '<tool>': 'search_web' }),
    check: (r) => {
      if (has(r, '--repeat')) {
        const out = written<{ attempts: unknown[]; report: { paths: unknown[] } }>(r, '--summary-json');
        expect(out.attempts).toHaveLength(Number(r.argv[r.argv.indexOf('--repeat') + 1]));
        expect(out.report.paths.length).toBeGreaterThan(0);
        return;
      }
      const divergence = written<{ summary: { divergence: { callNo: number; name: string } | null } }>(r, '--summary-json').summary.divergence;
      if (has(r, '--prompt-from')) expect(divergence).toMatchObject({ callNo: 9 });
      else if (has(r, '--live-tool')) expect(divergence).toMatchObject({ name: 'search_web' });
      // Nothing changed: every request matched.
      else expect(divergence).toBeNull();
    },
  },
  calibrate: {
    check: (r) => expect(json(r.stdout, 'calibrate --json')).toMatchObject({ clean: true, normalizers: [] }),
  },
  blame: {
    // The recording emails a summary; this asks for a run that never does, which no model answer gives.
    fill: () => ({ '<checks>': '{"tools":{"send_email":0}}' }),
    check: (r) => {
      const report = json<Record<string, unknown>>(r.stdout, 'blame --json');
      expect(report.outcome).toBe('unrescuable');
      for (const key of ['blamed', 'contrast']) expect(report).toHaveProperty(key);
    },
  },
  verify: {
    // The fix to the crash is in the code here: without AGENT_FAIL_AFTER_CALL the agent goes on to email its summary.
    fill: () => ({ '<runs>': crashed, '<checks>': '{"tools":{"send_email":1}}' }),
    check: (r) => {
      if (has(r, '--json')) expect(json(r.stdout, 'verify --json')).toMatchObject({ verdict: 'accepted' });
    },
  },
  label: {},
  test: {
    check: (r) => {
      if (has(r, '--json')) expect(written<{ results: Array<{ ok: boolean }> }>(r, '--json').results.map((x) => x.ok)).toEqual([true]);
      else expect(r.stdout).toMatch(/1 passed, 0 failed/);
    },
  },
  diff: {
    // Two runs that differ: exit status 1, as for `diff`.
    exits: [1],
    check: (r) => expect(json(r.stdout, 'diff --json')).toHaveProperty('firstRequestDifference'),
  },
};

/** The command's name, as SCENARIOS knows it: the words after `shadowlap` up to the first that isn't one. */
function nameOf(argv: string[]): string {
  const two = argv.slice(0, 2).join(' ');
  return two in SCENARIOS ? two : argv[0]!;
}

/** A command line from the instructions, as argv here: each placeholder filled in, `<command>` the agent's. */
function argvOf(line: string, fill: Record<string, string>): string[] {
  const out: string[] = [];
  for (const word of words(line).slice(1)) {
    if (word === '<command>') {
      out.push(process.execPath, AGENT);
      continue;
    }
    const filled = word.replace(/<[a-z ]+>/g, (p) => {
      if (!(p in fill)) throw new Error(`no value for ${p} in: ${line}`);
      return fill[p]!;
    });
    out.push(filled);
  }
  return out;
}

const found = new Map<string, string[]>();
for (const { where, text } of instructions()) for (const line of commandsIn(text)) found.set(line, [...(found.get(line) ?? []), where]);

beforeAll(async () => {
  mock = await startMockAnthropic({ script: referenceScript, eventDelayMs: () => 0 });
  project = mkdtempSync(join(tmpdir(), 'sl-coding-agents-'));
  mkdirSync(join(project, 'out'));
  const record = async (env: NodeJS.ProcessEnv = {}) => {
    await shadowlap(['run', '--', process.execPath, AGENT], env);
    const runs = json<Array<{ runId: string }>>((await shadowlap(['ls', '--json'])).stdout, 'ls --json');
    return runs[0]!.runId;
  };
  good = await record();
  crashed = await record({ AGENT_FAIL_AFTER_CALL: '5' });
  for (const [run, label] of [[good, 'good'], [crashed, 'bug']] as const) expect((await shadowlap(['label', run, label])).code).toBe(0);
  expect((await shadowlap(['pack', good, join('goldens', 'research')])).code).toBe(0);
}, SLOW);

afterAll(async () => {
  await mock?.close();
  if (project) rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('the commands the coding agents’ instructions name', () => {
  it('are found in each of them', () => {
    // A guard against the extraction itself breaking and passing everything.
    expect(found.size).toBeGreaterThan(15);
    for (const { where, text } of instructions()) expect(commandsIn(text).length, where).toBeGreaterThan(5);
  });

  for (const [line, where] of found) {
    it(`${line}  (${where.join('; ')})`, async () => {
      const name = nameOf(words(line).slice(1));
      const scenario = SCENARIOS[name];
      if (!scenario) throw new Error(`no scenario for "shadowlap ${name}": add one to SCENARIOS, with what the instructions say it gives back`);
      const fill = { '<run>': good, '<call>': '9', '<a>': good, '<b>': crashed, ...scenario.fill?.() };
      // A fresh file wherever the command writes one.
      const argv = argvOf(line, { ...fill, '<file>': join('out', `${++files}.json`) });
      const r = await shadowlap(argv, scenario.env);
      // Commander's own refusals: a flag or a command the CLI doesn't have, an argument it wants.
      expect(r.stderr, `shadowlap ${argv.join(' ')}`).not.toMatch(/^error: (unknown|missing|too many|option)/m);
      expect(scenario.exits ?? [0], `shadowlap ${argv.join(' ')} exited ${r.code}\n${r.stderr.slice(-3000)}`).toContain(r.code);
      scenario.check?.(r);
    }, SLOW);
  }
});
