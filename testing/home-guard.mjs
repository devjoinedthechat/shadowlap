// No test writes in the real home folder's Shadowlap files (~/.shadowlap), however it reaches them.
// Shadowlap keeps this machine's files in SHADOWLAP_HOME, else ~/.shadowlap, and the setup gives
// each test file a home of its own, a temporary folder (file-home.mjs). This guard, which that setup
// installs in every test file's process, holds the rest to it:
//
// - A write in the real home's .shadowlap is refused, wherever its path leads there from: through a
//   link, with a trailing slash or `..`, or relative to the working folder. So is one in the Shadowlap
//   home a process's environment names while SHADOWLAP_HOME is unset, or set to a relative path,
//   which Shadowlap ignores. Node's calls that write, make, move or remove a file check their paths
//   before they run, the test's own and those of the Shadowlap code it runs.
// - A process a test starts is refused when Shadowlap in it would keep its files in the real home's:
//   its SHADOWLAP_HOME leads there, or it has none and its HOME (USERPROFILE on Windows) is the real
//   home folder, or unset. One given the run's SHADOWLAP_HOME, which process.env carries, or a HOME
//   of its own, starts.
//
// A refusal throws where it happened, and is kept for the test it happened in, which then fails
// (file-home.mjs), even when the code that met it went on without the file. The real home folder is
// the user's own, as the system records it, and HOME as the test file's process started.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** The user's home folder as the system records it, whatever HOME says; HOME's when there is no such record. */
function systemHome() {
  try {
    return userInfo().homedir || homedir();
  } catch {
    return homedir();
  }
}

/** The home folders of the user the tests run as: HOME (USERPROFILE on Windows) as this process found it, and the system's record of it. */
export function realHomes() {
  return [...new Set([homedir(), systemHome()])].filter(Boolean);
}

/** A path as the file system finds it: absolute, and each link on the way followed, as far as the path exists. */
export function canonical(path) {
  const rest = [];
  for (let at = resolve(path); ; ) {
    try {
      return join(fs.realpathSync.native(at), ...rest);
    } catch {
      const up = dirname(at);
      if (up === at) return resolve(path);
      rest.unshift(basename(at));
      at = up;
    }
  }
}

