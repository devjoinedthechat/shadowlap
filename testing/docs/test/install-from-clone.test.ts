// Until the packages are on npm and PyPI, the README, the quickstart and the SDK page tell people to
// install them from a clone of the repository: `shadowlap init` prints the published names, which don't
// exist yet. These checks run the npm lines exactly as the SDK page prints them, with this repository as
// the clone, in a project of their own, and check what an agent then gets: the SDK and the adapters as
// one module, and a recorded-test package that finds the clone's CLI without being told where it is.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
const CLONE = 'path/to/shadowlap';
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** The fenced shell blocks of a page that install from the clone, as their lines. */
function installBlocks(page: string): string[][] {
  return [...read(page).matchAll(/^```sh\n([\s\S]*?)^```/gm)].map((m) => m[1]!.trim().split('\n')).filter((lines) => lines.some((l) => l.includes(`${CLONE}/`)));
}

/** A line's words, without its comment. */
const words = (line: string) => line.replace(/\s+#.*$/, '').trim().split(/\s+/);

const block = installBlocks('docs/sdk.md')[0] ?? [];

describe('installing from a clone', () => {
  it('is one block, the same on the SDK page, in the quickstart and in the README', () => {
    expect(block.length).toBeGreaterThan(0);
    for (const page of ['README.md', 'docs/quickstart.md', 'docs/sdk.md']) expect(installBlocks(page), page).toEqual([block]);
  });

  it('names packages the repository has, by the folder each is in', () => {
    for (const line of block) {
      for (const w of words(line).filter((x) => x.startsWith(`${CLONE}/`))) {
        const dir = join(ROOT, w.slice(CLONE.length + 1));
        if (line.startsWith('pip ')) {
          expect(read(join(w.slice(CLONE.length + 1), 'pyproject.toml')), w).toMatch(/^name = "shadowlap"$/m);
          continue;
        }
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; private?: boolean };
        expect(manifest.private, w).toBeUndefined();
        expect(manifest.name, w).toMatch(/^@shadowlap\//);
      }
    }
  });

  describe('run as the SDK page prints it, in a project of its own', () => {
    let project: string;
    const run = (cmd: string, args: string[]) => {
      const win = process.platform === 'win32';
      // npm is a .cmd script on Windows, which only a shell runs; quote each argument for it.
      return spawnSync(win ? `${cmd}.cmd` : cmd, win ? args.map((a) => `"${a}"`) : args, {
        cwd: project,
        encoding: 'utf8',
        shell: win,
        env: { ...process.env, npm_config_cache: join(project, '.npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' },
      });
    };

    beforeAll(() => {
      project = mkdtempSync(join(tmpdir(), 'shadowlap-agent-'));
      writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'agent', private: true, type: 'module' }, null, 2));
      for (const line of block.filter((l) => l.startsWith('npm install '))) {
        // Linking a folder needs no registry: --offline proves it.
        const args = [...words(line).slice(1).map((w) => w.split(CLONE).join(ROOT)), '--offline', '--loglevel=error'];
        const r = run('npm', args);
        if (r.status !== 0) throw new Error(`${line}\n${r.error?.message ?? ''}${r.stdout}${r.stderr}`);
      }
    }, 120_000);
    afterAll(() => {
      if (project) rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    it('records each package as a link to the clone', () => {
      const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const all = { ...manifest.dependencies, ...manifest.devDependencies };
      expect(Object.keys(all).sort()).toEqual(['@shadowlap/adapters', '@shadowlap/sdk', '@shadowlap/test']);
      for (const spec of Object.values(all)) expect(spec).toMatch(/^file:/);
      expect(Object.keys(manifest.devDependencies ?? {})).toEqual(['@shadowlap/test']);
    });

    it('gives the agent the SDK, and the adapters on the same SDK', () => {
      const probe = join(project, 'probe.mjs');
      writeFileSync(
        probe,
        [
          "import { createRequire } from 'node:module';",
          "import { realpathSync } from 'node:fs';",
          "import { fileURLToPath } from 'node:url';",
          "const sdk = await import('@shadowlap/sdk');",
          "const adapters = await import('@shadowlap/adapters/ai-sdk');",
          "const own = realpathSync(fileURLToPath(import.meta.resolve('@shadowlap/sdk')));",
          "const theirs = realpathSync(createRequire(realpathSync(fileURLToPath(import.meta.resolve('@shadowlap/adapters')))).resolve('@shadowlap/sdk'));",
          "const testing = realpathSync(fileURLToPath(import.meta.resolve('@shadowlap/test')));",
          "const cli = realpathSync(createRequire(testing).resolve('shadowlap/bin/shadowlap.js'));",
          'console.log(JSON.stringify({ tool: typeof sdk.tool, withEffects: typeof adapters.withEffects, own, theirs, cli }));',
        ].join('\n'),
      );
      const r = spawnSync(process.execPath, [probe], { cwd: project, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const seen = JSON.parse(r.stdout) as { tool: string; withEffects: string; own: string; theirs: string; cli: string };
      expect(seen.tool).toBe('function');
      expect(seen.withEffects).toBe('function');
      // One module: a scope the agent enters is the scope the adapters' tools see.
      expect(seen.theirs).toBe(seen.own);
      expect(seen.own).toBe(realpathSync(join(ROOT, 'packages', 'sdk', 'dist', 'index.js')));
      // @shadowlap/test runs the CLI it depends on: from a clone, the clone's own.
      expect(seen.cli).toBe(realpathSync(join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js')));
      expect(existsSync(join(project, 'node_modules', '@shadowlap', 'test'))).toBe(true);
    });
  });
});
