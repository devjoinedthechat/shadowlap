import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { notFoundMessage, startFailure } from '../src/run-agent.js';

/**
 * A command that isn't on PATH never starts. run and replay say so plainly, keep no run of it (no
 * failed recording with no calls, no hint about the agent's environment), and exit 127 as a shell
 * does.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const dirs: string[] = [];
const fresh = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-notfound-')));
  dirs.push(d);
  return d;
};
const home = fresh();
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
const MISSING = 'shadowlap-no-such-command';

function shadowlap(cwd: string, args: string[]): { code: number | null; out: string; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: home } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}
const runs = (cwd: string) => JSON.parse(shadowlap(cwd, ['ls', '--json']).stdout) as Array<{ runId: string; mode: string }>;

describe('a command that is not on PATH', () => {
  it('records nothing under run, says so and exits 127', () => {
    const dir = fresh();
    const r = shadowlap(dir, ['run', '--', MISSING, 'main.py']);
    expect(r.code).toBe(127);
    expect(r.out).toContain(`✗ ${MISSING}: command not found on PATH`);
    expect(r.out).toMatch(/nothing ran, so run \w{10} is not kept/);
    expect(r.out).not.toContain('no calls were made');
    expect(r.out).not.toContain('SHADOWLAP_CAPTURE');
    expect(runs(dir)).toEqual([]);
  });

  it('keeps no replay of it either', () => {
    const dir = fresh();
    expect(shadowlap(dir, ['run', '--', process.execPath, '-e', '']).code).toBe(0);
    const [recorded] = runs(dir);
    const r = shadowlap(dir, ['replay', recorded.runId, '--', MISSING]);
    expect(r.code).toBe(127);
    expect(r.out).toContain(`✗ ${MISSING}: command not found on PATH`);
    expect(r.out).not.toContain('no calls were made');
    expect(runs(dir).map((x) => x.runId)).toEqual([recorded.runId]);
  });

  it('suggests python3 for python where only python3 is there, as the command was given', () => {
    const again = (argv: string[]) => `shadowlap run -- ${argv.join(' ')}`;
    const has = (names: string[]) => (name: string) => names.includes(name);
    const shown = (argv: string[], names: string[]) => notFoundMessage(argv, again, has(names)).replace(/\u001b\[[0-9;]*m/g, '');
    expect(shown(['python', 'agent.py', '--fast'], ['python3'])).toBe('✗ python: command not found on PATH\n  python3 is on PATH: shadowlap run -- python3 agent.py --fast');
    expect(shown(['python3', 'agent.py'], ['python'])).toBe('✗ python3: command not found on PATH\n  python is on PATH: shadowlap run -- python agent.py');
    expect(shown(['python', 'agent.py'], [])).toBe('✗ python: command not found on PATH');
    expect(shown(['pythn', 'agent.py'], ['python3'])).toBe('✗ pythn: command not found on PATH');
  });
});

describe('a command that cannot start for another reason', () => {
  const enoent = (path: string) => Object.assign(new Error(`spawn ${path} ENOENT`), { code: 'ENOENT' });

  it('blames a working directory that does not exist, not PATH, and keeps spawn\'s words for a program that is there', () => {
    const dir = fresh();
    const gone = join(dir, 'nope');
    const has = (names: string[]) => (name: string) => names.includes(name);
    expect(startFailure(enoent('node'), 'node', gone, has(['node']))).toEqual({ notFound: false, message: `${gone}: working directory does not exist` });
    expect(startFailure(enoent('pythn'), 'pythn', dir, has([]))).toEqual({ notFound: true, message: 'pythn: command not found on PATH' });
    expect(startFailure(enoent('./agent.sh'), './agent.sh', dir, has([]))).toEqual({ notFound: true, message: './agent.sh: no such file' });
    // On PATH, yet ENOENT: a script whose interpreter is missing. Its own words say more than a guess.
    expect(startFailure(enoent('agent'), 'agent', dir, has(['agent']))).toEqual({ notFound: false, message: 'failed to start agent: spawn agent ENOENT' });
    expect(startFailure(Object.assign(new Error('spawn x EACCES'), { code: 'EACCES' }), 'x', dir, has(['x']))).toEqual({ notFound: false, message: 'failed to start x: spawn x EACCES' });
  });

  it('fails a golden replayed in a folder that does not exist for that reason, not for its command', () => {
    const dir = fresh();
    expect(shadowlap(dir, ['run', '--', process.execPath, '-e', '']).code).toBe(0);
    const [recorded] = runs(dir);
    expect(shadowlap(dir, ['pack', recorded.runId, 'goldens/empty']).code).toBe(0);
    const r = shadowlap(dir, ['test', 'goldens/empty', '--cwd', 'nope']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`✗ empty: ${join(dir, 'nope')}: working directory does not exist`);
    expect(r.out).not.toContain('command not found');
  });
});
