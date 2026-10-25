// No test leaves a .shadowlap folder where the suites run: the repository's root, where Vitest runs,
// and testing/frameworks, where the framework tests do. A test keeps its store and the active-run
// file that run and replay write in a temporary folder of its own (--db, and the cwd it runs the CLI
// in). One left in the root is above the projects the tests make inside the repository
// (fixes.test.ts), whose commands then find it as their project's store, and it goes on growing.
//
// As Vitest's global setup (vitest.config.ts) it notes what the folders hold before the tests and
// fails the run on what appeared or changed in them after. Run as a script, it does the same around
// a command: `node ../no-stray-stores.mjs node --test …` (testing/frameworks/package.json), or with
// `--watch <dir>` (repeatable) before the command, around other folders.
import { spawn } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The folders watched: a .shadowlap in each place a suite runs from. */
export const WATCHED = [join(ROOT, '.shadowlap'), join(ROOT, 'testing', 'frameworks', '.shadowlap')];

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
        out.set(relative(dir, path), `${st.mtimeMs}:${st.size}`);
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
  return `tests left Shadowlap files where the suites run: ${found.join('; ')}. Run the CLI in a temporary folder (cwd) with a store of its own (--db), and remove these.`;
}

/**
 * The check around a run of tests in `dirs`: what they hold now, with a warning for each that is
 * there already (a command run where the suites run left it, and a test that runs the CLI in a folder
 * inside the repository finds it as its store), and the teardown that fails on what the tests left.
 */
export function check(dirs = WATCHED, warn = (line) => console.warn(line)) {
  const before = snapshot(dirs);
  for (const [dir, held] of before) if (held) warn(`${shown(dir)}/ is there from before this run, left by a shadowlap command run there: a test that runs the CLI in a folder inside the repository finds it as its project's store. Remove it.`);
  return () => {
    const found = strays(before);
    if (found.length) throw new Error(straysMessage(found));
  };
}

/** Vitest's global setup (its argument is Vitest's own): the check around the whole run. */
export default function setup() {
  return check();
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
  const teardown = check(dirs.length ? dirs : WATCHED, (line) => process.stderr.write(`! ${line}\n`));
  const child = spawn(command === 'node' ? process.execPath : command, rest, { stdio: 'inherit' });
  child.on('error', (err) => {
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
    const status = code ?? (signal ? 1 : 0);
    process.exit(status !== 0 ? status : left ? 1 : 0);
  });
}
