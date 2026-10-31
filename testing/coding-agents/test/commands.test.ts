// The skills and the section docs/agents.md gives to paste tell a coding agent which shadowlap
// commands to run, word for word, which JSON fields to read in what comes back, and which checks to
// write. Nothing generates them from the CLI, so they drift: a flag renamed, a field moved, a command
// that now wants another argument, a checks syntax that changed. This test runs every command any of
// them names the way a coding agent would, against the reference agent and its scripted fake of the
// Anthropic API, in each case the instructions describe (a search that finds nothing, a blame no
// answer rescues and one an answer does, a fix still open; an agent's source for init, a git history
// for bisect). Then it holds each point of the text to what came back: every field and value a point
// names is in the JSON of the commands that point names, and every checks example parses as the CLI
// parses --expect. CI runs it in a job of its own as well (.github/workflows/coding-agents.yml).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { parseExpect } from '../../../packages/cli/src/checks.js';
import { TURNS, referenceScript } from '../../reference-agent/src/scenario.js';
import { ROOT, blocksOf, commandsIn, instructions, spansIn, words } from './instructions.js';

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
/** The project's first commit, where its golden passes. */
let firstCommit: string;
let files = 0;

const VERSION = (JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }).version;

/** The project's source as `init` reads it: an AI SDK agent with a tool that only reads and one that writes, neither wrapped. */
const AGENT_SOURCE = `import { generateText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const tools = {
  search_web: tool({ description: 'Search the web', inputSchema: {}, execute: async ({ query }) => search(query) }),
  send_email: tool({ description: 'Email the summary', inputSchema: {}, execute: async (email) => mailer.send(email) }),
};

await generateText({ model: anthropic('claude-sonnet-4-5'), tools, prompt: process.argv[2] });
`;

/** The fix the blame above opened, as `fix ls` lists it. */
async function openFix(): Promise<string> {
  const listed = json<{ fixes: Array<{ fixId: string; status: string }> }>((await shadowlap(['fix', 'ls', '--json'])).stdout, 'fix ls --json');
  const fix = listed.fixes.find((f) => f.status === 'open');
  if (!fix) throw new Error('no open fix: the blame that opens one runs before this command');
  return fix.fixId;
}

/** The scripted model's turn that emails the summary. */
const EMAIL_TURN = TURNS.findIndex((t) => t.content.some((b) => b.type === 'tool_use' && b.name === 'send_email'));
/**
 * How the fake model answers a call made live: as the reference agent's script does, or, asked the
 * email turn again (a blame's probe), with the summary and no email, so a run that must send none is
 * rescued there.
 */
type Answers = 'scripted' | 'no-email';
let answers: Answers = 'scripted';
function script(ctx: ScriptContext) {
  if (answers === 'no-email' && ctx.assistantTurns === EMAIL_TURN) return { message: message([text('The summary is ready; nothing was sent.')], { stop_reason: 'end_turn' }) };
  return referenceScript(ctx);
}

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
  const path = join(project, r.argv[at + 1]);
  expect(existsSync(path), `${flag} ${r.argv[at + 1]} was not written`).toBe(true);
  return json<T>(readFileSync(path, 'utf8'), `${flag} ${r.argv[at + 1]}`);
};
const has = (r: Ran, flag: string) => r.argv.includes(flag);

/** What each command gave back, every time it ran: its JSON on stdout, and the JSON files it wrote. */
const gave = new Map<string, unknown[]>();
function keep(name: string, r: Ran): void {
  const out = gave.get(name) ?? [];
  try {
    out.push(JSON.parse(r.stdout));
  } catch {
    // not JSON: a command that prints for people, or the agent's own output
  }
  for (const flag of ['--summary-json', '--json']) {
    const file = r.argv[r.argv.indexOf(flag) + 1];
    if (has(r, flag) && file && !file.startsWith('-') && existsSync(join(project, file))) out.push(JSON.parse(readFileSync(join(project, file), 'utf8')));
  }
  gave.set(name, out);
}

