import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * What npm installs for a user, checked from the manifests and the packed files: one release's
 * packages only ever install with each other, a project on TypeScript's older module resolution finds
 * every subpath's types, and every source map names its file in the package's own src.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, { types?: string } | string>;
  typesVersions?: Record<string, Record<string, string[]>>;
}

const WORKSPACES = ['engine', 'sidecar', 'sdk', 'adapters', 'tui', 'remote', 'dashboard', 'cli', 'test', 'collector']
  .map((p) => `packages/${p}`)
  .concat(['testing/mock-anthropic', 'testing/mock-openai', 'testing/mock-gemini', 'testing/reference-agent']);
const manifest = (dir: string) => JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as Manifest;
const manifests = WORKSPACES.map((dir) => ({ dir, pkg: manifest(dir) }));
const versions = new Map(manifests.map(({ pkg }) => [pkg.name, pkg.version]));
const published = manifests.filter(({ pkg }) => !pkg.private);

describe('internal dependencies', () => {
  it('are pinned to the exact version, never a range', () => {
    const loose: string[] = [];
    for (const { dir, pkg } of manifests) {
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        for (const [name, range] of Object.entries(pkg[field] ?? {})) {
          if (versions.has(name) && range !== versions.get(name)) loose.push(`${dir} ${field} ${name}@${range}`);
        }
      }
    }
    expect(loose).toEqual([]);
  });

  it('leave the CLI asking npm for no peer: the Anthropic SDK is imported when a repairer needs it', () => {
    expect(manifest('packages/cli').peerDependencies).toBeUndefined();
  });
});

describe('subpath exports under moduleResolution node', () => {
  it('resolve to their types through typesVersions', async () => {
    const project = mkdtempSync(join(tmpdir(), 'shadowlap-node10-'));
    const modules = join(project, 'node_modules');
    mkdirSync(join(modules, '@shadowlap'), { recursive: true });
    mkdirSync(join(modules, '@types'), { recursive: true });
    for (const name of ['sdk', 'adapters', 'test']) symlinkSync(join(ROOT, 'packages', name), join(modules, '@shadowlap', name), 'dir');
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(modules, '@types', 'node'), 'dir');
    const imports: string[] = [];
    for (const name of ['adapters', 'test']) {
      const pkg = manifest(`packages/${name}`);
      for (const sub of Object.keys(pkg.exports ?? {})) imports.push(`export * as m${imports.length} from '@shadowlap/${name}${sub === '.' ? '' : sub.slice(1)}';`);
    }
    expect(imports.length).toBeGreaterThan(5);
    writeFileSync(join(project, 'index.ts'), imports.join('\n') + '\n');
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2022', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] }, files: ['index.ts'] }));
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const out = await run(process.execPath, [tsc, '-p', project], { cwd: project, encoding: 'utf8' }).catch((err: Error & { stdout?: string }) => ({ stdout: err.stdout ?? String(err) }));
    expect(out.stdout).toBe('');
  });

  it('list every subpath export in typesVersions', () => {
    for (const { dir, pkg } of published) {
      // A subpath with types: not ./package.json, which a package exports for what reads its manifest.
      const subs = Object.keys(pkg.exports ?? {}).filter((k) => k !== '.' && typeof pkg.exports![k] === 'object');
      if (!subs.length) continue;
      const mapped = pkg.typesVersions?.['*'] ?? {};
      for (const sub of subs) {
        const types = (pkg.exports![sub] as { types?: string }).types;
        expect(mapped[sub.slice(2)], `${dir} ${sub}`).toEqual([types]);
      }
    }
  });
});

