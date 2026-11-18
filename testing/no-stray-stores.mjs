// No test leaves anything in the checkout, or in the real home's shadowlap files. Around the whole run:
//
// - No .shadowlap folder where the suites run: the repository's root, where Vitest runs, and
//   testing/frameworks, where the framework tests do. A test keeps its store and the active-run file
//   that run and replay write in a temporary folder of its own (--db, and the cwd it runs the CLI
//   in). What these folders hold is compared entry by entry (time and size), so a test that writes
//   into one that was there before is caught too.
// - Nothing new in the checkout as git sees it: `git status --porcelain --ignored` after the run lists
//   nothing it didn't before, but build outputs (dist, node_modules, *.tsbuildinfo), the test reports
//   and what the system writes of its own (.DS_Store). A project a test made inside the repository
//   (testing/temp-project.mjs makes them in the temporary folder), a script written next to a test,
//   Python's __pycache__ (the suites run with PYTHONDONTWRITEBYTECODE=1): each fails the run. Under
//   CI, where nothing else touches the checkout, so does anything else new, and a tracked file that
//   changed. Elsewhere those two are said, not failed on: whoever runs the tests may be editing, or
//   adding a file, while they run. What tests leave is ignored by git or named with a dot.
// - A shadowlap home of the run's own: SHADOWLAP_HOME, which every process the run starts inherits, is
//   a temporary folder, removed after the run. So the project list, the agents commands register
//   while they run and the proxies `mcp --listen` registers go there, never in the real ~/.shadowlap.
//   Vitest gives each test file a folder of its own in it (file-home.mjs). HOME stays as it is: uv
//   keeps its caches there.
// - Nothing written in the real ~/.shadowlap: what it holds is compared before and after the run, as
//   the .shadowlap folders above are. The owner's own shadowlap writes there while the tests run too
//   (a dashboard keeps its project list, an agent of theirs is registered and removed), and nothing
//   tells its writes from a test's: they are the same files, and a test's are gone by the end, the
//   folder's time all that is left of them. So, as with a file a person adds to the checkout, a
//   change there fails the run under CI, where nothing else runs shadowlap, and is said elsewhere.
//
// As Vitest's global setup (vitest.config.ts) it notes them before the tests and fails the run on
// what appeared or changed after, but for the checkout and the real home in watch mode, where files
// change as you edit and your own shadowlap runs beside it. Run as a script, it does the same around
// a command: `node ../no-stray-stores.mjs node --test …` (testing/frameworks/package.json), or with
// `--watch <dir>` (repeatable) before the command, around those folders alone.
import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The folders watched: a .shadowlap in each place a suite runs from. */
export const WATCHED = [join(ROOT, '.shadowlap'), join(ROOT, 'testing', 'frameworks', '.shadowlap')];

/** The real home's shadowlap folder, the owner's: watched around the suites, which keep their files in a home of their own. */
export const REAL_HOME = join(homedir(), '.shadowlap');

/**
 * A shadowlap home of the run's own: a temporary folder, set as SHADOWLAP_HOME in this process's
 * environment, which every process it starts inherits, and as SHADOWLAP_TESTS_HOME, where each test
 * file makes its own (file-home.mjs). `remove` takes the folder away, and puts back what both were.
 */
