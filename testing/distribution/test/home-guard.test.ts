import { exec, execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonical, childProblem, realShadowlapFolders, takeRefused, writeProblem } from '../../home-guard.mjs';

/**
 * A run of the tests started at the root, in a suite's folder or in its test folder writes nothing in
 * the real home folder's shadowlap files: it has the one setup, a home of its own for each test file
 * and the guard (testing/home-guard.mjs), which refuses a write there, or a process started to keep
 * them there, and fails the test. Vitest reads no config but the one in the folder it starts in, so a
 * run started anywhere else has neither.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

let dir: string;
/** A stand-in for the real home folder, with its .shadowlap, and that folder's real shadowlap folders as the guard takes them. */
let standIn: string;
let real: string[];
/** A shadowlap home of a test's own, as the setup gives each file. */
let own: string;
/** A link to the stand-in's .shadowlap. */
let link: string;
beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-home-guard-')));
  standIn = join(dir, 'home');
  mkdirSync(join(standIn, '.shadowlap'), { recursive: true });
  real = realShadowlapFolders([standIn]);
  own = join(dir, 'own-home');
  mkdirSync(own);
  link = join(dir, 'link-to-shadowlap');
  symlinkSync(join(standIn, '.shadowlap'), link, process.platform === 'win32' ? 'junction' : undefined);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the guard against the real home's shadowlap files", () => {
  it('refuses a write there however its path is spelt: through a link, with a trailing slash or .., or relative to the working folder', () => {
    const spelt = [
      join(standIn, '.shadowlap', 'checks-seen.json'),
      `${join(standIn, '.shadowlap')}/`,
      join(standIn, 'elsewhere', '..', '.shadowlap', 'agents', '4242.json'),
      join(link, 'projects.json'),
      relative(process.cwd(), join(standIn, '.shadowlap', 'mcp')),
      join(standIn, '.shadowlap', 'not', 'there', 'yet.json'),
    ];
    for (const path of spelt) expect(writeProblem(path, { env: { SHADOWLAP_HOME: own }, home: standIn, real }), path).toMatch(/^a test wrote in the real home folder's shadowlap files/);
    expect(canonical(join(link, 'a', '..', 'b.json'))).toBe(join(standIn, '.shadowlap', 'b.json'));
    expect(writeProblem(join(link, 'projects.json'), { env: { SHADOWLAP_HOME: own }, home: standIn, real })).toBe(
      `a test wrote in the real home folder's shadowlap files (${real[0]}): ${join(link, 'projects.json')}. A test keeps them in its file's own SHADOWLAP_HOME, which the setup sets and process.env carries, or in a folder of its own.`,
    );
    for (const path of [join(own, 'checks-seen.json'), join(standIn, 'projects.json'), join(standIn, '.shadowlap-other', 'x.json')]) {
      expect(writeProblem(path, { env: { SHADOWLAP_HOME: own }, home: standIn, real }), path).toBeNull();
    }
  });

  it("refuses a write in the home an environment names while SHADOWLAP_HOME is unset, blank or relative, which shadowlap ignores, and allows one in a home of the test's own", () => {
    const home = join(dir, 'another-home');
    const there = join(home, '.shadowlap', 'checks-seen.json');
    expect(writeProblem(there, { env: {}, home, real })).toBe(
      `a test wrote in shadowlap's home folder with SHADOWLAP_HOME unset: ${there}. A test keeps its file's own SHADOWLAP_HOME, which the setup sets, or sets a folder of its own.`,
    );
    expect(writeProblem(there, { env: { SHADOWLAP_HOME: '  ' }, home, real })).toMatch(/with SHADOWLAP_HOME unset:/);
    expect(writeProblem(there, { env: { SHADOWLAP_HOME: 'relative/home' }, home, real })).toMatch(/with SHADOWLAP_HOME set to relative\/home, which isn't an absolute path:/);
    expect(writeProblem(there, { env: { SHADOWLAP_HOME: own }, home, real })).toBeNull();
    expect(writeProblem(join(home, 'notes.md'), { env: {}, home, real })).toBeNull();
  });

  it("refuses a process that would keep shadowlap's files there, and starts one given the run's SHADOWLAP_HOME or a HOME of its own", () => {
    const refused = [{ HOME: standIn }, { HOME: standIn, SHADOWLAP_HOME: `${join(standIn, '.shadowlap')}/` }, { HOME: standIn, SHADOWLAP_HOME: '~/.shadowlap' }, { HOME: standIn, SHADOWLAP_HOME: link }, { HOME: standIn, SHADOWLAP_HOME: 'relative' }];
    for (const env of refused) expect(childProblem(env, { real, platform: 'linux' }), JSON.stringify(env)).not.toBeNull();
    expect(childProblem({ HOME: standIn, SHADOWLAP_HOME: link }, { command: 'node', real, platform: 'linux' })).toBe(
      `a test started node with SHADOWLAP_HOME ${link}, so shadowlap there would keep this machine's files in the real home folder's (${real[0]}). Pass it the run's SHADOWLAP_HOME, which process.env carries, or a HOME of its own.`,
    );
    expect(childProblem({ HOME: standIn, SHADOWLAP_HOME: 'relative' }, { command: 'node', real, platform: 'linux' })).toMatch(/^a test started node with HOME .+ and SHADOWLAP_HOME set to relative, which isn't an absolute path, so shadowlap there/);
    expect(childProblem({ HOME: standIn, SHADOWLAP_HOME: own }, { real, platform: 'linux' })).toBeNull();
    expect(childProblem({ HOME: join(dir, 'another-home') }, { real, platform: 'linux' })).toBeNull();
    // Windows: Node takes the home folder from USERPROFILE there.
    expect(childProblem({ USERPROFILE: standIn, HOME: join(dir, 'another-home') }, { real, platform: 'win32' })).not.toBeNull();
    expect(childProblem({ USERPROFILE: join(dir, 'another-home'), HOME: standIn }, { real, platform: 'win32' })).toBeNull();
    // With no HOME, Node takes the system's record of the user's home folder: the real one, never a stand-in.
    expect(childProblem({ PATH: process.env.PATH }, { command: 'node', platform: 'linux' })).toMatch(/^a test started node with HOME unset and SHADOWLAP_HOME unset, so shadowlap there would keep this machine's files in the real home folder's/);
    expect(childProblem({ PATH: process.env.PATH, SHADOWLAP_HOME: own }, { platform: 'linux' })).toBeNull();
  });

  it('refuses such a process started through util.promisify(execFile) or (exec) as through the call itself, and keeps the refusal for the test', async () => {
    /** What a promise of a started process came to: the message it was refused with, or that it ran. */
    const outcome = (started: Promise<unknown>) => started.then(() => 'ran', (err: unknown) => (err as Error).message);
    const env = { PATH: process.env.PATH };
    const refused = /^a test started .+ with (HOME|USERPROFILE) unset and SHADOWLAP_HOME unset, so shadowlap there would keep this machine's files in the real home folder's/;
    const byExecFile = await outcome(promisify(execFile)(process.execPath, ['-e', ''], { env }));
    expect(byExecFile).toMatch(refused);
    const byExec = await outcome(promisify(exec)(`"${process.execPath}" -e ""`, { env }));
    expect(byExec).toMatch(refused);
    expect(takeRefused()).toEqual([byExecFile, byExec]);
    // Given the run's SHADOWLAP_HOME, which process.env carries, it starts, and resolves as Node's own does.
    const started = promisify(execFile)(process.execPath, ['-e', 'process.stdout.write("ran")']);
    expect(started.child.pid).toEqual(expect.any(Number));
    await expect(started).resolves.toEqual({ stdout: 'ran', stderr: '' });
  });
});

describe("a run of the tests started at the root, in a suite's folder or in its test folder", () => {
  /** What every folder that holds a suite has, so that a run started in it has the root's setup. */
  const POINTER = [
    '// A run started in this folder (npx vitest run test/<file>) has the setup of a run started at the',
    "// repository's root, in vitest.config.ts there, for the tests in this folder.",
    "import { testsIn } from '../../vitest.config.ts';",
    '',
    'export default testsIn(import.meta.dirname);',
    '',
  ].join('\n');
  /** What the suite's test folder has, which holds its tests: the same, given the suite's folder. */
  const TEST_POINTER = [
    '// A run started in this folder (npx vitest run <file>) has the setup of a run started at the',
    "// repository's root, in vitest.config.ts there, for the tests in this folder.",
    "import { dirname } from 'node:path';",
    "import { testsIn } from '../../../vitest.config.ts';",
    '',
    'export default testsIn(dirname(import.meta.dirname));',
    '',
  ].join('\n');

  it("has the root's setup, which each suite's folder and its test folder pass the suite's folder to", () => {
    const suites = ['packages', 'testing'].flatMap((top) =>
      readdirSync(join(ROOT, top), { withFileTypes: true }).flatMap((e) => (e.isDirectory() && existsSync(join(ROOT, top, e.name, 'test')) ? [join(top, e.name)] : [])),
    );
    expect(suites.length).toBeGreaterThanOrEqual(15);
    for (const suite of suites) {
      expect(readFileSync(join(ROOT, suite, 'vitest.config.mjs'), 'utf8'), suite).toBe(POINTER);
      expect(readFileSync(join(ROOT, suite, 'test', 'vitest.config.mjs'), 'utf8'), join(suite, 'test')).toBe(TEST_POINTER);
    }
    const root = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    for (const setup of ["globalSetup: ['./testing/no-stray-stores.mjs']", "setupFiles: ['./testing/file-home.mjs']", 'root: ROOT', 'export default testsIn();']) expect(root).toContain(setup);
  });

  /** A run of Vitest started in `folder` on `args`, with HOME the stand-in and no shadowlap home or run of the outer one's: what it said, and how it ended. */
  function vitestIn(folder: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    const outer = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VITEST|SHADOWLAP_HOME$|SHADOWLAP_TESTS_HOME$|CI$|FORCE_COLOR$)/.test(k)));
    const r = spawnSync(process.execPath, [VITEST, 'run', ...args], { cwd: folder, encoding: 'utf8', env: { ...outer, HOME: standIn, USERPROFILE: standIn, NO_COLOR: '1', ...env }, timeout: 120_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it("keeps what the dashboard writes for this machine in a temporary home in a run started in its folder, and nothing in the home folder's", { timeout: 150_000 }, () => {
    const report = join(dir, 'home-used.txt');
    const r = vitestIn(join(ROOT, 'packages', 'dashboard'), ['test/own-home.test.ts', '-t', "go in the test file's own"], { SHADOWLAP_HOME_REPORT: report });
    expect(r.status, r.out).toBe(0);
    const used = readFileSync(report, 'utf8');
    expect(isAbsolute(used), used).toBe(true);
    expect(used.startsWith(realpathSync.native(tmpdir())), used).toBe(true);
    // The run's home is removed with the run, and the stand-in's .shadowlap is as it was: empty.
    expect(existsSync(used)).toBe(false);
    expect(readdirSync(join(standIn, '.shadowlap'))).toEqual([]);
  });

  it("fails a run started in the dashboard's test folder when a test writes in the real home's .shadowlap, which the guard keeps as it was", { timeout: 150_000 }, () => {
    const r = vitestIn(join(ROOT, 'packages', 'dashboard', 'test'), ['own-home.test.ts', '-t', 'fail the run that writes them'], { SHADOWLAP_STAND_IN_HOME: standIn });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`a test wrote in the real home folder's shadowlap files (${real[0]}): ${join(standIn, '.shadowlap')}`);
    expect(readdirSync(join(standIn, '.shadowlap'))).toEqual([]);
  });
});
