import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * shadowlap sits in the model request path and holds recorded prompts, so its supply chain is part
 * of what people are trusting. Every published package's external runtime dependencies are listed
 * here, and a new one fails this test: the claim in the README stays true by construction rather
 * than by memory. Adding a dependency is allowed — it just has to be a decision, made here.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const ALLOWED: Record<string, string[]> = {
  shadowlap: ['commander'],
  '@shadowlap/engine': [],
  '@shadowlap/sidecar': [],
  '@shadowlap/sdk': [],
  '@shadowlap/adapters': [],
  '@shadowlap/dashboard': [],
  '@shadowlap/collector': [],
  '@shadowlap/test': [],
  // The team store: buckets reached with fetch and SigV4 of its own, no cloud SDK.
  '@shadowlap/remote': [],
  // The only package with a real dependency tree, and the only one you can use shadowlap without.
  '@shadowlap/tui': ['ink', 'react'],
};

/** `shadowlap` and the `@shadowlap/*` packages are this repository's own. */
const isFirstParty = (name: string) => name === 'shadowlap' || name.startsWith('@shadowlap/');

const manifests = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => ({ ...(JSON.parse(readFileSync(join(ROOT, 'packages', e.name, 'package.json'), 'utf8')) as { name: string; private?: boolean; dependencies?: Record<string, string> }), dir: join(ROOT, 'packages', e.name) }))
  .filter((m) => !m.private);
const manifestOf = new Map(manifests.map((m) => [m.name, m]));

/** What installing a package brings from npm: its external dependencies, and those of every package of ours under it. */
function installs(name: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(name)) return out;
  seen.add(name);
  for (const dep of Object.keys(manifestOf.get(name)?.dependencies ?? {})) {
    if (isFirstParty(dep)) for (const d of installs(dep, seen)) out.add(d);
    else out.add(dep);
  }
  return out;
}

/**
 * A package its built code imports and its manifest doesn't name: the one each runs only when asked,
 * as `npm install` adds it, and why.
 */
const OPTIONAL_IMPORTS: Record<string, string[]> = {
  // A Claude repairer imports the Anthropic SDK, and says how to install it when it is missing.
  shadowlap: ['@anthropic-ai/sdk'],
};

/** The packages a package's published JavaScript imports by name (its dist, bin and guard; not the dashboard's bundled UI), each with a file that does. */
function importedPackages(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const builtin = new Set(builtinModules);
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, e.name);
      if (e.isDirectory()) {
        if (path !== join(dir, 'dist', 'ui')) walk(path);
        continue;
      }
      if (!/\.(m|c)?js$/.test(e.name)) continue;
      for (const { fileName: spec } of ts.preProcessFile(readFileSync(path, 'utf8'), true, true).importedFiles) {
        if (/^(\.|\/|node:)/.test(spec) || builtin.has(spec)) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!found.has(name)) found.set(name, path.slice(dir.length + 1));
      }
    }
  };
  for (const sub of ['dist', 'bin', 'guard']) if (existsSync(join(dir, sub))) walk(join(dir, sub));
  return found;
}

describe('supply chain', () => {
  it('covers every published package', () => {
    expect(manifests.map((m) => m.name).sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  for (const m of manifests) {
    it(`${m.name} pulls in only the dependencies it is allowed`, () => {
      const external = Object.keys(m.dependencies ?? {})
        .filter((d) => !isFirstParty(d))
        .sort();
      expect(external).toEqual([...(ALLOWED[m.name] ?? [])].sort());
    });
  }

  it('asks npm for no peer, so it never conflicts with the Anthropic SDK a project pins; a Claude repairer imports the SDK when asked', () => {
    // An optional peer still takes part in npm's resolution: a project on an older @anthropic-ai/sdk
    // would fail to install shadowlap beside it (ERESOLVE). The repairer imports the SDK itself, and
    // says how to install it when it is missing.
    for (const dir of readdirSync(join(ROOT, 'packages'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      const m = JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8')) as { name: string; peerDependencies?: Record<string, string> };
      expect(m.peerDependencies, m.name).toBeUndefined();
    }
    const repairer = readFileSync(join(ROOT, 'packages', 'cli', 'src', 'repairer.ts'), 'utf8');
    expect(repairer).toContain("await import('@anthropic-ai/sdk')");
    expect(repairer).toMatch(/npm install[^\n]*@anthropic-ai\/sdk/);
  });

  it('leaves the engine, sidecar, SDK, adapters and dashboard with no external dependencies at all, through every package of ours under them', () => {
    for (const name of ['@shadowlap/engine', '@shadowlap/sidecar', '@shadowlap/sdk', '@shadowlap/adapters', '@shadowlap/dashboard']) {
      expect(ALLOWED[name], name).toEqual([]);
      expect([...installs(name)], name).toEqual([]);
    }
    // Ink and React come with the terminal UI, which the CLI brings and the dashboard doesn't.
    expect([...installs('@shadowlap/tui')].sort()).toEqual(['ink', 'react']);
    expect([...installs('shadowlap')].sort()).toEqual(['commander', 'ink', 'react']);
    expect(Object.keys(manifestOf.get('@shadowlap/dashboard')!.dependencies ?? {})).not.toContain('@shadowlap/tui');
  });

  it('imports, in every package, only what its manifest names', () => {
    const built = manifests.every((m) => existsSync(join(m.dir, 'dist')));
    expect(built, 'npm run build first').toBe(true);
    const undeclared: string[] = [];
    for (const m of manifests) {
      const named = new Set([m.name, ...Object.keys(m.dependencies ?? {}), ...(OPTIONAL_IMPORTS[m.name] ?? [])]);
      for (const [name, file] of importedPackages(m.dir)) if (!named.has(name)) undeclared.push(`${m.name}: ${name} (${file})`);
    }
    expect(undeclared).toEqual([]);
    // The dashboard's server, in particular, imports nothing of the terminal UI.
    expect([...importedPackages(manifestOf.get('@shadowlap/dashboard')!.dir).keys()].sort()).toEqual(['@shadowlap/engine', '@shadowlap/remote']);
  });

  it('keeps the Python SDK dependency-free', () => {
    const pyproject = readFileSync(join(ROOT, 'sdks/python/pyproject.toml'), 'utf8');
    expect(pyproject).toMatch(/^dependencies = \[\]$/m);
  });
});
