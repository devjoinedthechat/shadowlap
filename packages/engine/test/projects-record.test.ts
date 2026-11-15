import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quoteArgv } from '../src/index.js';
import { COMMAND_LIMITS, UPSTREAM_ENV, defaultGolden, freeGoldenPath, goldenPath, modelServerFinding, parseAgentCommand, planRecording, setupCommands, setupJobArgs, upstreamUrl } from '../src/projects/index.js';

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
    // Shell syntax inside quotes is text; single quotes keep a $ as it is, as in a terminal.
    expect(argv(`node agent.mjs --prompt "a | b && c > d; * ? {a,b} [x]"`)).toEqual(['node', 'agent.mjs', '--prompt', 'a | b && c > d; * ? {a,b} [x]']);
    expect(argv("node agent.mjs --prompt '$HOME costs $5 `now`'")).toEqual(['node', 'agent.mjs', '--prompt', '$HOME costs $5 `now`']);
    // A $ that names nothing is text in double quotes too.
    expect(argv('node agent.mjs "costs $ 5" "$"')).toEqual(['node', 'agent.mjs', 'costs $ 5', '$']);
    // A backslash inside single quotes is text, and so is one that ends them.
    expect(argv(`python agent.py 'C:\\agents\\'`)).toEqual(['python', 'agent.py', 'C:\\agents\\']);
    // Braces without a list or a range are text to a shell too.
    expect(argv('node agent.mjs {} {x}')).toEqual(['node', 'agent.mjs', '{}', '{x}']);
  });

  it('reads a backslash as a terminal does, and keeps one in a Windows path', () => {
    // The form quoteArgv writes an apostrophe in, and the ones people type.
    expect(argv(`python agent.py 'What'\\''s the refund policy?'`)).toEqual(['python', 'agent.py', "What's the refund policy?"]);
    expect(argv(`node a.mjs --name=O\\'Brien`)).toEqual(['node', 'a.mjs', "--name=O'Brien"]);
    expect(argv('node a.mjs my\\ file.txt')).toEqual(['node', 'a.mjs', 'my file.txt']);
    expect(argv('node a.mjs \\"x\\"')).toEqual(['node', 'a.mjs', '"x"']);
    expect(argv('node a.mjs "say \\"hi\\""')).toEqual(['node', 'a.mjs', 'say "hi"']);
    // Escaped, shell syntax is text, as in a terminal.
    expect(argv('node a.mjs a\\|b \\$HOME \\~ \\#x costs\\ \\$5 \\{a,b\\}')).toEqual(['node', 'a.mjs', 'a|b', '$HOME', '~', '#x', 'costs $5', '{a,b}']);
    // Inside double quotes a backslash escapes only ", $ and a backquote; before anything else it stays.
    expect(argv('node a.mjs "costs \\$5" "C:\\Program Files\\agent.py" "\\`x\\`"')).toEqual(['node', 'a.mjs', 'costs $5', 'C:\\Program Files\\agent.py', '`x`']);
    // A Windows path keeps its backslashes, whatever language its folders are named in.
    expect(argv('python C:\\Users\\Ünal\\agent.py')).toEqual(['python', 'C:\\Users\\Ünal\\agent.py']);
    // Only a space or a tab separates arguments: a no-break space is text, as in a terminal.
    expect(argv('node a.mjs a\u00a0b')).toEqual(['node', 'a.mjs', 'a\u00a0b']);
    // A # or a ~ inside a word is text.
    expect(argv('node a.mjs issue#42 a~b --path=~/x')).toEqual(['node', 'a.mjs', 'issue#42', 'a~b', '--path=~/x']);
  });

  it('reads back every line quoteArgv writes as the same arguments', () => {
    // Arguments with every character a shell treats specially, and some it doesn't.
    const pool = Array.from("aZ09 _-./:=,+@%'\"\\$`*?;|&<>(){}[]~#!^\té’\u00a0😀");
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const programs = ['node', 'python', 'uv', './agent', 'C:\\agents\\run.exe', 'npm'];
    const cases: string[][] = [
      ['python', 'agent.py', "What's the refund policy?"],
      ['node', 'a.mjs', "--name=O'Brien", '', '$HOME', '*', ';', 'a b', '"quoted"', "it's \"both\""],
      ['node', 'a.mjs', '\\\\server\\share', 'C:\\agents\\', "'", "''", '\\', '~/x', '#1', '{a,b}', '$(date)', '`date`'],
    ];
    for (let n = 0; n < 2000; n++) {
      const args = Array.from({ length: 1 + random(5) }, () => Array.from({ length: random(9) }, () => pool[random(pool.length)]).join(''));
      cases.push([programs[random(programs.length)], ...args]);
    }
    for (const c of cases) {
      const line = quoteArgv(c);
      expect(parseAgentCommand(line), line).toEqual({ ok: true, argv: c });
      // And as the step shows it for a terminal, pasted whole.
      expect(parseAgentCommand(`shadowlap run -- ${line}`), line).toEqual({ ok: true, argv: c });
    }
  });

  it('drops a pasted shadowlap run --, and refuses a shadowlap command', () => {
    expect(argv('shadowlap run -- node triage.mjs')).toEqual(['node', 'triage.mjs']);
    expect(argv('npx shadowlap run -- pnpm start')).toEqual(['pnpm', 'start']);
    expect(argv('shadowlap replay 01K5CQ')).toBe('Give the command that starts your agent: shadowlap runs it with shadowlap run.');
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
      ['node a.mjs $1', /a variable/],
      ['node a.mjs --task "Summarize $COMPANY"', /inside double quotes would not be expanded/],
      ['node a.mjs "$(date)"', /inside double quotes would not be expanded/],
      ['node a.mjs "`date`"', /inside double quotes would not be expanded/],
      ['node a.mjs "costs $5"', /inside double quotes would not be expanded/],
      ['node a.mjs "$-"', /inside double quotes would not be expanded/],
      ['node a.mjs $-', /a variable/],
      // Quoting forms that change the text in bash.
      ["node a.mjs $'\\x41'", /\$'…' and \$"…" would not do what they do/],
      ['node a.mjs $"hi"', /\$'…' and \$"…" would not do what they do/],
      ["node a.mjs a$'b'", /\$'…' and \$"…"/],
      // A terminal would wait for the line's continuation.
      ['node a.mjs \\', /a backslash at the end would carry the command on/],
      ['node a.mjs x\\', /a backslash at the end/],
      // One backslash in a terminal on macOS and Linux, two on Windows.
      ['node a.mjs a\\\\b', /two backslashes in a row/],
      ['node a.mjs \\\\server\\share', /two backslashes in a row/],
      ['node a.mjs "C:\\\\agents"', /two backslashes in a row/],
      ['"" a.mjs', /starts with an empty argument/],
      ["'' a.mjs", /starts with an empty argument/],
      ['node a.mjs name=~/x', /~ would not mean your home folder/],
      ['python *.py', /a wildcard/],
      ['python agent.py data/[ab].json', /a wildcard/],
      ['node run.js --in=data/{a,b}.json', /a brace expansion/],
      ['node run.js {1..3}', /a brace expansion/],
      ['(cd x && node a.mjs)', /a subshell|chained/],
      ['node a.mjs # a comment', /a comment/],
      ['python ~/agent.py', /~ would not mean your home folder/],
      ['OPENAI_BASE_URL=http://x node a.mjs', /NAME=value/],
      // The command a model-server project's step shows for a terminal, pasted whole.
      ['SHADOWLAP_UPSTREAM_OPENAI=http://127.0.0.1:11434 shadowlap run -- node a.mjs', /Leave out SHADOWLAP_UPSTREAM_OPENAI=…: the dashboard records through the model server init finds/],
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
        env: {},
        display: "shadowlap run -- node triage.mjs --label 'billing & bugs'",
        upstream: null,
        confirm: {
          title: 'Record run in ~/triage-bot',
          lead: 'Records one run: every model and tool call.',
          moved: null,
          calls: { value: 'the real API, with your keys', quiet: 'never stored' },
          command: "shadowlap run -- node triage.mjs --label 'billing & bugs'",
          button: 'Record run',
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

  it('records through the model server init found, as init tells a terminal to', () => {
    const modelServer = { url: 'http://127.0.0.1:11434/v1', upstream: 'http://127.0.0.1:11434', from: 'OPENAI_BASE_URL in .env' };
    const confirmedThere = { ...project, confirmed: [...project.confirmed, { argv: ['node', 'triage.mjs'], upstream: 'http://127.0.0.1:11434' }] };
    const r = planRecording(confirmedThere, 'node triage.mjs', { home: '/home/dana', modelServer });
    expect(r.ok && r.plan).toMatchObject({
      args: ['run', '--', 'node', 'triage.mjs'],
      env: { [UPSTREAM_ENV]: 'http://127.0.0.1:11434' },
      display: 'SHADOWLAP_UPSTREAM_OPENAI=http://127.0.0.1:11434 shadowlap run -- node triage.mjs',
      upstream: 'http://127.0.0.1:11434',
      confirm: null,
    });
    // Confirmed while its calls went to the provider's API: through the model server it asks again.
    const moved = planRecording(project, 'node triage.mjs', { home: '/home/dana', modelServer });
    expect(moved.ok && moved.plan.confirm).toMatchObject({ moved: 'It ran here before with its model calls going somewhere else, so it asks again', calls: { value: 'http://127.0.0.1:11434/v1', quiet: 'the model server this project uses' } });
    // And a server other than the one confirmed asks again too.
    expect(planRecording(confirmedThere, 'node triage.mjs', { modelServer: { url: 'http://10.0.0.9:8000/v1', upstream: 'http://10.0.0.9:8000' } })).toMatchObject({ ok: true, plan: { confirm: { title: expect.any(String) } } });
    const first = planRecording(project, 'node triage.mjs --all', { home: '/home/dana', modelServer });
    expect(first.ok && first.plan.confirm).toMatchObject({
      command: 'SHADOWLAP_UPSTREAM_OPENAI=http://127.0.0.1:11434 shadowlap run -- node triage.mjs --all',
      calls: { value: 'http://127.0.0.1:11434/v1', quiet: 'the model server this project uses' },
    });
    const query = planRecording(project, 'node triage.mjs', { modelServer: { url: 'http://llm.internal/v1', upstream: 'http://llm.internal/v1?team=a&x=1' } });
    expect(query.ok && query.plan.display).toBe("SHADOWLAP_UPSTREAM_OPENAI='http://llm.internal/v1?team=a&x=1' shadowlap run -- node triage.mjs");
    expect(query.ok && query.plan.env).toEqual({ SHADOWLAP_UPSTREAM_OPENAI: 'http://llm.internal/v1?team=a&x=1' });
    // Without an address it can forward to, the calls would go to the provider's API instead: refused.
    expect(planRecording(project, 'node triage.mjs', { modelServer: { url: 'https://llm.internal/v1', upstream: null } })).toEqual({ ok: false, error: expect.stringMatching(/can’t record through this project’s model server \(https:\/\/llm.internal\/v1\).*SHADOWLAP_UPSTREAM_OPENAI/) });
  });
});

describe('modelServerFinding', () => {
  it('keeps a model server’s address and upstream, never the credentials in it', () => {
    expect(modelServerFinding({ url: 'http://127.0.0.1:11434/v1', upstream: 'http://127.0.0.1:11434', from: 'agent.py:4' })).toEqual({ url: 'http://127.0.0.1:11434/v1', upstream: 'http://127.0.0.1:11434', from: 'agent.py:4' });
    expect(modelServerFinding({ url: 'https://dana:s3cret@llm.internal/v1', upstream: 'https://dana:s3cret@llm.internal', from: '.env' })).toEqual({ url: 'https://llm.internal/v1', upstream: null, from: '.env' });
    expect(modelServerFinding({ url: 'not a url', upstream: 'x', from: '' })).toBeNull();
    // A key or a token in the query is a credential too; other parameters are not.
    expect(modelServerFinding({ url: 'https://llm.internal/v1?api_key=s3cret&team=a', upstream: 'https://llm.internal?api_key=s3cret&team=a', from: '.env' })).toEqual({ url: 'https://llm.internal/v1?team=a', upstream: null, from: '.env' });
    expect(modelServerFinding({ url: 'https://x.blob.core/v1?sig=abc&sv=2024', upstream: 'https://x.blob.core', from: '' })).toMatchObject({ url: 'https://x.blob.core/v1?sv=2024', upstream: null });
    expect(modelServerFinding({ url: 'http://llm.internal/v1?api-version=2024-06-01', upstream: 'http://llm.internal/v1?api-version=2024-06-01', from: '' })).toMatchObject({ upstream: 'http://llm.internal/v1?api-version=2024-06-01' });
    expect(modelServerFinding({ url: 'http://127.0.0.1:8000/v1', upstream: 'file:///etc/passwd', from: '' })).toMatchObject({ upstream: null });
  });

  it('forwards only to a plain http(s) address', () => {
    expect(upstreamUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(upstreamUrl('https://llm.internal:8443/openai')).toBe('https://llm.internal:8443/openai');
    for (const bad of ['', 'ftp://host', 'http://u:p@host', 'http://host/a b', 'http://host\n', 42, null]) expect(upstreamUrl(bad), String(bad)).toBeNull();
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

  it('never starts a part with a dash, which pack and test would read as an option', () => {
    for (const bad of ['-V/x', '--no-redact/x', '-h', 'goldens/-x', 'goldens/--help']) expect(goldenPath(bad), bad).toEqual({ ok: false, error: 'A part of the golden’s path can’t start with a dash.' });
    expect(goldenPath('goldens/first-run-2')).toEqual({ ok: true, path: 'goldens/first-run-2' });
  });

  it('never packs over a golden already there, or into a folder of other files', () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'sl-golden-taken-')));
    try {
      mkdirSync(join(folder, 'goldens', 'agent'), { recursive: true });
      writeFileSync(join(folder, 'goldens', 'agent', 'run.json'), JSON.stringify({ format: 'shadowlap-pack', version: 1, runs: [{ runId: 'OLD' }] }));
      expect(goldenPath('goldens/agent', { folder })).toEqual({ ok: false, taken: true, error: 'goldens/agent already holds a golden. Give this one another name: shadowlap never packs over a golden.' });
      expect(goldenPath('goldens/agent', { folder, runId: 'NEW' })).toMatchObject({ ok: false, taken: true });
      // The same run packed again (its test failed, and it is packed once more) is fine.
      expect(goldenPath('goldens/agent', { folder, runId: 'OLD' })).toEqual({ ok: true, path: 'goldens/agent' });
      mkdirSync(join(folder, 'goldens', 'notes'));
      writeFileSync(join(folder, 'goldens', 'notes', 'README.md'), 'notes');
      expect(goldenPath('goldens/notes', { folder })).toEqual({ ok: false, taken: true, error: 'goldens/notes isn’t empty. Give the golden a folder of its own.' });
      writeFileSync(join(folder, 'goldens', 'file'), 'x');
      expect(goldenPath('goldens/file', { folder })).toMatchObject({ ok: false, taken: true, error: 'goldens/file is a file, so shadowlap won’t pack there.' });
      mkdirSync(join(folder, 'goldens', 'empty'));
      expect(goldenPath('goldens/empty', { folder })).toEqual({ ok: true, path: 'goldens/empty' });

      // The setup offers the first free path after goldens/<project>.
      expect(freeGoldenPath(folder, 'agent')).toBe('goldens/agent-2');
      expect(freeGoldenPath(folder, 'agent', 'OLD')).toBe('goldens/agent');
      expect(freeGoldenPath(folder, 'triage-bot')).toBe('goldens/triage-bot');
      mkdirSync(join(folder, 'goldens', 'agent-2'));
      writeFileSync(join(folder, 'goldens', 'agent-2', 'run.json'), '{}');
      expect(freeGoldenPath(folder, 'agent')).toBe('goldens/agent-3');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('won’t pack through a link out of the project', () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'sl-golden-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sl-golden-out-')));
    try {
      expect(goldenPath('goldens/first-run', { folder })).toEqual({ ok: true, path: 'goldens/first-run' });
      mkdirSync(join(folder, 'goldens'));
      symlinkSync(outside, join(folder, 'goldens', 'linked'));
      expect(goldenPath('goldens/linked/x', { folder })).toEqual({ ok: false, error: 'goldens/linked leads out of the project, so shadowlap won’t pack there.' });
      // A link that stays inside the project is fine.
      mkdirSync(join(folder, 'packs'));
      symlinkSync(join(folder, 'packs'), join(folder, 'goldens', 'inside'));
      expect(goldenPath('goldens/inside/x', { folder })).toEqual({ ok: true, path: 'goldens/inside/x' });
      expect(goldenPath('goldens/x', { folder: join(folder, 'gone') })).toMatchObject({ ok: false });
      // A link to nowhere could point anywhere by the time pack runs.
      symlinkSync(join(outside, 'not-yet'), join(folder, 'goldens', 'dangling'));
      expect(goldenPath('goldens/dangling', { folder })).toEqual({ ok: false, error: 'goldens/dangling is a link to nowhere, so shadowlap won’t pack there.' });
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
    // A project on its own model server records with the upstream set, as init prints it.
    expect(setupCommands({ argv: ['node', 'agent.mjs'], runId: null, golden: 'goldens/x', modelServer: { upstream: 'http://127.0.0.1:11434' } }).record).toEqual(['SHADOWLAP_UPSTREAM_OPENAI=http://127.0.0.1:11434 shadowlap run -- node agent.mjs']);
    expect(setupCommands({ argv: ['node', 'agent.mjs'], runId: null, golden: 'goldens/x', modelServer: { upstream: null } }).record).toEqual(['SHADOWLAP_UPSTREAM_OPENAI=<your model server> shadowlap run -- node agent.mjs']);
    // Only the value is quoted: a quoted NAME=value would be taken for a command.
    expect(setupCommands({ argv: ['node', 'agent.mjs'], runId: null, golden: 'goldens/x', modelServer: { upstream: 'http://llm.internal/v1?team=a&x=1' } }).record).toEqual(["SHADOWLAP_UPSTREAM_OPENAI='http://llm.internal/v1?team=a&x=1' shadowlap run -- node agent.mjs"]);
  });

  it('gives the jobs their arguments', () => {
    // Without --json, so the drawer shows what init found in words; its result arrives as the job's result event.
    expect(setupJobArgs.inspect()).toEqual(['init']);
    expect(setupJobArgs.calibrate('R1')).toEqual(['calibrate', 'R1']);
    expect(setupJobArgs.calibrate('R1', true)).toEqual(['calibrate', 'R1', '--write']);
    expect(setupJobArgs.pack('R1', 'goldens/x')).toEqual(['pack', 'R1', 'goldens/x']);
    expect(setupJobArgs.test('goldens/x')).toEqual(['test', 'goldens/x']);
  });

  it('quotes arguments as a terminal would take them back', () => {
    expect(quoteArgv(['node', 'a b', "it's", 'x=1'])).toBe("node 'a b' 'it'\\''s' x=1");
    expect(parseAgentCommand(quoteArgv(['node', 'a b', "it's", 'x=1']))).toEqual({ ok: true, argv: ['node', 'a b', "it's", 'x=1'] });
  });

  it('records again with the command it shows, apostrophes and all', () => {
    const argv = ['python', 'agent.py', "What's the refund policy?"];
    const first = planRecording({ path: '/home/dana/support', confirmed: [] }, `python agent.py "What's the refund policy?"`, { home: '/home/dana' });
    expect(first.ok && first.plan.argv).toEqual(argv);
    // The setup fills in Record again with quoteArgv(argv), and shows the plan's line for a terminal.
    const again = planRecording({ path: '/home/dana/support', confirmed: [{ argv }] }, quoteArgv(argv), { home: '/home/dana' });
    expect(again).toMatchObject({ ok: true, plan: { argv, confirm: null } });
    expect(first.ok && planRecording({ path: '/home/dana/support', confirmed: [{ argv }] }, first.plan.display)).toMatchObject({ ok: true, plan: { argv, confirm: null } });
  });
});
