import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { batchFile, cmdArgument, startCommand } from '../src/start-command.js';

/**
 * Commands the user gives Shadowlap to start (an agent, an MCP server) that are batch files on
 * Windows: `npm`, `npx`, `pnpm`, an npm bin. Node starts none of them by itself there, so they run
 * through cmd.exe with every argument escaped; what Node starts by itself, and every command on
 * other systems, starts as before. Windows is played here with its paths and a set of files, so this
 * runs everywhere; one test starts a real batch file, on Windows only.
 */

const NODE_DIR = 'C:\\Program Files\\nodejs';
const PYTHON_DIR = 'C:\\Python312';
const TOOLS = 'C:\\tools';
const PROJECT = 'C:\\work\\agent';
const FILES = new Set([
  `${NODE_DIR}\\node.exe`,
  // npm installs a shell script beside each batch file, for Git Bash: never what cmd.exe runs.
  `${NODE_DIR}\\npm`,
  `${NODE_DIR}\\npm.cmd`,
  `${NODE_DIR}\\npx.cmd`,
  `${PYTHON_DIR}\\python.exe`,
  `${TOOLS}\\uv.cmd`,
  `C:\\later\\uv.exe`,
  `${PROJECT}\\node_modules\\.bin\\tsx`,
  `${PROJECT}\\node_modules\\.bin\\tsx.cmd`,
  `${PROJECT}\\run.bat`,
]);
const exists = (file: string) => FILES.has(file);
const ENV = { Path: `${NODE_DIR};"${PYTHON_DIR}";${TOOLS};C:\\later`, PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', ComSpec: 'C:\\elsewhere\\shell.exe' };
/** The cmd.exe batch files run through: this process's own, as Node's `shell` option takes it, never one the child's environment names. */
const CMD = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
const OPTIONS = { cwd: PROJECT, env: ENV };
const onWindows = (command: string, args: string[] = []) => startCommand(command, args, OPTIONS, { platform: 'win32', exists });

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
    expect(onWindows('npm', ['start'])).toEqual({ command: CMD, args: ['/d', '/s', '/c', `"${npm} ^"start^""`], options: { ...OPTIONS, windowsVerbatimArguments: true } });
    expect(onWindows('npm.cmd', ['run', 'agent']).args).toEqual(['/d', '/s', '/c', `"${npm} ^"run^" ^"agent^""`]);
    expect(onWindows('npx', ['-y', '@modelcontextprotocol/server-filesystem', '.']).args[3]).toBe(`""${NODE_DIR}\\npx.cmd" ^"-y^" ^"@modelcontextprotocol/server-filesystem^" ^".^""`);
  });

  it('starts as before what Node starts itself, what it can\'t find, and every command elsewhere', () => {
    for (const [command, args] of [['node', ['agent.mjs']], ['python', ['agent.py']], [`${NODE_DIR}\\node.exe`, ['agent.mjs']], ['missing-tool', []]] as const) {
      expect(onWindows(command, [...args])).toEqual({ command, args, options: OPTIONS });
    }
    // A program anywhere on PATH wins over a batch file earlier on it, as Node would pick it.
    expect(onWindows('uv', ['run', 'agent.py']).command).toBe('uv');
    expect(startCommand('npm', ['start'], OPTIONS, { platform: 'darwin', exists })).toEqual({ command: 'npm', args: ['start'], options: OPTIONS });
    expect(startCommand('npm', ['start'], OPTIONS, { platform: 'linux', exists }).command).toBe('npm');
    // A line break would end cmd.exe's command line, so such an argument isn't passed through it.
    expect(onWindows('npm', ['run', 'say', 'one\ntwo']).command).toBe('npm');
  });

  it('finds an npm bin by the path it was given, escaping its arguments twice, and a batch file in the working directory', () => {
    const tsx = onWindows('node_modules/.bin/tsx', ['agent.ts', 'a b']);
    expect(tsx.args[3]).toBe(`""${PROJECT}\\node_modules\\.bin\\tsx.cmd" ^^^"agent.ts^^^" ^^^"a^^^ b^^^""`);
    expect(onWindows('run.bat', ['x']).args[3]).toBe(`""${PROJECT}\\run.bat" ^"x^""`);
    expect(onWindows('run', ['x']).args[3]).toBe(`""${PROJECT}\\run.bat" ^"x^""`);
  });

  it('reads PATH and PATHEXT whatever the case of their names, from this process when the child has none', () => {
    for (const env of [{ PATH: NODE_DIR }, { path: NODE_DIR }, { Path: NODE_DIR }]) {
      expect(startCommand('npm', ['start'], { cwd: PROJECT, env }, { platform: 'win32', exists }).args[3]).toBe(`""${NODE_DIR}\\npm.cmd" ^"start^""`);
    }
    const path = process.env.PATH;
    process.env.PATH = NODE_DIR;
    try {
      // As Node looks a command up: on this process's PATH when the child's environment has none.
      expect(startCommand('npx', ['-y', 'server'], { cwd: PROJECT, env: { FOO: '1' } }, { platform: 'win32', exists }).args[3]).toBe(`""${NODE_DIR}\\npx.cmd" ^"-y^" ^"server^""`);
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
      const given = ['plain', 'two words', 'a&b', '50% off', ''];
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
