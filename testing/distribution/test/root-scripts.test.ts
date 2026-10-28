import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The root's scripts. `npm run typecheck` checks every TypeScript program the repository has: the
 * build's projects (tsc -b, which checks what changed and writes it, as a composite build does; --dry
 * checked nothing), the CommonJS copies, the dashboard's UI and its browser tests, and the tests
 * themselves. `npm run build` first removes what tsc built from a source that is gone, which tsc
 * leaves. `npm run test:browser` passes what follows `--` on to Playwright.
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

describe('npm run build', () => {
  it('removes first what tsc built from a source that is gone, and nothing else', () => {
    expect(commands('build').slice(0, 2)).toEqual(['node scripts/prune-dist.mjs', 'tsc -b']);
    // A project as tsc -b builds one, whose dist has the build of a module since moved to another
    // package (as the dashboard's regex-shape.ts was), and of a folder since deleted.
    const root = mkdtempSync(join(tmpdir(), 'sl-prune-'));
    try {
      const write = (file: string) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), file.endsWith('.json') ? '' : '// built\n');
      };
      const config = (file: string, json: unknown) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), JSON.stringify(json));
      };
      config('tsconfig.json', { files: [], references: [{ path: 'packages/dashboard' }] });
      config('packages/dashboard/tsconfig.json', { compilerOptions: { rootDir: 'src', outDir: 'dist', composite: true, declarationMap: true, sourceMap: true }, include: ['src'] });
      for (const source of ['index.ts', 'routes/runs.ts', 'view.tsx']) write(`packages/dashboard/src/${source}`);
      const built = (module: string) => ['.js', '.js.map', '.d.ts', '.d.ts.map'].map((ext) => `packages/dashboard/dist/${module}${ext}`);
      const current = [...built('index'), ...built('routes/runs'), ...built('view')];
      const gone = [...built('regex-shape'), ...built('old/part')];
      // What the build's other steps write whole (the dashboard's app and docs, a package's CommonJS
      // copies), and what tsc never writes.
      const others = ['packages/dashboard/dist/ui/main.js', 'packages/dashboard/dist/docs/agents.md', 'packages/dashboard/dist/cjs/index.cjs', 'packages/dashboard/dist/cjs/index.cjs.map', 'packages/dashboard/dist/notes.txt'];
      for (const file of [...current, ...gone, ...others]) write(file);

      const said = execFileSync(process.execPath, [join(ROOT, 'scripts', 'prune-dist.mjs'), root], { encoding: 'utf8' });
      expect([...current, ...gone, ...others].filter((file) => existsSync(join(root, file)))).toEqual([...current, ...others]);
      expect(existsSync(join(root, 'packages/dashboard/dist/old'))).toBe(false);
      expect(said).toBe(`Removed 8 build outputs whose source is gone:\n${[...gone].sort().map((file) => `  ${join(file)}\n`).join('')}`);
      // Nothing more the next time.
      expect(execFileSync(process.execPath, [join(ROOT, 'scripts', 'prune-dist.mjs'), root], { encoding: 'utf8' })).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
