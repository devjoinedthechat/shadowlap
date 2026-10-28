import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { CommanderError, InvalidArgumentError } from 'commander';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliError, EXIT, exitCodeOf, inconclusiveStatus, reportError, signalExit } from '../src/exit-codes.js';

/**
 * The exit status contract scripts and CI build on (docs/cli.md, Exit status): 0 ok, 1 failed, 2
 * usage or configuration, 3 inconclusive, 70 an internal error, 128 + n a signal. Each status is
 * shown on the built CLI, as a script would see it.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const dirs: string[] = [];
const fresh = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-exit-')));
  dirs.push(d);
  return d;
};
const home = fresh();
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

const ENV: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: home, SHADOWLAP_DEBUG: '' };
for (const k of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST'] as const) delete ENV[k];

function shadowlap(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): { code: number | null; signal: NodeJS.Signals | null; out: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...ENV, ...env } });
  return { code: r.status, signal: r.signal, out: `${r.stdout}${r.stderr}`, stderr: r.stderr };
}

/** An agent with one recorded call and no model: a clock read through the sidecar's wire protocol. */
const AGENT = `
const url = process.env.SHADOWLAP_URL;
const res = await fetch(url + '/v1/calls/resolve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-run': process.env.SHADOWLAP_RUN_ID ?? '' }, body: JSON.stringify({ kind: 'clock', name: 'now', label: '' }) });
if (!res.ok) throw new Error('the sidecar answered ' + res.status);
console.log('hello at', (await res.json()).result);
`;

let project: string;
let runId: string;
beforeAll(() => {
  project = fresh();
  writeFileSync(join(project, 'agent.mjs'), AGENT);
  const r = shadowlap(project, ['run', '--', process.execPath, 'agent.mjs']);
  expect(r.code, r.out).toBe(0);
  runId = /Recorded (\w{26})/.exec(r.out)![1]!;
}, 60_000);

describe('what a command throws, as an exit status', () => {
  it('names its own status with CliError, and reads commander’s errors as usage (help and version as 0)', () => {
    expect(exitCodeOf(new CliError(EXIT.inconclusive, 'not decided'))).toBe(3);
    expect(exitCodeOf(new InvalidArgumentError('must be a positive integer'))).toBe(2);
    expect(exitCodeOf(new CommanderError(1, 'commander.unknownOption', "error: unknown option '--bogus'"))).toBe(2);
    expect(exitCodeOf(new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)'))).toBe(0);
  });

  it('reads a message written for the person as usage, and a bug as an internal error', () => {
    // Shadowlap raises what a person has to fix as an Error with a message for them.
    expect(exitCodeOf(new Error('no run matches "x" (see: shadowlap ls)'))).toBe(2);
    expect(exitCodeOf(Object.assign(new Error("ENOENT: no such file or directory, open 'checks.json'"), { code: 'ENOENT', syscall: 'open' }))).toBe(2);
    expect(exitCodeOf(new SyntaxError('Unexpected token } in JSON at position 4'))).toBe(2);
    // A bug never carries one.
    expect(exitCodeOf(new TypeError("Cannot read properties of null (reading 'argv')"))).toBe(70);
    expect(exitCodeOf(new RangeError('Invalid array length'))).toBe(70);
    expect(exitCodeOf(Object.assign(new Error('The "path" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' }))).toBe(70);
    expect(exitCodeOf('a thrown string')).toBe(70);
    expect(exitCodeOf(undefined)).toBe(70);
  });

  it('reads a host that did not answer, or a busy store, as a failure, and a store that is no store as usage', () => {
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) });
    expect(exitCodeOf(refused)).toBe(1);
    expect(exitCodeOf(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }))).toBe(1);
    expect(exitCodeOf(Object.assign(new Error('file is not a database'), { code: 'ERR_SQLITE_ERROR', errcode: 26 }))).toBe(2);
    expect(exitCodeOf(Object.assign(new Error('no such column: x'), { code: 'ERR_SQLITE_ERROR', errcode: 1 }))).toBe(70);
  });

  it('says an internal error is a bug, how to see where it happened and where to report it', () => {
    let said = '';
    expect(reportError(new TypeError('boom'), (t) => (said += t))).toBe(70);
    expect(said).toBe('shadowlap: internal error: boom\nThis is a bug in Shadowlap: run the command again with SHADOWLAP_DEBUG=1 to see where it happened, and report it at https://github.com/devjoinedthechat/shadowlap/issues\n');
    said = '';
    expect(reportError(new Error('no run matches "x"'), (t) => (said += t))).toBe(2);
    expect(said).toBe('shadowlap: no run matches "x"\n');
    // What commander printed already isn't repeated.
    said = '';
    expect(reportError(new CliError(2, 'error: unknown option', { reported: true }), (t) => (said += t))).toBe(2);
    expect(said).toBe('');
  });

  it('gives a signal 128 plus its number, and an inconclusive verdict 3 unless --inconclusive warn', () => {
    expect([signalExit('SIGHUP'), signalExit('SIGINT'), signalExit('SIGTERM'), signalExit('SIGKILL')]).toEqual([129, 130, 143, 137]);
    expect([inconclusiveStatus('fail'), inconclusiveStatus('warn')]).toEqual([3, 0]);
  });
});

