import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_LIMITS, defaultGolden, goldenPath, parseAgentCommand, planRecording, quoteArgs, setupCommands, setupJobArgs } from '../src/index.js';

const argv = (line: string) => {
  const r = parseAgentCommand(line);
  return r.ok ? r.argv : r.error;
};

describe('parseAgentCommand', () => {
  it('splits a command into arguments, honouring quotes', () => {
    expect(argv('node triage.mjs')).toEqual(['node', 'triage.mjs']);
    expect(argv('  uv run research-agent "Summarize Northwind’s Q3 10-Q"  ')).toEqual(['uv', 'run', 'research-agent', 'Summarize Northwind’s Q3 10-Q']);
    expect(argv(`python agent.py --task 'refund "A-2030"' --limit=3`)).toEqual(['python', 'agent.py', '--task', 'refund "A-2030"', '--limit=3']);
    expect(argv('node agent.mjs ""')).toEqual(['node', 'agent.mjs', '']);
    expect(argv('node\tagent.mjs')).toEqual(['node', 'agent.mjs']);
    // Backslashes stay as typed: a Windows path survives.
    expect(argv('python C:\\agents\\refund.py')).toEqual(['python', 'C:\\agents\\refund.py']);
    // Shell syntax inside quotes is text.
    expect(argv(`node agent.mjs --prompt "a | b && c > d; $HOME * ? {a,b} [x]"`)).toEqual(['node', 'agent.mjs', '--prompt', 'a | b && c > d; $HOME * ? {a,b} [x]']);
    // Braces without a list or a range are text to a shell too.
    expect(argv('node agent.mjs {} {x}')).toEqual(['node', 'agent.mjs', '{}', '{x}']);
  });

  it('drops a pasted shadowlap run --, and refuses a shadowlap command', () => {
    expect(argv('shadowlap run -- node triage.mjs')).toEqual(['node', 'triage.mjs']);
    expect(argv('npx shadowlap run -- pnpm start')).toEqual(['pnpm', 'start']);
    expect(argv('shadowlap replay 01K5CQ')).toBe('Give the command that starts your agent: Shadowlap runs it with shadowlap run.');
    expect(argv('shadowlap run --')).toBe('Give the command that starts your agent.');
  });

  it('refuses what only a shell would understand, saying why', () => {
    const refused: Array<[string, RegExp]> = [
      ['node a.mjs | tee log', /a pipe/],
      ['npm run build && node a.mjs', /chained commands/],
      ['node a.mjs; rm -rf x', /chained commands/],
      ['node a.mjs &', /chained commands/],
      ['node a.mjs > out.txt', /a redirection/],
      ['node a.mjs $(cat args)', /a substitution/],
      ['node `which agent`', /a substitution/],
      ['node a.mjs ${X}', /a substitution/],
      ['node a.mjs $TASK', /a variable/],
      ['python *.py', /a wildcard/],
      ['python agent.py data/[ab].json', /a wildcard/],
      ['node run.js --in=data/{a,b}.json', /a brace expansion/],
      ['node run.js {1..3}', /a brace expansion/],
      ['(cd x && node a.mjs)', /a subshell|chained/],
      ['node a.mjs # a comment', /a comment/],
      ['python ~/agent.py', /~ would not mean your home folder/],
      ['OPENAI_BASE_URL=http://x node a.mjs', /NAME=value/],
      ['node a.mjs\nrm -rf /', /line break/],
      ['node "a.mjs', /double quote is never closed/],
      ["node 'a.mjs", /single quote is never closed/],
      ['', /Give the command/],
      ['   ', /Give the command/],
    ];
    for (const [line, why] of refused) expect(argv(line), line).toMatch(why);
    expect(argv(`node ${'x'.repeat(COMMAND_LIMITS.chars)}`)).toMatch(/longer than/);
    expect(argv(`node ${Array.from({ length: COMMAND_LIMITS.args + 1 }, (_, i) => `a${i}`).join(' ')}`)).toMatch(/more than 200 arguments/);
  });
});

describe('planRecording', () => {
  const project = { path: '/home/dana/triage-bot', confirmed: [{ argv: ['node', 'triage.mjs'] }] };

  it('asks first for a command not run in the folder before, and builds the job’s arguments without a shell', () => {
    const r = planRecording(project, 'node triage.mjs --label "billing & bugs"', { home: '/home/dana' });
    expect(r).toEqual({
      ok: true,
      plan: {
        args: ['run', '--', 'node', 'triage.mjs', '--label', 'billing & bugs'],
        argv: ['node', 'triage.mjs', '--label', 'billing & bugs'],
        cwd: '/home/dana/triage-bot',
        display: "shadowlap run -- node triage.mjs --label 'billing & bugs'",
        confirm: {
          title: 'Run this command in ~/triage-bot?',
          text: 'The first command in a folder asks first. Shadowlap starts a local sidecar, runs it once, and records every model and tool call. Model calls go to the real API with your keys, which are never stored.',
          command: "shadowlap run -- node triage.mjs --label 'billing & bugs'",
          button: 'Run and record',
        },
      },
    });
  });

  it('runs a confirmed command again without asking', () => {
    const r = planRecording(project, 'node   triage.mjs');
    expect(r.ok && r.plan.confirm).toBeNull();
    expect(r.ok && r.plan.args).toEqual(['run', '--', 'node', 'triage.mjs']);
  });

  it('passes a refusal on', () => {
    expect(planRecording(project, 'node triage.mjs | tee x')).toEqual({ ok: false, error: expect.stringMatching(/a pipe/) });
  });
});

