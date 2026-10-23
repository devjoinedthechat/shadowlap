import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';

/**
 * Commands that only read the store, or change only what it already holds, never create one: run
 * where there is none (a subfolder of the project, an empty folder), they read it as empty and
 * leave no .shadowlap behind. When the project's store is in a folder above, they say where.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const dirs: string[] = [];
const fresh = (prefix = 'sl-read-'): string => {
  // As the CLI sees it: macOS's temporary folder is reached through a link.
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const home = fresh('sl-read-home-');
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

function shadowlap(cwd: string, args: string[]): { code: number | null; out: string; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: home } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

describe('a command that only reads the store', () => {
  // Exit status 2 for a run or fix it can't find (usage), 1 for a search that matches nothing (as grep).
  const reads: Array<[string[], number]> = [
    [['ls'], 0],
    [['ls', '--json'], 0],
    [['show', 'x'], 2],
    [['search', 'foo'], 1],
    [['label', 'x', 'y'], 2],
    [['note', 'x', 'hello'], 2],
    [['diff', 'a', 'b'], 2],
    [['rm', 'x'], 2],
    [['pack', 'x', 'out'], 2],
    [['export', 'html', 'x'], 2],
    [['export', 'dataset', '--all'], 0],
    [['export', 'pairs'], 0],
    [['fix', 'ls'], 0],
    [['fix', 'show', 'fx-01'], 2],
    [['fix', 'title', 'fx-01', 'New'], 2],
    [['tasks', 'ls'], 0],
    // Commands that record look their run up first: one that isn't there leaves no store either.
    [['replay', 'x'], 2],
    [['blame', 'x', '--expect', '{"exitCode":0}'], 2],
  ];
  it.each(reads)('%j leaves no store behind in a folder without one', (args, code) => {
    const dir = fresh();
    const r = shadowlap(dir, args);
    expect(r.code, r.out).toBe(code);
    expect(existsSync(join(dir, '.shadowlap')), `${args.join(' ')} created .shadowlap: ${r.out}`).toBe(false);
    if (args[0] === 'ls' && args.length === 1) expect(r.out).toContain('no runs yet: shadowlap run -- <command>');
    if (args[0] === 'ls' && args[1] === '--json') expect(JSON.parse(r.stdout)).toEqual([]);
    if (args[0] === 'show') expect(r.out).toContain('no run matches "x" (see: shadowlap ls)');
  });

  it('names the project’s store in a folder above, and leaves none in the subfolder', () => {
    const project = fresh();
    mkdirSync(join(project, '.shadowlap'));
    const store = Store.open(join(project, '.shadowlap', 'shadowlap.db'));
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: project } });
    store.close();
    const src = join(project, 'src');
    mkdirSync(src);
    const show = shadowlap(src, ['show', run.runId.slice(0, 10)]);
    expect(show.code).toBe(2);
    expect(show.out).toContain(`no run matches "${run.runId.slice(0, 10)}": there is no store in this folder, and the nearest is ${join('..', '.shadowlap', 'shadowlap.db')}. Run shadowlap from ${project}, or name that store: shadowlap --db ${join('..', '.shadowlap', 'shadowlap.db')} <command>`);
    const ls = shadowlap(src, ['ls']);
    expect(ls.code).toBe(0);
    expect(ls.out).toContain('no runs: there is no store in this folder, and the nearest is');
    expect(readdirSync(src)).toEqual([]);
    // Named, it is read.
    const named = shadowlap(src, ['--db', join('..', '.shadowlap', 'shadowlap.db'), 'ls', '--json']);
    expect(JSON.parse(named.stdout)).toEqual([expect.objectContaining({ runId: run.runId })]);
  });

  it('says so when --db names a store that isn’t there, and creates none', () => {
    const dir = fresh();
    const r = shadowlap(dir, ['--db', 'other.db', 'show', 'x']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('no run matches "x": there is no store at other.db');
    expect(existsSync(join(dir, 'other.db'))).toBe(false);
  });

  it('reads --db :memory: as the empty store it is, with no file to point at', () => {
    const dir = fresh();
    const ls = shadowlap(dir, ['--db', ':memory:', 'ls']);
    expect(ls.code).toBe(0);
    expect(ls.out).toContain('no runs yet: shadowlap run -- <command>');
    const show = shadowlap(dir, ['--db', ':memory:', 'show', 'x']);
    expect(show.code).toBe(2);
    expect(show.out).toContain('no run matches "x" (see: shadowlap ls)');
    expect(show.out).not.toContain('there is no store');
    expect(readdirSync(dir)).toEqual([]);
  });
});
