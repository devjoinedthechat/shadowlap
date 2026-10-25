import { execFileSync } from 'node:child_process';

/**
 * A command that starts a Python able to import every one of `packages` (their import names are
 * their package names here), or null: SHADOWLAP_PYTHON, python3 or python when one has them, else
 * uv, which fetches them for the run once and keeps them in its cache. Tests that need one skip
 * without it.
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
  return packages.length && can(uv) ? uv : null;
}