describe('goldenPath', () => {
  it('keeps the golden inside the project, under goldens/ for a bare name', () => {
    expect(goldenPath('goldens/northwind-q3')).toEqual({ ok: true, path: 'goldens/northwind-q3' });
    expect(goldenPath('northwind-q3')).toEqual({ ok: true, path: 'goldens/northwind-q3' });
    expect(goldenPath('./goldens/x/')).toEqual({ ok: true, path: 'goldens/x' });
    expect(goldenPath('tests\\packs\\x')).toEqual({ ok: true, path: 'tests/packs/x' });
    for (const bad of ['', '../outside', 'goldens/../../x', '/etc/x', 'C:/x', '~/x', 'goldens/.hidden', 'goldens/a b', 'goldens//x', 'a/b/c/d/e/f/g/h/i']) {
      expect(goldenPath(bad).ok, bad).toBe(false);
    }
  });

  it('won’t pack through a link out of the project', () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'sl-golden-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sl-golden-out-')));
    try {
      expect(goldenPath('goldens/first-run', { folder })).toEqual({ ok: true, path: 'goldens/first-run' });
      mkdirSync(join(folder, 'goldens'));
      symlinkSync(outside, join(folder, 'goldens', 'linked'));
      expect(goldenPath('goldens/linked/x', { folder })).toEqual({ ok: false, error: 'goldens/linked leads out of the project, so Shadowlap won’t pack there.' });
      // A link that stays inside the project is fine.
      mkdirSync(join(folder, 'packs'));
      symlinkSync(join(folder, 'packs'), join(folder, 'goldens', 'inside'));
      expect(goldenPath('goldens/inside/x', { folder })).toEqual({ ok: true, path: 'goldens/inside/x' });
      expect(goldenPath('goldens/x', { folder: join(folder, 'gone') })).toMatchObject({ ok: false });
      // A link to nowhere could point anywhere by the time pack runs.
      symlinkSync(join(outside, 'not-yet'), join(folder, 'goldens', 'dangling'));
      expect(goldenPath('goldens/dangling', { folder })).toEqual({ ok: false, error: 'goldens/dangling is a link to nowhere, so Shadowlap won’t pack there.' });
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('offers goldens/<project> first', () => {
    expect(defaultGolden('triage-bot')).toBe('goldens/triage-bot');
    expect(defaultGolden('Mon Agent')).toBe('goldens/mon-agent');
    expect(defaultGolden('---')).toBe('goldens/first-run');
  });
});

describe('setup commands', () => {
  it('shows each step as the command a terminal would take', () => {
    expect(setupCommands({ argv: ['uv', 'run', 'agent.py', 'Q3 10-Q'], runId: '01K5CQ3W6H0000000000000000', golden: 'goldens/northwind-q3' })).toEqual({
      inspect: ['shadowlap init'],
      record: ["shadowlap run -- uv run agent.py 'Q3 10-Q'"],
      calibrate: ['shadowlap calibrate 01K5CQ3W6H --write'],
      test: ['shadowlap pack 01K5CQ3W6H goldens/northwind-q3', 'shadowlap test goldens/northwind-q3'],
    });
    expect(setupCommands({ argv: null, runId: null, golden: 'goldens/x' }).record).toEqual(['shadowlap run -- <the command that starts your agent>']);
    expect(setupCommands({ argv: null, runId: null, golden: 'goldens/x' }).calibrate).toEqual(['shadowlap calibrate <run> --write']);
  });

  it('gives the jobs their arguments', () => {
    expect(setupJobArgs.inspect()).toEqual(['init', '--json']);
    expect(setupJobArgs.calibrate('R1')).toEqual(['calibrate', 'R1']);
    expect(setupJobArgs.calibrate('R1', true)).toEqual(['calibrate', 'R1', '--write']);
    expect(setupJobArgs.pack('R1', 'goldens/x')).toEqual(['pack', 'R1', 'goldens/x']);
    expect(setupJobArgs.test('goldens/x')).toEqual(['test', 'goldens/x']);
  });

  it('quotes arguments as a terminal would take them back', () => {
    expect(quoteArgs(['node', 'a b', "it's", 'x=1'])).toBe("node 'a b' 'it'\\''s' x=1");
  });
});
