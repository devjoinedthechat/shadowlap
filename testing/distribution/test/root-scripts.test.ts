import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The root's scripts. `npm run typecheck` checks every TypeScript program the repository has: the
 * build's projects (tsc -b, which checks what changed and writes it, as a composite build does; --dry
 * checked nothing), the CommonJS copies, the dashboard's UI and its browser tests, and the tests
 * themselves. `npm run test:browser` passes what follows `--` on to Playwright.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

/** The script's commands, with the scripts it runs (`npm run x`) in their place. */
function commands(name: string): string[] {
  return scripts[name].split('&&').flatMap((c) => {
    const run = /^npm run ([\w:-]+)$/.exec(c.trim());
    return run ? commands(run[1]) : [c.trim()];
  });
}

/** The projects tsc -b builds: the root's references, and theirs. */
function referenced(config: string, seen = new Set<string>()): Set<string> {
  if (seen.has(config)) return seen;
  seen.add(config);
  // tsconfig files allow comments: none of these have any, and a parse error says so.
  const json = JSON.parse(readFileSync(join(ROOT, config), 'utf8')) as { references?: Array<{ path: string }> };
  for (const ref of json.references ?? []) referenced(posix.join(posix.dirname(config), ref.path, 'tsconfig.json'), seen);
  return seen;
}

describe('npm run typecheck', () => {
  it('checks every program, with nothing that checks nothing', () => {
    const chain = commands('typecheck');
    expect(chain.join(' && ')).not.toMatch(/--dry\b/);
    expect(chain[0]).toBe('tsc -b');
    expect(chain).toContain('node scripts/build-cjs.mjs');
    const checked = new Set([...referenced('tsconfig.json'), ...chain.flatMap((c) => [...c.matchAll(/tsc -p (\S+)/g)].map((m) => m[1]))]);
    const configs = execFileSync('git', ['ls-files', '-z', '--', '*tsconfig*.json'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    // The base every config extends, and ESLint's program, which type-checks nothing (checkJs is off).
    const notPrograms = new Set(['tsconfig.base.json', 'tsconfig.lint.json']);
    expect(configs.filter((c) => !notPrograms.has(c) && !checked.has(c))).toEqual([]);
  });
});

describe('npm run test:browser', () => {
  it("passes what follows -- on to Playwright, where the workspace's npm would read -g as --global", () => {
    // `npm run test:browser -- -g axe` runs `npm run test:browser --workspace packages/dashboard -- -g axe`.
    expect(scripts['test:browser']).toBe('npm run test:browser --workspace packages/dashboard --');
    const dashboard = (JSON.parse(readFileSync(join(ROOT, 'packages', 'dashboard', 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(dashboard['test:browser']).toMatch(/playwright test [^&]*$/);
  });
});
