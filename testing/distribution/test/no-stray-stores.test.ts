import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import setup, { check, snapshot, strays, WATCHED } from '../../no-stray-stores.mjs';

/**
 * A test that leaves a .shadowlap folder where the suites run (the repository's root, testing/frameworks)
 * fails the run that left it: Vitest's global setup, and the wrapper the framework tests run under.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../no-stray-stores.mjs', import.meta.url));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-stray-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('what tests leave where the suites run', () => {
  it('is a folder that appeared, with what it holds, or what appeared or changed in one there before', () => {
    const fresh = join(dir, 'fresh', '.shadowlap');
    const kept = join(dir, 'kept', '.shadowlap');
    const quiet = join(dir, 'quiet', '.shadowlap');
    mkdirSync(join(kept, 'agents'), { recursive: true });
    writeFileSync(join(kept, 'shadowlap.db'), 'v1');
    utimesSync(join(kept, 'shadowlap.db'), new Date(2026, 0, 1), new Date(2026, 0, 1));
    mkdirSync(quiet, { recursive: true });
    const before = snapshot([fresh, kept, quiet]);
    expect(strays(before)).toEqual([]);

    mkdirSync(join(fresh, 'agents'), { recursive: true });
    writeFileSync(join(fresh, 'active.json'), '{}');
    writeFileSync(join(kept, 'shadowlap.db'), 'v2, written by a test');
    writeFileSync(join(kept, 'agents', '4242.json'), '{}');
    expect(strays(before)).toEqual([`${fresh}/ (active.json, agents)`, `${kept}/agents`, `${kept}/agents/4242.json`, `${kept}/shadowlap.db`]);
  });

  it('counts a file a test wrote and removed again, which leaves its folder changed', () => {
    const kept = join(dir, 'transient', '.shadowlap');
    mkdirSync(kept, { recursive: true });
    utimesSync(kept, new Date(2026, 0, 1), new Date(2026, 0, 1));
    const before = snapshot([kept]);
    writeFileSync(join(kept, 'active.json'), '{}');
    rmSync(join(kept, 'active.json'));
    expect(strays(before)).toEqual([`${kept}/`]);
  });

  it('fails the run on what the tests left, and warns of a folder there before it, which no test made', () => {
    const before = join(dir, 'before', '.shadowlap');
    const after = join(dir, 'after', '.shadowlap');
    mkdirSync(join(before, 'agents'), { recursive: true });
    const warned: string[] = [];
    const teardown = check([before, after], (line) => warned.push(line));
    expect(warned).toEqual([`${before}/ is there from before this run, left by a shadowlap command run there: a test that runs the CLI in a folder inside the repository finds it as its project's store. Remove it.`]);
    expect(teardown).not.toThrow();
    mkdirSync(after, { recursive: true });
    writeFileSync(join(after, 'shadowlap.db'), '');
    expect(teardown).toThrow(`tests left Shadowlap files where the suites run: ${after}/ (shadowlap.db). Run the CLI in a temporary folder (cwd) with a store of its own (--db), and remove these.`);
  });

  it("is the repository's root and testing/frameworks, checked after every Vitest run and around the framework tests", () => {
    expect(WATCHED).toEqual([join(ROOT, '.shadowlap'), join(ROOT, 'testing', 'frameworks', '.shadowlap')]);
    expect(readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')).toContain("globalSetup: ['./testing/no-stray-stores.mjs']");
    const frameworks = JSON.parse(readFileSync(join(ROOT, 'testing', 'frameworks', 'package.json'), 'utf8')) as { scripts: { test: string } };
    expect(frameworks.scripts.test).toMatch(/^node \.\.\/no-stray-stores\.mjs node --test /);
    // The setup's teardown passes when nothing was left.
    expect(setup()).not.toThrow();
  });

  it('fails a command that leaves one, run under the script, and passes on its status otherwise', () => {
    const watched = join(dir, 'script', '.shadowlap');
    const run = (code: string) => spawnSync(process.execPath, [SCRIPT, '--watch', watched, 'node', '-e', code], { encoding: 'utf8' });
    const clean = run('process.exit(0)');
    expect(clean.status, clean.stderr).toBe(0);
    expect(run('process.exit(3)').status).toBe(3);
    const left = run(`require('node:fs').mkdirSync(${JSON.stringify(watched)}, { recursive: true })`);
    expect(left.status).toBe(1);
    expect(left.stderr).toContain(`tests left Shadowlap files where the suites run: ${watched}/ (empty)`);
    // There now, from before the next run: said, and no failure while nothing changes in it.
    const again = run('process.exit(0)');
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).toContain(`! ${watched}/ is there from before this run`);
  });
});
