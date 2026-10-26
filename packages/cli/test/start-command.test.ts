import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { batchFile, cmdArgument, passesArgumentsOn, startCommand } from '../src/start-command.js';

/**
 * Commands the user gives Shadowlap to start (an agent, an MCP server) that are batch files on
 * Windows: `npm`, `npx`, `pnpm`, an npm bin. Node starts none of them by itself there, so they run
 * through cmd.exe with every argument escaped; what Node starts by itself, and every command on
 * other systems, starts as before. Windows is played here with its paths and a set of files, so this
 * runs everywhere; one test starts a real batch file, on Windows only.
 */

const NODE_DIR = 'C:\\Program Files\\nodejs';
/** Where npm installs a global bin, such as Claude Code's `claude`. */
const GLOBAL = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
const PYTHON_DIR = 'C:\\Python312';
const TOOLS = 'C:\\tools';
const PROJECT = 'C:\\work\\agent';
const FILES = new Set([
  `${NODE_DIR}\\node.exe`,
  // npm installs a shell script beside each batch file, for Git Bash: never what cmd.exe runs.
  `${NODE_DIR}\\npm`,
  `${NODE_DIR}\\npm.cmd`,
  `${NODE_DIR}\\npx.cmd`,
  `${GLOBAL}\\claude.cmd`,
  `${PYTHON_DIR}\\python.exe`,
  `${TOOLS}\\uv.cmd`,
  `${TOOLS}\\one-by-one.cmd`,
  `${TOOLS}\\unquoted.cmd`,
  `${TOOLS}\\quoted.cmd`,
  `C:\\later\\uv.exe`,
  `${PROJECT}\\node_modules\\.bin\\tsx`,
  `${PROJECT}\\node_modules\\.bin\\tsx.cmd`,
  `${PROJECT}\\run.bat`,
]);
const exists = (file: string) => FILES.has(file);
/** npm's launcher of npm-cli.js or npx-cli.js, as Node's installer puts it beside node.exe: it passes its arguments on with %*. */
const npmLauncher = (cli: string) => `:: Created by npm, please don't edit manually.\r\n@ECHO OFF\r\nSETLOCAL\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\nIF NOT EXIST "%NODE_EXE%" (\r\n  SET "NODE_EXE=node"\r\n)\r\nSET "CLI_JS=%~dp0\\node_modules\\npm\\bin\\${cli}"\r\n"%NODE_EXE%" "%CLI_JS%" %*\r\n`;
/** The batch file npm writes for a bin it installs, globally or in node_modules\.bin: it passes its arguments on with %* too. */
const npmBin = (script: string) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*\r\n`;
const TEXTS = new Map([
  [`${NODE_DIR}\\npm.cmd`, npmLauncher('npm-cli.js')],
  [`${NODE_DIR}\\npx.cmd`, npmLauncher('npx-cli.js')],
  [`${GLOBAL}\\claude.cmd`, npmBin('node_modules\\@anthropic-ai\\claude-code\\cli.js')],
  [`${PROJECT}\\node_modules\\.bin\\tsx.cmd`, npmBin('..\\tsx\\dist\\cli.mjs')],
  // One a project wrote itself, which takes one argument, in quotes, and passes nothing on.
  [`${PROJECT}\\run.bat`, '@python "%~dp0agent.py" "%~1"\r\n'],
  // Launchers that read their arguments one by one: as they are, with their quotes taken off, or quoted as they came.
  [`${TOOLS}\\one-by-one.cmd`, '@node "%~dp0agent.js" %1 %2 %3 %4 %5 %6 %7 %8 %9\r\n'],
  [`${TOOLS}\\unquoted.cmd`, '@node "%~dp0agent.js" %~1\r\n'],
  [`${TOOLS}\\quoted.cmd`, '@node "%~dp0agent.js" "%1"\r\n'],
]);
const read = (file: string) => TEXTS.get(file) ?? null;
const WINDOWS = { platform: 'win32', exists, read } as const;
const ENV = { Path: `${NODE_DIR};"${PYTHON_DIR}";${TOOLS};C:\\later;${GLOBAL}`, PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', ComSpec: 'C:\\elsewhere\\shell.exe' };
/** The cmd.exe batch files run through: this process's own, as Node's `shell` option takes it, never one the child's environment names. */
const CMD = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
const OPTIONS = { cwd: PROJECT, env: ENV };
const onWindows = (command: string, args: string[] = []) => startCommand(command, args, OPTIONS, WINDOWS);

/** What cmd.exe makes of an escaped argument: each ^ taken off the character after it. */
const uncaret = (s: string) => s.replace(/\^([\s\S])/g, '$1');

/** A command line split the way a Windows program splits it (the C runtime's rules). */
function windowsArgv(line: string): string[] {
  const out: string[] = [];
  let arg = '';
  let inArg = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      let n = 0;
      while (line[i] === '\\') {
        n++;
        i++;
      }
      if (line[i] === '"') {
        arg += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) arg += '"';
        else quoted = !quoted;
      } else {
        arg += '\\'.repeat(n);
        i--;
      }
      inArg = true;
    } else if (ch === '"') {
      quoted = !quoted;
      inArg = true;
    } else if ((ch === ' ' || ch === '\t') && !quoted) {
      if (inArg) out.push(arg);
      arg = '';
      inArg = false;
    } else {
      arg += ch;
      inArg = true;
    }
  }
  if (inArg) out.push(arg);
  return out;
}

/**
 * One pass of cmd.exe over a line, as it reads its own command line and then the line of a batch file
 * that passes its arguments on (`%*`): outside quotes, ^ takes the next character as it is, and &, |,
 * < or > ends the command, what follows it run as a command of its own; a quote not escaped starts or
 * ends a quoted stretch, in which every character is as it is. What the line passes on, and what it
 * would run besides (null for nothing).
 */
function cmdPass(line: string): { out: string; runs: string | null } {
  let out = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') quoted = false;
      out += ch;
    } else if (ch === '^') {
      out += line[++i] ?? '';
    } else if ('&|<>'.includes(ch)) {
      return { out, runs: line.slice(i) };
    } else {
      if (ch === '"') quoted = true;
      out += ch;
    }
  }
  return { out, runs: null };
}

/**
 * How a batch file reads the arguments its line gave it into `%1`, `%2`, …: split at a space, a tab,
 * a comma, a semicolon or an equals sign outside quotes, each quote turning quoting on or off, a
 * caret no different from any other character.
 */
function batchArguments(line: string): string[] {
  const out: string[] = [];
  let arg = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ' \t,;='.includes(ch)) {
      if (arg) out.push(arg);
      arg = '';
    } else arg += ch;
  }
  if (arg) out.push(arg);
  return out;
}

const TRICKY = ['start', 'two words', '', 'say "hi"', 'C:\\dir\\', 'a\\"b', 'a\\\\"b', 'tab\there', '50% off', '%PATH%', 'a&b|c<d>e^f', '!x!', '(paren)', 'semi;comma,', 'star*?', '`tick`', 'trailing\\\\', '"', '\\'];

describe('a cmd.exe argument', () => {
  it('quotes and escapes a word, and words with spaces', () => {
    expect(cmdArgument('start')).toBe('^"start^"');
    expect(cmdArgument('two words')).toBe('^"two^ words^"');
    expect(cmdArgument('')).toBe('^"^"');
    expect(cmdArgument('a&b')).toBe('^"a^&b^"');
  });

  it('reaches the program as it was given, once cmd.exe has read it', () => {
    for (const arg of TRICKY) expect(windowsArgv(uncaret(cmdArgument(arg))), JSON.stringify(arg)).toEqual([arg]);
    expect(windowsArgv(TRICKY.map((a) => uncaret(cmdArgument(a))).join(' '))).toEqual(TRICKY);
  });

  it('is escaped twice for a batch file that passes it through cmd.exe again', () => {
    expect(cmdArgument('a b', true)).toBe('^^^"a^^^ b^^^"');
    for (const arg of TRICKY) expect(windowsArgv(uncaret(uncaret(cmdArgument(arg, true)))), JSON.stringify(arg)).toEqual([arg]);
  });
});

describe('a command on Windows', () => {
  it('runs a batch file Node won\'t start through cmd.exe: npm by its bare name or its full one', () => {
    const npm = `"${NODE_DIR}\\npm.cmd"`;
    // Both pass their arguments on with %*, which cmd.exe reads again, so they are escaped twice.
    expect(onWindows('npm', ['start'])).toEqual({ command: CMD, args: ['/d', '/s', '/c', `"${npm} ^^^"start^^^""`], options: { ...OPTIONS, windowsVerbatimArguments: true } });
    expect(onWindows('npm.cmd', ['run', 'agent']).args).toEqual(['/d', '/s', '/c', `"${npm} ^^^"run^^^" ^^^"agent^^^""`]);
    expect(onWindows('npx', ['-y', '@modelcontextprotocol/server-filesystem', '.']).args[3]).toBe(`""${NODE_DIR}\\npx.cmd" ^^^"-y^^^" ^^^"@modelcontextprotocol/server-filesystem^^^" ^^^".^^^""`);
  });

  it('starts as before what Node starts itself, what it can\'t find, and every command elsewhere', () => {
    for (const [command, args] of [['node', ['agent.mjs']], ['python', ['agent.py']], [`${NODE_DIR}\\node.exe`, ['agent.mjs']], ['missing-tool', []]] as const) {
      expect(onWindows(command, [...args])).toEqual({ command, args, options: OPTIONS });
    }
    // A program anywhere on PATH wins over a batch file earlier on it, as Node would pick it.
    expect(onWindows('uv', ['run', 'agent.py']).command).toBe('uv');
    expect(startCommand('npm', ['start'], OPTIONS, { platform: 'darwin', exists, read })).toEqual({ command: 'npm', args: ['start'], options: OPTIONS });
    expect(startCommand('npm', ['start'], OPTIONS, { platform: 'linux', exists, read }).command).toBe('npm');
    // A line break would end cmd.exe's command line, so such an argument isn't passed through it.
    expect(onWindows('npm', ['run', 'say', 'one\ntwo']).command).toBe('npm');
  });

  it('finds an npm bin by the path it was given, escaping its arguments twice, and a batch file in the working directory', () => {
    const tsx = onWindows('node_modules/.bin/tsx', ['agent.ts', 'a b']);
    expect(tsx.args[3]).toBe(`""${PROJECT}\\node_modules\\.bin\\tsx.cmd" ^^^"agent.ts^^^" ^^^"a^^^ b^^^""`);
    expect(onWindows('run.bat', ['x']).args[3]).toBe(`""${PROJECT}\\run.bat" ^"x^""`);
    expect(onWindows('run', ['x']).args[3]).toBe(`""${PROJECT}\\run.bat" ^"x^""`);
  });

  it('escapes twice the arguments of every batch file that passes them on, so a quote in one never ends it and runs what follows', () => {
    // Text from production, as `coverage --pack` puts a capture's message in `npx tsx agent.ts {message}`:
    // escaped once, npx.cmd's %* would end the first at its quote, and cmd.exe would run `calc`.
    const hostile = ['x" & calc & "', 'a"|b', '")&(calc', 'say "hi" > out.txt', JSON.stringify({ q: 'a" & calc & "b' }), ...TRICKY];
    for (const [command, file] of [['npx', `${NODE_DIR}\\npx.cmd`], ['npm.cmd', `${NODE_DIR}\\npm.cmd`], ['claude', `${GLOBAL}\\claude.cmd`], ['node_modules/.bin/tsx', `${PROJECT}\\node_modules\\.bin\\tsx.cmd`]] as const) {
      const line = onWindows(command, ['tsx', ...hostile]).args[3];
      // What cmd.exe reads: its /s /c line inside the outer quotes, then the batch file's %*.
      const first = cmdPass(line.slice(1, -1));
      expect(first.runs, command).toBeNull();
      expect(first.out.startsWith(`"${file}" `), first.out).toBe(true);
      const second = cmdPass(first.out.slice(file.length + 3));
      expect(second.runs, command).toBeNull();
      expect(windowsArgv(second.out), command).toEqual(['tsx', ...hostile]);
    }
    // A batch file that passes nothing on is escaped once, as before, and one that can't be read twice.
    expect(passesArgumentsOn(`${PROJECT}\\run.bat`, read)).toBe(false);
    expect(onWindows('run.bat', ['two words']).args[3]).toBe(`""${PROJECT}\\run.bat" ^"two^ words^""`);
    expect(startCommand('x', ['a b'], OPTIONS, { platform: 'win32', exists: (f) => f === `${TOOLS}\\x.cmd`, read: () => null }).args[3]).toBe(`""${TOOLS}\\x.cmd" ^^^"a^^^ b^^^""`);
  });

  it('escapes twice the arguments of a batch file that puts them in its line one by one, %1, %~1 or "%1", so none runs what follows', () => {
    // As a launcher that reads %1 or %~1 would put them in its line: one by one, each where it stands.
    const lineOf = (file: string, args: string[]): string => {
      const first = cmdPass(onWindows(file, args).args[3].slice(1, -1));
      expect(first.runs, file).toBeNull();
      const given = batchArguments(first.out).slice(1);
      const text = TEXTS.get(`${TOOLS}\\${file}`)!;
      return text.replace(/(")?%(~)?([1-9])(")?/g, (_whole, q1: string | undefined, tilde: string | undefined, n: string, q2: string | undefined) => {
        const arg = given[Number(n) - 1] ?? '';
        const bare = tilde && arg.startsWith('"') && arg.endsWith('"') && arg.length > 1 ? arg.slice(1, -1) : arg;
        return `${q1 ?? ''}${bare}${q2 ?? ''}`;
      });
    };
    for (const file of ['one-by-one.cmd', 'unquoted.cmd', 'quoted.cmd']) {
      expect(passesArgumentsOn(`${TOOLS}\\${file}`, read), file).toBe(true);
      for (const hostile of ['x" & calc & "', 'a & calc', 'a"|b', '")&(calc', 'say "hi" > out.txt']) {
        expect(cmdPass(lineOf(file, [hostile])).runs, `${file} ${hostile}`).toBeNull();
      }
    }
    // Escaped once, as before, each of them would have run it.
    for (const [file, hostile] of [['one-by-one.cmd', 'x" & calc & "'], ['unquoted.cmd', 'a & calc']] as const) {
      const once = cmdPass(`"${TOOLS}\\${file}" ${cmdArgument(hostile)}`);
      const given = batchArguments(once.out).slice(1);
      const line = TEXTS.get(`${TOOLS}\\${file}`)!.replace(/%(~)?([1-9])/g, (_w, tilde: string | undefined, n: string) => {
        const arg = given[Number(n) - 1] ?? '';
        return tilde && arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg;
      });
      expect(cmdPass(line).runs, file).not.toBeNull();
    }
    // A file that reads its argument only as "%~1" is escaped once: its program gets it as given, words and all.
    expect(passesArgumentsOn(`${PROJECT}\\run.bat`, read)).toBe(false);
  });

  it('reads PATH and PATHEXT whatever the case of their names, from this process when the child has none', () => {
    for (const env of [{ PATH: NODE_DIR }, { path: NODE_DIR }, { Path: NODE_DIR }]) {
      expect(startCommand('npm', ['start'], { cwd: PROJECT, env }, WINDOWS).args[3]).toBe(`""${NODE_DIR}\\npm.cmd" ^^^"start^^^""`);
    }
    const path = process.env.PATH;
    process.env.PATH = NODE_DIR;
    try {
      // As Node looks a command up: on this process's PATH when the child's environment has none.
      expect(startCommand('npx', ['-y', 'server'], { cwd: PROJECT, env: { FOO: '1' } }, WINDOWS).args[3]).toBe(`""${NODE_DIR}\\npx.cmd" ^^^"-y^^^" ^^^"server^^^""`);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
    // .cmd before .bat when PATHEXT says so, else .bat first, as cmd.exe picks.
    const both = new Set([`${TOOLS}\\x.bat`, `${TOOLS}\\x.cmd`]);
    expect(batchFile('x', { cwd: PROJECT, path: TOOLS, pathext: '.CMD;.BAT', exists: (f) => both.has(f) })).toBe(`${TOOLS}\\x.cmd`);
    expect(batchFile('x', { cwd: PROJECT, path: TOOLS, exists: (f) => both.has(f) })).toBe(`${TOOLS}\\x.bat`);
    expect(batchFile('', { cwd: PROJECT, path: TOOLS, exists })).toBeNull();
  });
});

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

describe.runIf(process.platform === 'win32')('shadowlap run, given a batch file on Windows', () => {
  it('starts it through cmd.exe, its arguments reaching the agent as they were given', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-batch-')));
    try {
      writeFileSync(join(dir, 'args.mjs'), 'console.log("args " + JSON.stringify(process.argv.slice(2)));\n');
      writeFileSync(join(dir, 'agent.cmd'), `@"${process.execPath}" "%~dp0args.mjs" %*\r\n`);
      // The last would end at its quote, escaped once, and cmd.exe would run `echo injected`.
      const given = ['plain', 'two words', 'a&b', '50% off', '', 'a" & echo injected & "b'];
      const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [CLI, '--db', join(dir, 'store.db'), 'run', '--', 'agent.cmd', ...given], { cwd: dir, env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (code) => resolve({ code, out }));
      });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`args ${JSON.stringify(given)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
