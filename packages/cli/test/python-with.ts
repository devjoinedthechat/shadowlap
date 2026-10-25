import { execFileSync } from 'node:child_process';

/** Packages CI doesn't install on a system, as none is made for it there: uvloop has no Windows build. */
const NOT_ON: Record<string, NodeJS.Platform> = { uvloop: 'win32' };

/**
 * A command that starts a Python able to import every one of `packages` (their import names are
 * their package names here), or null: SHADOWLAP_PYTHON, python3 or python when one has them, else
 * uv, which fetches them for the run once and keeps them in its cache. Tests that need one skip
 * without it, but not under CI, which installs every package these tests ask for
 * (.github/workflows/ci.yml): there a missing one is an install that broke, and it throws, naming
 * it, where the tests would skip and leave the run green.
 */
export function pythonWith(...packages: string[]): string[] | null {
  const imports = packages.length ? packages.map((p) => `import ${p.replace(/-/g, '_')}`).join('; ') : 'pass';
  const can = (argv: string[]) => {
    try {
      execFileSync(argv[0], [...argv.slice(1), '-c', imports], { stdio: 'ignore', timeout: 120_000 });
      return true;
    } catch {
      return false;
    }
  };
  for (const cmd of [process.env.SHADOWLAP_PYTHON, 'python3', 'python'].filter((c): c is string => !!c)) if (can([cmd])) return [cmd];
  const uv = ['uv', 'run', '--no-project', '--quiet', ...packages.flatMap((p) => ['--with', p]), 'python'];
  if (packages.length && can(uv)) return uv;
  if (process.env.CI && !packages.some((p) => NOT_ON[p] === process.platform)) {
    throw new Error(`no Python here imports ${packages.length ? packages.join(', ') : 'anything'}, which CI installs for these tests (.github/workflows/ci.yml): without it they would skip, and the run would pass with them left out`);
  }
  return null;
}
