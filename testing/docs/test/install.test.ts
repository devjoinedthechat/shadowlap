// The README, the quickstart and the SDK page install the packages by the names they are published
// under, in one block each page prints alike. These checks hold that block to the repository: each npm
// name is a package here that publishes, the pip name is the Python package's, and the CLI the README
// and the quickstart install globally is the package with the `shadowlap` command. Then they install the
// npm packages the way the block does, from their folders here, in a project of their own, and check
// what an agent gets: the SDK and the adapters as one module, and a recorded-test package that finds
// the CLI it depends on without being told where it is.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

interface Manifest {
  name: string;
  private?: boolean;
  bin?: Record<string, string>;
}

/** The repository's npm packages by name: the folder each is in, and its manifest. */
const PACKAGES = new Map(
  readdirSync(join(ROOT, 'packages'))
    .filter((dir) => existsSync(join(ROOT, 'packages', dir, 'package.json')))
    .map((dir) => {
      const manifest = JSON.parse(read(join('packages', dir, 'package.json'))) as Manifest;
      return [manifest.name, { dir: join(ROOT, 'packages', dir), manifest }] as const;
    }),
);

/** A line's words, without its comment. */
const words = (line: string) => line.replace(/\s+#.*$/, '').trim().split(/\s+/);

/** The fenced shell blocks of a page, as their lines. */
const shellBlocks = (page: string) => [...read(page).matchAll(/^```sh\n([\s\S]*?)^```/gm)].map((m) => m[1]!.trim().split('\n'));

/** The blocks of a page that install the SDKs: an `npm install` of a @shadowlap package. */
const installBlocks = (page: string) => shellBlocks(page).filter((lines) => lines.some((l) => l.startsWith('npm install ') && words(l).some((w) => w.startsWith('@shadowlap/'))));

const block = installBlocks('docs/sdk.md')[0] ?? [];
const npmLines = block.filter((l) => l.startsWith('npm install '));

describe('installing the packages', () => {
  it('is one block, the same on the SDK page, in the quickstart and in the README', () => {
    expect(block.length).toBeGreaterThan(0);
    for (const page of ['README.md', 'docs/quickstart.md', 'docs/sdk.md']) expect(installBlocks(page), page).toEqual([block]);
  });

  it('names packages the repository publishes, by the names in their manifests', () => {
    const named = npmLines.flatMap((l) => words(l).filter((w) => w.startsWith('@shadowlap/')));
    expect([...named].sort()).toEqual(['@shadowlap/adapters', '@shadowlap/sdk', '@shadowlap/test']);
    for (const name of named) {
      const pkg = PACKAGES.get(name);
      expect(pkg, name).toBeDefined();
      expect(pkg!.manifest.private, name).toBeUndefined();
    }
    const pip = block.filter((l) => l.startsWith('pip install '));
    expect(pip.map((l) => words(l).slice(2))).toEqual([['shadowlap']]);
    expect(read('sdks/python/pyproject.toml')).toMatch(/^name = "shadowlap"$/m);
  });

  it('installs the CLI as the package that has the shadowlap command', () => {
    const cli = PACKAGES.get('shadowlap');
    expect(cli?.manifest.private).toBeUndefined();
    expect(cli?.manifest.bin?.shadowlap).toBeDefined();
    for (const page of ['README.md', 'docs/quickstart.md']) expect(shellBlocks(page).flat(), page).toContain('npm install -g shadowlap');
  });

  describe('run as the block prints it, from the folders here, in a project of its own', () => {
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
      for (const line of npmLines) {
        // Each package from its folder in place of the registry: linking a folder needs none, as --offline proves.
        const args = [...words(line).slice(1).map((w) => PACKAGES.get(w)?.dir ?? w), '--offline', '--loglevel=error'];
        const r = run('npm', args);
        if (r.status !== 0) throw new Error(`${line}\n${r.error?.message ?? ''}${r.stdout}${r.stderr}`);
      }
    }, 120_000);
    afterAll(() => {
      if (project) rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    it('records each package, and @shadowlap/test as a dev dependency', () => {
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
      // @shadowlap/test runs the CLI it depends on: here, the repository's own.
      expect(seen.cli).toBe(realpathSync(join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js')));
      expect(existsSync(join(project, 'node_modules', '@shadowlap', 'test'))).toBe(true);
    });
  });
});