describe('the built CLI', () => {
  it('0: did what it was asked', () => {
    expect(shadowlap(project, ['--version']).code).toBe(0);
    expect(shadowlap(project, ['ls']).code).toBe(0);
    expect(shadowlap(project, ['check', runId, '--expect', '{"tools":{"send_email":0}}']).code).toBe(0);
  });

  it('1: a check failed', () => {
    const r = shadowlap(project, ['check', runId, '--expect', '{"tools":{"send_email":1}}']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('send_email called 1 time: called 0 times');
  });

  it('2: a bad flag, command or argument, an unknown run, a file it can’t read, an invalid config, a live command with no key', () => {
    const unknownFlag = shadowlap(project, ['ls', '--bogus']);
    expect(unknownFlag.code).toBe(2);
    expect(unknownFlag.stderr).toContain("error: unknown option '--bogus'");
    expect(shadowlap(project, ['frobnicate']).code).toBe(2);
    expect(shadowlap(project, ['replay', runId, '--repeat', 'many']).code).toBe(2);
    // A command group with no command shows its help, as a usage error.
    expect(shadowlap(project, ['fix']).code).toBe(2);
    const unknownRun = shadowlap(project, ['show', 'NOSUCHRUN']);
    expect(unknownRun.code).toBe(2);
    expect(unknownRun.stderr).toBe('shadowlap: no run matches "NOSUCHRUN" (see: shadowlap ls)\n');
    expect(shadowlap(project, ['check', runId, '--expect', '@missing.json']).code).toBe(2);
    const keyless = shadowlap(project, ['import', 'langfuse', '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07']);
    expect(keyless.code).toBe(2);
    expect(keyless.stderr).toContain('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
    const configured = fresh();
    writeFileSync(join(configured, 'shadowlap.config.json'), JSON.stringify({ clock: 'sometimes' }));
    const invalid = shadowlap(configured, ['--db', join(project, '.shadowlap', 'shadowlap.db'), 'replay', runId, '--', process.execPath, join(project, 'agent.mjs')]);
    expect(invalid.code, invalid.out).toBe(2);
    expect(invalid.stderr).toContain('shadowlap.config.json: clock must be "auto" or "exact"');
    // A golden path that names no pack is a typo to fix: 2, the golden failed in the report all the same.
    const missing = shadowlap(project, ['test', 'goldens/missing']);
    expect(missing.code, missing.out).toBe(2);
    expect(missing.out).toContain('goldens/missing is not a Shadowlap pack');
  });

  it('3: inconclusive, and 0 when --inconclusive warn lets it through', () => {
    // A recording keeps no output: a check of what the agent printed can't be decided from it.
    const r = shadowlap(project, ['check', runId, '--expect', '{"output":{"includes":"hello"}}']);
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain('1 inconclusive');
    // A golden whose judge check has no verdict and no judge to ask is inconclusive offline.
    const golden = fresh();
    writeFileSync(join(golden, 'agent.mjs'), AGENT);
    expect(shadowlap(golden, ['--db', join(project, '.shadowlap', 'shadowlap.db'), 'pack', runId, join(golden, 'goldens', 'hello')]).code).toBe(0);
    writeFileSync(join(golden, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/hello': { expect: { judge: [{ name: 'greets', question: 'Does it say hello?', of: 'output', model: 'claude-haiku-4-5' }] } } } }));
    const keyless = { ANTHROPIC_API_KEY: '', SHADOWLAP_UPSTREAM_ANTHROPIC: '' };
    const tested = shadowlap(golden, ['test', 'goldens/hello', '--cwd', project], keyless);
    expect(tested.code, tested.out).toBe(3);
    expect(tested.out).toContain('0 passed, 0 failed, 1 inconclusive');
    expect(shadowlap(golden, ['test', 'goldens/hello', '--cwd', project, '--inconclusive', 'warn'], keyless).code).toBe(0);
  }, 60_000);

  it('70: an internal error, which says it is a bug and how to see where it happened', () => {
    const broken = fresh();
    const db = join(broken, 'broken.db');
    const recorded = shadowlap(broken, ['--db', db, 'run', '--', process.execPath, '-e', '0']);
    expect(recorded.code, recorded.out).toBe(0);
    const id = /Recorded (\w{26})/.exec(recorded.out)![1];
    // A run whose command the store lost: reading it hits a null where Shadowlap never writes one.
    const sqlite = new DatabaseSync(db);
    sqlite.exec(`UPDATE runs SET command = 'null'`);
    sqlite.close();
    const shown = shadowlap(broken, ['--db', db, 'show', id]);
    expect(shown.code, shown.out).toBe(70);
    expect(shown.stderr).toMatch(/^shadowlap: internal error: Cannot read properties of null/);
    expect(shown.stderr).toContain('run the command again with SHADOWLAP_DEBUG=1 to see where it happened, and report it at https://github.com/devjoinedthechat/shadowlap/issues');
    const debug = shadowlap(broken, ['--db', db, 'show', id], { SHADOWLAP_DEBUG: '1' });
    expect(debug.code).toBe(70);
    expect(debug.stderr).toMatch(/TypeError: Cannot read properties of null[\s\S]*\n\s+at /);
    expect(debug.stderr).toContain('please report it, with the stack above');
  });

  it('ends with 2, before anything runs, every command that runs an agent with a SHADOWLAP_GUARD_ACCEPT it can\'t take', () => {
    const golden = join(project, 'goldens', 'hello');
    if (!existsSync(golden)) expect(shadowlap(project, ['pack', runId, 'goldens/hello']).code).toBe(0);
    for (const args of [['test', 'goldens/hello'], ['replay', runId], ['run', '--', process.execPath, 'agent.mjs'], ['blame', runId, '--attempts', '1', '--passes', '1'], ['test', 'goldens/hello', '--chaos']]) {
      // One that hangs ignores a polite signal: killed outright, so the test fails rather than waits.
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: project, encoding: 'utf8', env: { ...ENV, SHADOWLAP_GUARD_ACCEPT: 'bogus' }, timeout: 30_000, killSignal: 'SIGKILL' });
      expect(r.signal, `${args.join(' ')} still ran after 30 s`).toBeNull();
      expect(r.status, `${args.join(' ')}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toContain('SHADOWLAP_GUARD_ACCEPT takes "claude-code" alone, not "bogus"');
      expect(r.stderr).not.toContain('replaying run');
    }
  }, 120_000);

  it.skipIf(process.platform === 'win32')('128 + n: a signal that comes once the command has set its status, as it winds down', async () => {
    // A command that set its verdict's status and is still closing (verify after its verdict, repair
    // closing its store), with a listener of its own for the signal: the signal's status is the one.
    const dir = fresh();
    const script = join(dir, 'late.mjs');
    writeFileSync(
      script,
      `import { watchStopSignals } from ${JSON.stringify(new URL('../dist/exit-codes.js', import.meta.url).href)};
watchStopSignals();
process.on('SIGINT', () => {});
process.exitCode = 1;
setTimeout(() => process.kill(process.pid, 'SIGINT'), 50);
setTimeout(() => {}, 400);
`,
    );
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(130);
  });

  it.skipIf(process.platform === 'win32')('128 + n: a signal, however the command wound down', async () => {
    for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
      const child = spawn(process.execPath, [CLI, 'dashboard', '--port', '0', '--no-open', '--db', ':memory:'], { cwd: project, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
      // The dashboard is up once it prints its link: stopping it is a signal it winds down from.
      for (let i = 0; i < 200 && !/http:\/\/127\.0\.0\.1:\d+\/#token=/.test(err); i++) await new Promise((r) => setTimeout(r, 50));
      child.kill(signal);
      expect(await exited, `${signal}: ${err}`).toBe(code);
    }
  }, 60_000);
});