describe('the CommonJS copies', () => {
  // A test runner with a module loader of its own (Jest on Node 22) requires the packages an agent
  // loads: each `require` condition names a copy that exports what the ES module does.
  const require = createRequire(join(ROOT, 'package.json'));
  const names = (m: object) => Object.keys(m).filter((k) => k !== 'default' && k !== '__esModule').sort();

  it("type-check in a CommonJS project, their declarations included, through each package's require condition", async () => {
    const project = mkdtempSync(join(tmpdir(), 'shadowlap-cjs-types-'));
    const modules = join(project, 'node_modules');
    mkdirSync(join(modules, '@shadowlap'), { recursive: true });
    mkdirSync(join(modules, '@types'), { recursive: true });
    for (const name of ['sdk', 'adapters', 'test']) symlinkSync(join(ROOT, 'packages', name), join(modules, '@shadowlap', name), 'dir');
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(modules, '@types', 'node'), 'dir');
    const required: string[] = [];
    for (const name of ['sdk', 'adapters', 'test']) {
      for (const [sub, conditions] of Object.entries(manifest(`packages/${name}`).exports ?? {})) {
        if ((conditions as { require?: unknown }).require) required.push(`@shadowlap/${name}${sub === '.' ? '' : sub.slice(1)}`);
      }
    }
    expect(required.length).toBeGreaterThan(5);
    writeFileSync(join(project, 'index.cts'), required.map((spec, i) => `import m${i} = require('${spec}');\nexport const k${i}: string[] = Object.keys(m${i});`).join('\n') + '\n');
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'node16', moduleResolution: 'node16', target: 'es2022', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] }, files: ['index.cts'] }));
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const out = await run(process.execPath, [tsc, '-p', project], { cwd: project, encoding: 'utf8' }).catch((err: Error & { stdout?: string }) => ({ stdout: err.stdout ?? String(err) }));
    expect(out.stdout).toBe('');
  });

  it('each have a source map naming their file in src, as the ES build has', () => {
    for (const name of ['sdk', 'adapters', 'test']) {
      const dir = join(ROOT, 'packages', name, 'dist', 'cjs');
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.cjs'))) {
        expect(readFileSync(join(dir, file), 'utf8'), file).toMatch(new RegExp(`\\n//# sourceMappingURL=${file.replace('.', '\\.')}\\.map$`));
        const map = JSON.parse(readFileSync(join(dir, `${file}.map`), 'utf8')) as { file: string; sources: string[] };
        expect(map.file).toBe(file);
        expect(map.sources).toEqual([`../../src/${file.replace(/\.cjs$/, '.ts')}`]);
      }
    }
  });

  for (const name of ['sdk', 'adapters', 'test']) {
    it(`@shadowlap/${name}: every subpath, as the ES module has it`, async () => {
      const pkg = manifest(`packages/${name}`);
      for (const [sub, conditions] of Object.entries(pkg.exports ?? {})) {
        const required = (conditions as { require?: { default: string } }).require;
        if (!required) continue;
        const spec = `@shadowlap/${name}${sub === '.' ? '' : sub.slice(1)}`;
        expect(require.resolve(spec), spec).toMatch(/\.cjs$/);
        const cjs = require(spec) as object;
        // The test API alone for @shadowlap/test: starting a host is the global setup's, an ES module.
        const esm = (await import(pathToFileURL(join(ROOT, 'packages', name, 'dist', name === 'test' && sub === '.' ? 'recording.js' : (conditions as { default: string }).default.replace('./dist/', ''))).href)) as object;
        expect(names(cjs), spec).toEqual(names(esm));
      }
    });
  }
});

/**
 * The packages whose code an agent imports, and a debugger steps into from it, ship their src: their
 * source maps resolve to the TypeScript in the package. The others' maps name the file and line in
 * src, which a stack trace shows (node --enable-source-maps), without the sources inline, which were
 * 30% of what installing every package unpacked.
 */
const SHIPS_SOURCES = ['@shadowlap/sdk', '@shadowlap/adapters', '@shadowlap/test'];

describe('source maps in the packed packages', () => {
  it("each name a file in the package's own src, carry none inline, and resolve where the package ships its src", async () => {
    const built = published.every(({ dir }) => existsSync(join(ROOT, dir, 'dist')));
    expect(built, 'npm run build first').toBe(true);
    const { stdout } = await run('npm', ['pack', '--dry-run', '--json', ...published.flatMap(({ dir }) => ['--workspace', dir])], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const packs = JSON.parse(stdout) as Array<{ name: string; files: Array<{ path: string }> }>;
    expect(packs.map((p) => p.name).sort()).toEqual(published.map(({ pkg }) => pkg.name).sort());
    expect(packs.filter((p) => p.files.some((f) => f.path.startsWith('src/'))).map((p) => p.name).sort()).toEqual([...SHIPS_SOURCES].sort());
    const outside: string[] = [];
    const inline: string[] = [];
    const missing: string[] = [];
    let maps = 0;
    for (const pack of packs) {
      const dir = published.find(({ pkg }) => pkg.name === pack.name)!.dir;
      const files = new Set(pack.files.map((f) => f.path));
      for (const file of files) {
        if (!file.endsWith('.map')) continue;
        maps++;
        const map = JSON.parse(readFileSync(join(ROOT, dir, file), 'utf8')) as { sources?: string[]; sourcesContent?: Array<string | null> };
        if (map.sourcesContent?.some(Boolean)) inline.push(`${pack.name}: ${file}`);
        for (const source of map.sources ?? []) {
          const target = posix.normalize(posix.join(posix.dirname(file), source));
          if (posix.isAbsolute(source) || !target.startsWith('src/')) outside.push(`${pack.name}: ${file} -> ${source}`);
          else if (SHIPS_SOURCES.includes(pack.name) && !files.has(target)) missing.push(`${pack.name}: ${file} -> ${target}`);
        }
      }
    }
    expect(maps).toBeGreaterThan(100);
    expect(outside).toEqual([]);
    expect(inline).toEqual([]);
    expect(missing).toEqual([]);
  }, 120_000);
});
