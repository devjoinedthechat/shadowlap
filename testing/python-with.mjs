// A Python for the suite's Python tests, found one way for all of them: the vitest suites under
// packages/ and testing/, and the conformance run, which Node runs as it is. A test that needs one
// skips without it, but not under CI, which installs every package these tests ask for
// (.github/workflows/ci.yml): there a missing one is an install that broke, and the search throws,
// naming it, where the tests would skip and leave the run green. The framework suites find theirs
// with testing/frameworks/python.mjs, against what the frameworks workflow installs.
import { execFileSync } from 'node:child_process';

/** Packages CI doesn't install on a system, as none is made for it there: uvloop has no Windows build. */
const NOT_ON = { uvloop: 'win32' };

/** The interpreters a test may run, in the order they are tried: SHADOWLAP_PYTHON picks another. */
const interpreters = () => [process.env.SHADOWLAP_PYTHON, 'python3', 'python'].filter((cmd) => !!cmd);

/**
 * Whether `argv` starts a Python 3.9 or later (the oldest the SDK and the guard run on) that imports
 * every one of `modules`. Windows' python3, the Store's stand-in, exits with an error, as no Python.
 */
function imports(argv, modules) {
  const program = [...modules.map((m) => `import ${m}`), 'import sys', 'sys.exit(sys.version_info < (3, 9))'].join('; ');
  try {
    execFileSync(argv[0], [...argv.slice(1), '-c', program], { stdio: 'ignore', timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

/** Null, for the tests to skip on; under CI, which installs `modules` for them, a throw that names them. */
function missing(modules) {
  if (process.env.CI && !modules.some((m) => NOT_ON[m] === process.platform)) {
    const none = modules.length ? `no Python 3.9 or later here imports ${modules.join(', ')}` : 'no Python 3.9 or later is here';
    throw new Error(`${none}, which CI installs for these tests (.github/workflows/ci.yml): without it they would skip, and the run would pass with them left out`);
  }
  return null;
}

/**
 * The first of SHADOWLAP_PYTHON, python3 and python that is a Python 3.9 or later importing every one
 * of `modules` (import names, as `google.genai`), for a test that runs it as an agent's command; null
 * where none does, but a throw under CI.
 */
export function pythonCommand(...modules) {
  return interpreters().find((cmd) => imports([cmd], modules)) ?? missing(modules);
}

/**
 * A command that starts a Python 3.9 or later able to import every one of `packages` (their import
 * names are their package names here): one of the interpreters pythonCommand tries when it has them,
 * else uv, which fetches them for the run once and keeps them in its cache. Null where neither can,
 * but a throw under CI.
 */
export function pythonWith(...packages) {
  const names = packages.map((p) => p.replace(/-/g, '_'));
  const own = interpreters().find((cmd) => imports([cmd], names));
  if (own) return [own];
  const uv = ['uv', 'run', '--no-project', '--quiet', ...packages.flatMap((p) => ['--with', p]), 'python'];
  if (packages.length && imports(uv, names)) return uv;
  return missing(packages);
}