export function ownHome() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shadowlap-tests-home-')));
  const was = { SHADOWLAP_HOME: process.env.SHADOWLAP_HOME, SHADOWLAP_TESTS_HOME: process.env.SHADOWLAP_TESTS_HOME };
  process.env.SHADOWLAP_HOME = dir;
  process.env.SHADOWLAP_TESTS_HOME = dir;
  return {
    dir,
    remove() {
      for (const [name, value] of Object.entries(was)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/**
 * Nothing a test forgets to point at a mock reaches a real model API: the base-URL providers'
 * upstreams default to a closed local port for the run, so such a call fails here instead of being
 * sent, with whatever key it carries, to the provider. A test that sets its own upstream keeps it.
 * `remove` puts back what each was.
 */
export function closedUpstreams() {
  const names = ['SHADOWLAP_UPSTREAM_ANTHROPIC', 'SHADOWLAP_UPSTREAM_OPENAI', 'SHADOWLAP_UPSTREAM_GEMINI'];
  const was = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) if (!process.env[n]) process.env[n] = 'http://127.0.0.1:9';
  return {
    remove() {
      for (const n of names) {
        if (was[n] === undefined) delete process.env[n];
        else process.env[n] = was[n];
      }
    },
  };
}

/** A folder's entries, itself included, as `path -> mtime:size`, to a depth of 3 and at most 1,000; null when it isn't there. */
function listing(dir) {
  let top;
  try {
    top = lstatSync(dir);
  } catch {
    return null;
  }
  const out = new Map([['.', `${top.mtimeMs}:${top.size}`]]);
  const walk = (at, depth) => {
    let names;
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (out.size >= 1000) return;
      const path = join(at, name);
      try {
        const st = lstatSync(path);
        // By its path in the folder with / between its parts, as messages name it, on Windows too.
        out.set(relative(dir, path).split(sep).join('/'), `${st.mtimeMs}:${st.size}`);
        if (st.isDirectory() && depth < 3) walk(path, depth + 1);
      } catch {
        // gone while it was read
      }
    }
  };
  if (top.isDirectory()) walk(dir, 1);
  return out;
}

/** What each of `dirs` holds now. */
export function snapshot(dirs = WATCHED) {
  return new Map(dirs.map((dir) => [dir, listing(dir)]));
}

/** A folder as a message names it: from the repository's root when it is inside it. */
const shown = (dir) => (dir.startsWith(ROOT) ? relative(ROOT, dir) : dir);

/** What appeared or changed in the folders of `before` since, by path. */
export function strays(before, after = snapshot([...before.keys()])) {
  const found = [];
  for (const [dir, was] of before) {
    const now = after.get(dir) ?? null;
    if (!now) continue;
    const name = shown(dir);
    if (!was) {
      found.push(`${name}/ (${[...now.keys()].filter((k) => k !== '.').join(', ') || 'empty'})`);
      continue;
    }
    found.push(...[...now].filter(([path, stamp]) => was.get(path) !== stamp).map(([path]) => (path === '.' ? `${name}/` : `${name}/${path}`)));
  }
  return found;
}

/** Why the run fails, naming what the tests left. */
export function straysMessage(found) {
  return `tests left shadowlap files where the suites run: ${found.join('; ')}. Run the CLI in a temporary folder (cwd) with a store of its own (--db), and remove these.`;
}

/** Folder and file names that are build outputs, test reports or the system's own: what a run that left nothing may still add. */
const OUTPUTS = new Set(['node_modules', 'dist', 'coverage', 'vitest-junit.xml', 'shadowlap-junit.xml', '.DS_Store', 'Thumbs.db']);

/** Whether a path git lists (from the root, with / between parts) is an output: by any of its parts, or the Python SDK's build folder. */
export function isOutput(path) {
  const parts = path.replace(/\/$/, '').split('/');
  return parts.some((part) => OUTPUTS.has(part) || part.endsWith('.tsbuildinfo') || part.endsWith('.egg-info')) || posix.normalize(path).startsWith('sdks/python/build/');
}

/**
 * The checkout as git sees it: each entry `git status --porcelain --ignored` lists, as `path -> XY`
 * (`??` untracked, `!!` ignored, otherwise a tracked file's state), outputs left out; null where
 * `root` is no git checkout or git can't be run. It takes no lock, so it never holds up a git
 * command that runs meanwhile.
 */
export function checkoutStatus(root = ROOT) {
  let out;
  try {
    out = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
  const entries = new Map();
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    // A rename or a copy is followed by the path it came from.
    if (/[RC]/.test(xy)) i++;
    const path = field.slice(3);
    if (!isOutput(path)) entries.set(path, xy);
  }
  return entries;
}

/** What is new in the checkout since `before`: what appeared, untracked or ignored, and the tracked files whose state changed. */
export function leftInCheckout(before, after) {
  const left = [];
  const changed = [];
  for (const [path, xy] of after) {
    if (before.get(path) === xy) continue;
    (xy === '??' || xy === '!!' ? left : changed).push(path);
  }
  return { left: left.sort(), changed: changed.sort() };
}

/** Why the run fails, naming what appeared in the checkout. */
export function checkoutMessage(left) {
  return `tests left files in the checkout: ${left.join(', ')}. A test writes in a temporary folder of its own, with links to the packages what it runs imports (testing/temp-project.mjs); remove these.`;
}

/** What is said, or under CI failed on, when a tracked file changed during the run. */
export function changedMessage(changed) {
  return `tracked files changed while the tests ran: ${changed.join(', ')}. A test changes a copy, never the checkout.`;
}

/** What is said, outside CI, of a new file of the kind a person adds: neither ignored by git nor named with a dot. */
export function addedMessage(added) {
  return `files appeared in the checkout while the tests ran: ${added.join(', ')}. If a test left them, it writes in a temporary folder of its own instead (testing/temp-project.mjs).`;
}

/** Why the run fails under CI, naming what changed in the real home's shadowlap folder. */
export function homeMessage(found) {
  return `tests wrote in the real home folder's shadowlap files: ${found.join('; ')}. A test runs the CLI with the run's own SHADOWLAP_HOME, which process.env carries, or a folder of its own, never with the real home.`;
}

/** What is said outside CI, where the owner's own shadowlap may have written there while the tests ran. */
export function homeChangedMessage(found) {
  return `shadowlap files changed in the real home folder while the tests ran: ${found.join('; ')}. Unless a shadowlap of yours wrote them (a dashboard, an agent, a proxy), a test did: it runs the CLI with the run's own SHADOWLAP_HOME, which process.env carries, or a folder of its own.`;
}

/** Whether what git lists is the kind a test leaves, not a person: ignored by git (a cache, a store), or named with a dot (a project, a script). */
const testLike = (path, xy) => xy === '!!' || posix.basename(path.replace(/\/$/, '')).startsWith('.');

/**
 * The check around a run of tests: what the folders `dirs` and the checkout at `root` hold now, with
 * a warning for each such folder there already (a command run where the suites run left it, and a
 * test that runs the CLI in a folder inside the repository finds it as its store) and for a project
 * an earlier run left in the checkout, and the teardown that fails on what the tests left. `strict`
 * (the default under CI) fails on anything new and on a tracked file changed, where otherwise a new
 * file of the kind a person adds, and a tracked file changed, are warnings. `root: null` leaves the
 * checkout out. `home`, the real home's shadowlap folder (REAL_HOME) to watch, is compared as `dirs`
 * are: what changed there fails under `strict` and is said otherwise (see the top of this file).
 */
export function check(dirs = WATCHED, warn = (line) => console.warn(line), { root = ROOT, home = null, strict = !!process.env.CI } = {}) {
  const before = snapshot(dirs);
  const homeBefore = home === null ? null : snapshot([home]);
  for (const [dir, held] of before) if (held) warn(`${shown(dir)}/ is there from before this run, left by a shadowlap command run there: a test that runs the CLI in a folder inside the repository finds it as its project's store. Remove it.`);
  const checkout = root === null ? null : checkoutStatus(root);
  for (const [path, xy] of checkout ?? []) {
    if ((xy === '??' || xy === '!!') && posix.basename(path.replace(/\/$/, '')).startsWith('.tmp-')) warn(`${path} is there from before this run, a project a test made in the checkout and never removed. Remove it.`);
  }
  return () => {
    const found = strays(before);
    const problems = found.length ? [straysMessage(found)] : [];
    const now = checkout ? checkoutStatus(root) : null;
    if (checkout && now) {
      const { left, changed } = leftInCheckout(checkout, now);
      const failing = strict ? left : left.filter((path) => testLike(path, now.get(path)));
      const added = left.filter((path) => !failing.includes(path));
      if (failing.length) problems.push(checkoutMessage(failing));
      if (added.length) warn(addedMessage(added));
      if (changed.length && strict) problems.push(changedMessage(changed));
      else if (changed.length) warn(changedMessage(changed));
    }
    const touched = homeBefore ? strays(homeBefore) : [];
    if (touched.length && strict) problems.push(homeMessage(touched));
    else if (touched.length) warn(homeChangedMessage(touched));
    if (problems.length) throw new Error(problems.join('\n'));
  };
}

/** What the check around a Vitest run covers, given the project Vitest runs: the checkout and the real home too, but in watch mode. */
export function setupOptions(project) {
  return project?.config?.watch ? { root: null } : { home: REAL_HOME };
}

/** Vitest's global setup (its argument is the project Vitest runs): a shadowlap home of the run's own, and the check around the whole run. */
export default function setup(project) {
  const home = ownHome();
  const upstreams = closedUpstreams();
  const teardown = check(WATCHED, undefined, setupOptions(project));
  return () => {
    try {
      teardown();
    } finally {
      upstreams.remove();
      home.remove();
    }
  };
}

// As a script: the command after it, then the same check, ending with the command's status, or 1.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dirs = [];
  while (args[0] === '--watch' && args.length > 1) dirs.push(args.splice(0, 2)[1]);
  const [command, ...rest] = args;
  if (!command) {
    process.stderr.write('usage: node no-stray-stores.mjs [--watch <dir>]... <command> [args...]\n');
    process.exit(2);
  }
  // The command and what it starts keep shadowlap's files in a home of the run's own.
  const home = ownHome();
  closedUpstreams();
  // Folders given with --watch are checked alone; around the suites, the checkout and the real home are checked too.
  const teardown = check(dirs.length ? dirs : WATCHED, (line) => process.stderr.write(`! ${line}\n`), dirs.length ? { root: null } : { home: REAL_HOME });
  // Python writes no __pycache__ into the checkout for what the tests import (the SDK, the guard).
  const child = spawn(command === 'node' ? process.execPath : command, rest, { stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  child.on('error', (err) => {
    home.remove();
    process.stderr.write(`no-stray-stores: ${command}: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    let left = false;
    try {
      teardown();
    } catch (err) {
      left = true;
      process.stderr.write(`\n✖ ${err.message}\n`);
    }
    home.remove();
    const status = code ?? (signal ? 1 : 0);
    process.exit(status !== 0 ? status : left ? 1 : 0);
  });
}