interface Variant {
  /** The case this run of the command is, for the test's name. */
  as?: string;
  /** What each placeholder stands for in this command, worked out when it runs. */
  fill?: () => Record<string, string> | Promise<Record<string, string>>;
  /** The exit statuses the instructions and the CLI reference give it. */
  exits?: number[];
  env?: NodeJS.ProcessEnv;
  /** How the fake model answers what is asked live while it runs. */
  answers?: Answers;
  /** That what the instructions say comes back is there. */
  check?: (r: Ran) => void | Promise<void>;
}

/**
 * How each command is run here, by its name: in each case the instructions describe, what its
 * placeholders stand for in this project and what comes back. A command the instructions name that
 * isn't here fails the test, so a new one gets its cases.
 */
const SCENARIOS: Record<string, Variant[]> = {
  run: [{ check: (r) => expect(r.stderr).toMatch(/Recorded [0-9A-Z]{26}: 30 calls/) }],
  ls: [
    {
      check: (r) => {
        const runs = json<Array<{ runId: string }>>(r.stdout, 'ls --json');
        if (has(r, '--label')) expect(runs.map((x) => x.runId)).toEqual([crashed]);
        else expect(runs.map((x) => x.runId)).toEqual(expect.arrayContaining([good, crashed]));
      },
    },
  ],
  show: [
    {
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
  ],
  search: [
    {
      as: 'words a run holds',
      fill: () => ({ '<words>': 'replay' }),
      check: (r) => {
        const hits = json<Array<{ runId: string; callNo: number; field: string }>>(r.stdout, 'search --json');
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0]).toMatchObject({ runId: expect.any(String), callNo: expect.any(Number), field: expect.any(String) });
      },
    },
    // "It exits 1 when nothing matches."
    { as: 'words no run holds', fill: () => ({ '<words>': 'quokka' }), exits: [1], check: (r) => expect(json(r.stdout, 'search --json')).toEqual([]) },
  ],
  'fix ls': [{ check: (r) => expect(json(r.stdout, 'fix ls --json')).toMatchObject({ fixes: expect.any(Array), counts: expect.any(Object) }) }],
  replay: [
    {
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
  ],
  calibrate: [{ check: (r) => expect(json(r.stdout, 'calibrate --json')).toMatchObject({ clean: true, normalizers: [] }) }],
  decisions: [
    {
      // The working tree sends the prompt and tools the golden recorded: each step is left as it was, ranked by nothing.
      check: (r) => {
        const report = json<{ kind: string; runs: Array<{ golden: string | null; rank: number | null; decisions: Array<{ rank: number | null }> }> }>(r.stdout, 'decisions --json');
        expect(report.kind).toBe('decisions');
        expect(report.runs.map((x) => [x.golden, x.rank])).toEqual([['goldens/research', null]]);
        expect(report.runs[0].decisions.length).toBeGreaterThan(0);
      },
    },
  ],
  blame: [
    {
      // The recording emails a summary, and the script answers every call as recorded: no answer saves it.
      as: 'a run no answer rescues',
      fill: () => ({ '<checks>': '{"tools":{"send_email":0}}' }),
      check: (r) => expect(json(r.stdout, 'blame --json')).toMatchObject({ outcome: 'unrescuable', contrast: null }),
    },
    {
      // Asked the email turn again, the model answers without the email: the run is rescued there.
      as: 'a run an answer rescues',
      answers: 'no-email',
      fill: () => ({ '<checks>': '{"tools":{"send_email":0}}' }),
      check: async (r) => {
        const report = json<{ outcome: string; blamed: { callNo: number } | null; contrast: { callNo: number; recorded: unknown; rescued: unknown; rescuedRunId: string } | null }>(r.stdout, 'blame --json');
        expect(report.outcome).toBe('blamed');
        expect(report.contrast?.callNo).toBe(report.blamed?.callNo);
        expect(JSON.stringify(report.contrast?.recorded)).toContain('send_email');
        expect(JSON.stringify(report.contrast?.rescued)).not.toContain('send_email');
        // "that fork's run id": a fork of the blamed run, which show opens.
        const fork = await shadowlap(['show', report.contrast!.rescuedRunId, '--json']);
        expect(fork.code, fork.stderr).toBe(0);
        expect(json<{ run: { parentRunId: string } }>(fork.stdout, 'show --json').run.parentRunId).toBe(good);
      },
    },
  ],
  verify: [
    {
      // The fix to the crash is in the code here: without AGENT_FAIL_AFTER_CALL the agent goes on to email its summary.
      fill: () => ({ '<runs>': crashed, '<checks>': '{"tools":{"send_email":1}}' }),
      check: (r) => {
        if (has(r, '--json')) expect(json(r.stdout, 'verify --json')).toMatchObject({ verdict: 'accepted' });
      },
    },
  ],
  label: [{}],
  test: [
    {
      check: (r) => {
        if (has(r, '--json')) expect(written<{ results: Array<{ ok: boolean }> }>(r, '--json').results.map((x) => x.ok)).toEqual([true]);
        else expect(r.stdout).toMatch(/1 passed, 0 failed/);
      },
    },
  ],
  diff: [
    // "It exits 1 when they differ."
    { as: 'two runs that differ', exits: [1], check: (r) => expect(json<{ firstRequestDifference: unknown }>(r.stdout, 'diff --json').firstRequestDifference).not.toBeNull() },
    { as: 'a run and itself', fill: () => ({ '<b>': good }), check: (r) => expect(json<{ firstRequestDifference: unknown }>(r.stdout, 'diff --json').firstRequestDifference).toBeNull() },
  ],
  init: [
    {
      check: (r) => {
        const found = json<{ command: { argv: string[] } | null; tools: Array<{ name: string; effect: string | null; suggested: string; wrapped: boolean }>; unwrapped: string[]; wrap: Array<{ code: string }> }>(r.stdout, 'init --json');
        expect(found.command?.argv).toEqual(['npm', 'run', 'agent']);
        expect(found.tools.map((t) => [t.name, t.effect, t.suggested, t.wrapped])).toEqual([
          ['search_web', null, 'read', false],
          ['send_email', null, 'write', false],
        ]);
        expect(found.unwrapped).toEqual(['search_web', 'send_email']);
        expect(found.wrap.map((w) => w.code).join('\n')).toMatch(/search_web: 'read', send_email: 'write'/);
      },
    },
  ],
  doctor: [{ check: (r) => expect(json<Array<{ name: string; verdict: string }>>(r.stdout, 'doctor --json').map((c) => c.name)).toContain('store') }],
  pack: [
    {
      fill: () => ({ '<name>': 'kept' }),
      check: () => {
        const dir = join(project, 'goldens', 'kept');
        expect(existsSync(join(dir, 'run.json'))).toBe(true);
        expect(existsSync(join(dir, '.gitattributes'))).toBe(true);
        // The commands that replay goldens/* replay the one golden made before them.
        rmSync(dir, { recursive: true, force: true });
      },
    },
  ],
  bisect: [
    {
      // The golden passes at every commit, since nothing the agent runs is in the project's history.
      fill: () => ({ '<golden>': 'goldens/research', '<rev>': firstCommit }),
      exits: [1],
      check: (r) => expect(json(r.stdout, 'bisect --json')).toMatchObject({ outcome: 'passes-at-bad', first: null }),
    },
  ],
  'fix show': [{ fill: async () => ({ '<fix>': await openFix() }), check: (r) => expect(json(r.stdout, 'fix show --json')).toMatchObject({ status: 'open', actions: expect.anything() }) }],
  'fix apply': [
    {
      // "It exits 2 while the fix is still open."
      as: 'a fix still open',
      fill: async () => ({ '<fix>': await openFix() }),
      exits: [2],
      check: (r) => expect(json(r.stdout, 'fix apply --json')).toBeTruthy(),
    },
  ],
  migrate: [{ fill: () => ({ '<model>': 'claude-haiku-4-5' }), check: (r) => expect(json(r.stdout, 'migrate --json')).toMatchObject({ kind: 'migrate', to: 'claude-haiku-4-5' }) }],
  '--version': [{ check: (r) => expect(r.stdout.trim()).toBe(VERSION) }],
};

