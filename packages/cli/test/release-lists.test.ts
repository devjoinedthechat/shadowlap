import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A release publishes every package `npm install shadowlap` needs, dependencies first, and sets one
 * version across all of them. The lists live in the release workflow and two scripts; a package
 * missing from any of them installs from the workspace here and fails with E404 for users. This
 * test keeps them in step with packages/.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

interface Manifest {
  dir: string;
  name: string;
  deps: string[];
}

const published: Manifest[] = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => ({ dir: `packages/${e.name}`, pkg: JSON.parse(read(`packages/${e.name}/package.json`)) as { name: string; private?: boolean; dependencies?: Record<string, string> } }))
  .filter(({ pkg }) => !pkg.private)
  .map(({ dir, pkg }) => ({ dir, name: pkg.name, deps: Object.keys(pkg.dependencies ?? {}) }));
const names = new Set(published.map((m) => m.name));

/** The package folders a shell loop or a JS array lists, in order. */
function dirs(text: string): string[] {
  return [...text.matchAll(/packages\/[a-z-]+/g)].map((m) => m[0]);
}

const workflow = read('.github/workflows/release.yml');
// The workflow names the packages once, in their order (PACKAGES), and packs and publishes that list.
const publishLoop = dirs(/^ {2}PACKAGES: (.+)$/m.exec(workflow)![1]);
const setVersion = read('scripts/set-version.mjs');
const versioned = dirs(/const PACKAGES = \[([^\]]+)\]/.exec(setVersion)![1]);
const internal = [...(/const INTERNAL = new Set\(\[([^\]]+)\]\)/.exec(setVersion)![1]).matchAll(/'([^']+)'/g)].map((m) => m[1]);
const rehearsed = dirs(/const PACKAGES = \[([^\]]+)\]/.exec(read('scripts/release-rehearsal.mjs'))![1]);

describe('the release', () => {
  const all = published.map((m) => m.dir).sort();

  it('publishes every published package, and checks its version against the tag', () => {
    expect([...publishLoop].sort()).toEqual(all);
    expect(workflow).toMatch(/for p in \$PACKAGES; do\s+file="\$\(npm pack --workspace "\$p"/);
    expect(workflow).toMatch(/for p in \$PACKAGES; do\s+npm publish "release\/npm\/\$\(basename "\$p"\)\.tgz"/);
    // The tag is checked against every package in packages/ (scripts/release-check.mjs), before npm ci.
    expect(workflow).toMatch(/run: node scripts\/release-check\.mjs "\$GITHUB_REF_NAME"\n\s+- run: npm ci/);
  });

  it('publishes each package after the ones it depends on', () => {
    const at = new Map(publishLoop.map((dir, i) => [published.find((m) => m.dir === dir)!.name, i]));
    for (const m of published) {
      for (const dep of m.deps.filter((d) => names.has(d))) expect(at.get(dep)!, `${dep} before ${m.name}`).toBeLessThan(at.get(m.name)!);
    }
  });

  it('sets one version across them, internal ranges included, and rehearses them all', () => {
    expect([...versioned].sort()).toEqual(all);
    for (const name of names) expect(internal, name).toContain(name);
    expect([...rehearsed].sort()).toEqual(all);
  });
});
