import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import setup, { addedMessage, changedMessage, check, checkoutMessage, checkoutStatus, isOutput, leftInCheckout, setupOptions, snapshot, strays, WATCHED } from '../../no-stray-stores.mjs';

/**
 * A test that leaves a .shadowlap folder where the suites run (the repository's root, testing/frameworks),
 * or anything in the checkout, fails the run that left it: Vitest's global setup, and the wrapper the
 * framework tests run under.
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
    const teardown = check([before, after], (line) => warned.push(line), { root: null });
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

describe('what tests leave in the checkout', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
  /** A git repository with a test folder, a Python package and a built one in it, each with a committed file. */
  function repository(): string {
    const repo = realpathSync.native(mkdtempSync(join(dir, 'checkout-')));
    git(repo, 'init', '-q');
    for (const folder of ['test', 'guard', 'pkg']) mkdirSync(join(repo, folder));
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n__pycache__/\n*.tsbuildinfo\nvitest-junit.xml\n.DS_Store\n');
    for (const file of ['test/a.test.ts', 'guard/hook.py', 'pkg/index.ts', 'notes.md']) writeFileSync(join(repo, file), 'as committed\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'files');
    return repo;
  }
  const put = (path: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '');
  };

  it("is what git lists after the run that it didn't list before, build outputs, test reports and the system's own files aside", () => {
    const repo = repository();
    put(join(repo, 'draft.md'));
    const before = checkoutStatus(repo)!;
    expect([...before]).toEqual([['draft.md', '??']]);
    // What a run may build or write of its own.
    for (const file of ['node_modules/x/index.js', 'pkg/dist/index.js', 'pkg/dist/index.js.map', 'pkg/tsconfig.tsbuildinfo', 'vitest-junit.xml', 'coverage/index.html', 'test/.DS_Store']) put(join(repo, file));
    expect(leftInCheckout(before, checkoutStatus(repo)!)).toEqual({ left: [], changed: [] });
    // What tests used to leave: a project next to a test, a script beside it, Python's bytecode, a tracked file changed.
    put(join(repo, 'test', '.tmp-fixes-4242-0', 'agent.mjs'));
    put(join(repo, 'test', '.realtime-agent-4242.mjs'));
    put(join(repo, 'guard', '__pycache__', 'hook.cpython-312.pyc'));
    writeFileSync(join(repo, 'notes.md'), 'changed by a test\n');
    expect(leftInCheckout(before, checkoutStatus(repo)!)).toEqual({ left: ['guard/__pycache__/', 'test/.realtime-agent-4242.mjs', 'test/.tmp-fixes-4242-0/'], changed: ['notes.md'] });
  });

  it('fails the run on what tests leave, and under CI on anything new or changed, which elsewhere it says', () => {
    const repo = repository();
    const warned: string[] = [];
    const lax = check([], (line) => warned.push(line), { root: repo, strict: false });
    const strict = check([], () => {}, { root: repo, strict: true });
    writeFileSync(join(repo, 'notes.md'), 'edited while the tests ran\n');
    expect(lax).not.toThrow();
    expect(warned).toEqual([changedMessage(['notes.md'])]);
    expect(strict).toThrow(changedMessage(['notes.md']));
    // A file of the kind a person adds, while the tests ran: said there, failed on under CI.
    put(join(repo, 'test', 'b.test.ts'));
    expect(lax).not.toThrow();
    expect(warned).toEqual([changedMessage(['notes.md']), addedMessage(['test/b.test.ts']), changedMessage(['notes.md'])]);
    expect(strict).toThrow(checkoutMessage(['test/b.test.ts']));
    // What tests leave fails the run everywhere: a dot-named project, an ignored cache.
    put(join(repo, 'test', '.tmp-repair-4242-1', 'agent.mjs'));
    put(join(repo, 'guard', '__pycache__', 'hook.cpython-312.pyc'));
    expect(lax).toThrow(checkoutMessage(['guard/__pycache__/', 'test/.tmp-repair-4242-1/']));
    expect(checkoutMessage(['test/.tmp-repair-4242-1/'])).toBe('tests left files in the checkout: test/.tmp-repair-4242-1/. A test writes in a temporary folder of its own, with links to the packages what it runs imports (testing/temp-project.mjs); remove these.');
    expect(addedMessage(['test/b.test.ts'])).toBe('files appeared in the checkout while the tests ran: test/b.test.ts. If a test left them, it writes in a temporary folder of its own instead (testing/temp-project.mjs).');
  });

  it('says which project an earlier run left, and leaves a folder that is no git checkout alone', () => {
    const repo = repository();
    put(join(repo, 'test', '.tmp-fixes-1-0', 'agent.mjs'));
    const warned: string[] = [];
    expect(check([], (line) => warned.push(line), { root: repo })).not.toThrow();
    expect(warned).toEqual(['test/.tmp-fixes-1-0/ is there from before this run, a project a test made in the checkout and never removed. Remove it.']);
    const plain = mkdtempSync(join(dir, 'plain-'));
    expect(checkoutStatus(plain)).toBeNull();
    expect(check([], () => {}, { root: plain })).not.toThrow();
  });

  it('counts a part of a path as an output by its name', () => {
    expect(['node_modules/', 'packages/cli/dist/', 'packages/cli/tsconfig.tsbuildinfo', 'testing/frameworks/node_modules/', 'sdks/python/build/', 'sdks/python/shadowlap.egg-info/', 'vitest-junit.xml', 'coverage/'].filter((p) => !isOutput(p))).toEqual([]);
    expect(['packages/cli/test/.tmp-fixes-1-0/', 'packages/cli/guard/__pycache__/', '.shadowlap/', 'packages/cli/test/distant.ts', 'sdks/python/.pytest_cache/'].filter(isOutput)).toEqual([]);
  });

  it('leaves the checkout to a run in watch mode, where files change as you edit, and runs Python without bytecode', () => {
    expect(setupOptions({ config: { watch: true } })).toEqual({ root: null });
    expect(setupOptions({ config: { watch: false } })).toEqual({});
    expect(setupOptions()).toEqual({});
    // The suite's own processes, and what the framework tests' wrapper runs.
    expect(process.env.PYTHONDONTWRITEBYTECODE).toBe('1');
    const env = spawnSync(process.execPath, [SCRIPT, '--watch', join(dir, 'env', '.shadowlap'), 'node', '-e', 'process.exit(process.env.PYTHONDONTWRITEBYTECODE === "1" ? 0 : 5)'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '' } });
    expect(env.status, env.stderr).toBe(0);
  });
});