/** The command's name, as SCENARIOS knows it: the words after `shadowlap` up to the first that isn't one. */
function nameOf(argv: string[]): string {
  const two = argv.slice(0, 2).join(' ');
  return two in SCENARIOS ? two : argv[0];
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
      return fill[p];
    });
    out.push(filled);
  }
  return out;
}

/**
 * What a code span in the instructions is: a command line, a command named on its own (`show`), a
 * checks example, a field or value the reader is told to look for, or something else (a flag, a
 * placeholder, a file or folder).
 */
type Span = { kind: 'command'; name: string } | { kind: 'checks'; text: string } | { kind: 'named'; word: string } | { kind: 'other' };
function spanOf(span: string): Span {
  if (/^shadowlap\s/.test(span)) return { kind: 'command', name: nameOf(words(span).slice(1)) };
  if (span in SCENARIOS) return { kind: 'command', name: span };
  if (/^[{[]/.test(span)) return { kind: 'checks', text: span };
  if (/^-|^<[^>]+>$|[/\s]|^\.|\.(?:json|jsonl|md|mdc|db)$/.test(span)) return { kind: 'other' };
  return { kind: 'named', word: span };
}

/** Whether some JSON holds a field by that name (or dotted path), or that value, anywhere in it. */
function holds(value: unknown, word: string): boolean {
  const path = word.split('.');
  const at = (v: unknown, keys: string[]): boolean => {
    if (!keys.length) return true;
    return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, keys[0]) && at((v as Record<string, unknown>)[keys[0]], keys.slice(1));
  };
  const walk = (v: unknown): boolean => {
    if (at(v, path)) return true;
    if (path.length === 1 && (v === null ? word === 'null' : typeof v !== 'object' && String(v) === word)) return true;
    if (Array.isArray(v)) return v.some(walk);
    return v !== null && typeof v === 'object' && Object.values(v).some(walk);
  };
  return walk(value);
}

const found = new Map<string, string[]>();
for (const { where, text } of instructions()) for (const line of commandsIn(text)) found.set(line, [...(found.get(line) ?? []), where]);

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
  project = mkdtempSync(join(tmpdir(), 'sl-coding-agents-'));
  mkdirSync(join(project, 'out'));
  const record = async (env: NodeJS.ProcessEnv = {}) => {
    await shadowlap(['run', '--', process.execPath, AGENT], env);
    const runs = json<Array<{ runId: string }>>((await shadowlap(['ls', '--json'])).stdout, 'ls --json');
    return runs[0].runId;
  };
  good = await record();
  crashed = await record({ AGENT_FAIL_AFTER_CALL: '5' });
  for (const [run, label] of [[good, 'good'], [crashed, 'bug']] as const) expect((await shadowlap(['label', run, label])).code).toBe(0);
  expect((await shadowlap(['pack', good, join('goldens', 'research')])).code).toBe(0);

  // The agent's own source, for init, in a git history of two commits, for bisect.
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'research-agent', private: true, type: 'module', scripts: { agent: 'node agent.mjs' }, dependencies: { ai: '^5.0.0', '@ai-sdk/anthropic': '^2.0.0' } }, null, 2) + '\n');
  writeFileSync(join(project, 'agent.mjs'), AGENT_SOURCE);
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\n.home/\nout/\n');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Shadowlap', '-c', 'user.email=ci@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'The research agent');
  firstCommit = git('rev-parse', 'HEAD');
  writeFileSync(join(project, 'NOTES.md'), 'What the agent is for.\n');
  git('add', '-A');
  git('commit', '-qm', 'Say what the agent is for');
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
    const name = nameOf(words(line).slice(1));
    for (const variant of SCENARIOS[name] ?? [{}]) {
      it(`${line}${variant.as ? `, for ${variant.as}` : ''}  (${where.join('; ')})`, async () => {
        if (!SCENARIOS[name]) throw new Error(`no scenario for "shadowlap ${name}": add one to SCENARIOS, with what the instructions say it gives back`);
        const fill = { '<run>': good, '<call>': '9', '<a>': good, '<b>': crashed, ...(await variant.fill?.()) };
        // A fresh file wherever the command writes one.
        const argv = argvOf(line, { ...fill, '<file>': join('out', `${++files}.json`) });
        answers = variant.answers ?? 'scripted';
        let r: Ran;
        try {
          r = await shadowlap(argv, variant.env);
        } finally {
          answers = 'scripted';
        }
        // Commander's own refusals: a flag or a command the CLI doesn't have, an argument it wants.
        expect(r.stderr, `shadowlap ${argv.join(' ')}`).not.toMatch(/^error: (unknown|missing|too many|option)/m);
        expect(variant.exits ?? [0], `shadowlap ${argv.join(' ')} exited ${r.code}\n${r.stderr.slice(-3000)}`).toContain(r.code);
        keep(name, r);
        await variant.check?.(r);
      }, SLOW);
    }
  }
});

