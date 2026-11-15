import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';

/**
 * The global options, --db and -v, go before the command or after it: `shadowlap ls --db other.db`
 * reads other.db as `shadowlap --db other.db ls` does, and each command's help lists them.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const dirs: string[] = [];
const fresh = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-global-')));
  dirs.push(d);
  return d;
};
const home = fresh();
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

function shadowlap(cwd: string, args: string[]): { code: number | null; out: string; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: home } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

function storeWithRun(path: string): string {
  const store = Store.open(path);
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/' } });
  store.close();
  return run.runId;
}

describe('the global options', () => {
  it('are taken after the command as before it', () => {
    const dir = fresh();
    const other = storeWithRun(join(dir, 'other.db'));
    const ids = (r: { stdout: string }) => (JSON.parse(r.stdout) as Array<{ runId: string }>).map((x) => x.runId);
    expect(ids(shadowlap(dir, ['--db', 'other.db', 'ls', '--json']))).toEqual([other]);
    const after = shadowlap(dir, ['ls', '--db', 'other.db', '--json']);
    expect(after.code, after.out).toBe(0);
    expect(ids(after)).toEqual([other]);
    // A subcommand's too, and the one nearest the command wins.
    const third = storeWithRun(join(dir, 'third.db'));
    expect(ids(shadowlap(dir, ['--db', 'other.db', 'ls', '--db', 'third.db', '--json']))).toEqual([third]);
    const fixes = shadowlap(dir, ['fix', 'ls', '--db', 'other.db', '--json']);
    expect(fixes.code, fixes.out).toBe(0);
    expect(existsSync(join(dir, '.shadowlap'))).toBe(false);
  });

  it('as -v on a replay, and --db on a test session', () => {
    const dir = fresh();
    const replay = shadowlap(dir, ['replay', 'x', '-v']);
    expect(replay.out).not.toContain('unknown option');
    expect(replay.out).toContain('no run matches "x"');
    const test = shadowlap(dir, ['test', 'goldens/x', '--db', 'r.db']);
    expect(test.out).not.toContain('unknown option');
    expect(test.out).toContain('goldens/x is not a shadowlap pack');
    // The session is kept where --db says.
    expect(existsSync(join(dir, 'r.db'))).toBe(true);
    expect(existsSync(join(dir, '.shadowlap', 'shadowlap.db'))).toBe(false);
  });

  it('are listed in each command’s help', () => {
    const help = shadowlap(fresh(), ['ls', '--help']).stdout;
    expect(help).toMatch(/Global Options:[\s\S]*--db <path>[\s\S]*-v, --verbose/);
  });
});