/** Whether `path` is `folder` or inside it, both as the file system finds them. */
function within(path, folder) {
  const rel = relative(folder, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The real home's Shadowlap folders, `homes`' .shadowlap, as the file system finds them. */
export function realShadowlapFolders(homes = realHomes()) {
  return [...new Set(homes.map((home) => canonical(join(home, '.shadowlap'))))];
}

/**
 * Shadowlap's folder for this machine's files in `env`, with `home` the home folder, as the engine
 * finds it (projects/paths.ts): SHADOWLAP_HOME when it is an absolute path or one from `~`, else
 * <home>/.shadowlap. `named` says whether SHADOWLAP_HOME named it.
 */
export function shadowlapHomeIn(env, home) {
  const explicit = env.SHADOWLAP_HOME?.trim() ?? '';
  const expanded = explicit === '~' ? home : /^~[/\\]/.test(explicit) ? join(home, explicit.slice(2)) : explicit;
  return expanded && isAbsolute(expanded) ? { dir: resolve(expanded), named: true } : { dir: join(home, '.shadowlap'), named: false };
}

/** SHADOWLAP_HOME as a message names it: unset, or the value Shadowlap ignores. */
const unnamed = (env) => (env.SHADOWLAP_HOME?.trim() ? `set to ${env.SHADOWLAP_HOME}, which isn't an absolute path` : 'unset');

/**
 * Why a write to `path` is refused, in a process with environment `env` and home folder `home`: it
 * is in one of the `real` home's Shadowlap folders, or in the home `env` names while SHADOWLAP_HOME
 * is unset or ignored. Null when it may go ahead.
 */
export function writeProblem(path, { env = process.env, home = homedir(), real = realShadowlapFolders() } = {}) {
  const at = canonical(path);
  const hit = real.find((folder) => within(at, folder));
  if (hit) return `a test wrote in the real home folder's Shadowlap files (${hit}): ${path}. A test keeps them in its file's own SHADOWLAP_HOME, which the setup sets and process.env carries, or in a folder of its own.`;
  const own = shadowlapHomeIn(env, home);
  if (!own.named && within(at, canonical(own.dir))) return `a test wrote in Shadowlap's home folder with SHADOWLAP_HOME ${unnamed(env)}: ${path}. A test keeps its file's own SHADOWLAP_HOME, which the setup sets, or sets a folder of its own.`;
  return null;
}

/**
 * Why a process `command` with environment `env` is refused: Shadowlap in it would keep this
 * machine's files in one of the `real` home's Shadowlap folders. Its home folder is HOME
 * (USERPROFILE on Windows), else the system's record of it. Null when they would go elsewhere.
 */
export function childProblem(env, { command = 'a process', real = realShadowlapFolders(), platform = process.platform } = {}) {
  const name = platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const own = shadowlapHomeIn(env, env[name] || systemHome());
  const hit = real.find((folder) => within(canonical(own.dir), folder));
  if (!hit) return null;
  const given = own.named ? `SHADOWLAP_HOME ${env.SHADOWLAP_HOME}` : `${name} ${env[name] || 'unset'} and SHADOWLAP_HOME ${unnamed(env)}`;
  return `a test started ${command} with ${given}, so Shadowlap there would keep this machine's files in the real home folder's (${hit}). Pass it the run's SHADOWLAP_HOME, which process.env carries, or a HOME of its own.`;
}

/**
 * The guard in this process: whether it is installed, and what it refused that takeRefused hasn't
 * said yet. Kept on globalThis, as Node's calls it guards are: a process that runs another test
 * file loads this module afresh, and the calls installed before keep their refusals here.
 */
const state = (globalThis[Symbol.for('shadowlap.tests.homeGuard')] ??= { installed: false, refused: [] });

/** What was refused since this was last called, oldest first: each is said once. */
export function takeRefused() {
  return state.refused.splice(0);
}

/** A refusal: kept for the test it happened in, and thrown (or rejected) where it happened. */
function refusal(problem) {
  state.refused.push(problem);
  return new Error(problem);
}

/**
 * Node's calls that change what is at a path, with the place of each path they change among their
 * arguments: what they write, make, move or remove. Each is also checked as its Sync form and in
 * fs.promises.
 */
const CHANGES = { appendFile: [0], chmod: [0], chown: [0], copyFile: [1], cp: [1], lchown: [0], link: [1], lutimes: [0], mkdir: [0], mkdtemp: [0], open: [0], rename: [0, 1], rm: [0], rmdir: [0], symlink: [1], truncate: [0], unlink: [0], utimes: [0], writeFile: [0] };
/** Node's calls that start a process, each with its environment among its options. */
const STARTS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];
const WRITING = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;

/** Whether an open's flags (a string, a number, or none: `r`) let it write. */
const writes = (flags) => (typeof flags === 'number' ? (flags & WRITING) !== 0 : typeof flags === 'string' && /[wa+]/.test(flags));

/** A path argument as a string; null for a file descriptor, a file handle, or what no call takes as a path. */
function pathOf(arg) {
  if (typeof arg === 'string') return arg;
  if (Buffer.isBuffer(arg)) return arg.toString();
  try {
    return arg instanceof URL ? fileURLToPath(arg) : null;
  } catch {
    return null;
  }
}

/** `call`, which first asks `check` for a refusal: thrown, or for a call that returns a promise, rejected. */
const checked = (call, check, promised) => (...args) => {
  const stop = check(args);
  if (!stop) return call(...args);
  if (promised) return Promise.reject(stop);
  throw stop;
};

/**
 * Replaces `target[name]` with the same call, which first asks `check` for a refusal. It keeps what
 * the call carries, but for the promise util.promisify makes of it (execFile's and exec's): Node's
 * starts the original call, past the check. So the guarded call has its own, which checks first and
 * then is Node's, resolved with stdout and stderr.
 */
function guard(target, name, check, promised = false) {
  const original = target[name];
  if (typeof original !== 'function') return;
  const carried = Object.getOwnPropertyDescriptors(original);
  const custom = original[promisify.custom];
  if (typeof custom === 'function') carried[promisify.custom] = { ...carried[promisify.custom], value: checked(custom, check, true) };
  target[name] = Object.defineProperties(checked(original, check, promised), carried);
}

/**
 * Installs the guard in this process, once: Node's calls that change a file, and those that start a
 * process, refuse what would reach the real home's Shadowlap files. The real home is taken now,
 * before a test could change HOME.
 */
export function guardHome() {
  if (state.installed) return;
  state.installed = true;
  const real = realShadowlapFolders();
  const written = (paths) => {
    for (const path of paths.map(pathOf)) {
      const problem = path === null ? null : writeProblem(path, { real });
      if (problem) return refusal(problem);
    }
    return null;
  };
  for (const [name, at] of Object.entries(CHANGES)) {
    const check = (args) => (name === 'open' && !writes(typeof args[1] === 'function' ? undefined : args[1]) ? null : written(at.map((i) => args[i])));
    guard(fs, name, check);
    guard(fs, `${name}Sync`, check);
    guard(fs.promises, name, check, true);
  }
  guard(fs, 'createWriteStream', (args) => written([args[0]]));
  for (const name of STARTS) {
    guard(childProcess, name, (args) => {
      const options = args.slice(1).find((a) => a !== null && typeof a === 'object' && !Array.isArray(a));
      const problem = childProblem(options?.env ?? process.env, { command: String(args[0]), real });
      return problem ? refusal(problem) : null;
    });
  }
  // What modules imported by name (import { writeFileSync } from 'node:fs') call is the guarded call too.
  syncBuiltinESMExports();
}