describe('what the instructions say to read and to write', () => {
  const points = instructions().map(({ where, text }) => ({ where, points: blocksOf(text).map((b) => ({ text: b, spans: spansIn(b).map(spanOf) })) }));

  it('names fields and values that are in the JSON of the commands each point names', () => {
    // What came back is what the commands above gave: this holds only when they ran first.
    expect(gave.size, 'the commands above ran in this file before this check: run the file whole, not filtered to this test').toBeGreaterThan(0);
    const problems: string[] = [];
    for (const { where, points: list } of points) {
      for (const point of list) {
        const commands = [...new Set(point.spans.flatMap((s) => (s.kind === 'command' ? [s.name] : [])))];
        for (const s of point.spans) {
          if (s.kind !== 'named') continue;
          if (!commands.length) problems.push(`${where}: \`${s.word}\` is named where no command is: ${point.text.slice(0, 100)}`);
          else if (!commands.flatMap((c) => gave.get(c) ?? []).some((out) => holds(out, s.word))) problems.push(`${where}: \`${s.word}\` is neither a field nor a value in what ${commands.map((c) => `shadowlap ${c}`).join(' or ')} gave back`);
        }
      }
    }
    expect(problems).toEqual([]);
    // A guard against the extraction itself breaking: each tells the reader to look at the replay's divergence.
    for (const { where, points: list } of points) expect(list.flatMap((p) => p.spans).some((s) => s.kind === 'named' && s.word === 'summary.divergence'), where).toBe(true);
  });

  it('says a write runs again after a fork only when the replay allows writes', () => {
    // Under `--writes allow` a write after the fork runs live: a point that says one never runs again names that.
    for (const { where, points: list } of points) for (const point of list) if (/never runs? again/.test(point.text)) expect(point.text, where).toContain('`--writes allow`');
    const setup = points.find((p) => p.where.endsWith('setup-agent/SKILL.md'))!;
    expect(setup.points.some((p) => p.text.includes('a write never runs again after a fork unless the replay allows writes (`--writes allow`)'))).toBe(true);
  });

  it('gives checks the CLI takes, as --expect parses them', () => {
    let examples = 0;
    for (const { where, points: list } of points) {
      for (const s of list.flatMap((p) => p.spans)) {
        if (s.kind !== 'checks') continue;
        examples++;
        const parsed = json(s.text, `${where}: the checks ${s.text}`);
        expect(() => parseExpect(parsed, `${where}: ${s.text}`)).not.toThrow();
      }
    }
    expect(examples).toBeGreaterThanOrEqual(3);
  });
});
