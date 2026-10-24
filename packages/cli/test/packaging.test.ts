import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Shadowlap sits in the model request path and holds recorded prompts, so its supply chain is part
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
  // The only package with a real dependency tree, and the only one you can use Shadowlap without.
  '@shadowlap/tui': ['ink', 'react'],
};

/** `shadowlap` and the `@shadowlap/*` packages are this repository's own. */
const isFirstParty = (name: string) => name === 'shadowlap' || name.startsWith('@shadowlap/');

const manifests = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => JSON.parse(readFileSync(join(ROOT, 'packages', e.name, 'package.json'), 'utf8')) as { name: string; private?: boolean; dependencies?: Record<string, string> })
  .filter((m) => !m.private);

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

  it('leaves the engine, sidecar, SDK, adapters and dashboard with no external dependencies at all', () => {
    for (const name of ['@shadowlap/engine', '@shadowlap/sidecar', '@shadowlap/sdk', '@shadowlap/adapters', '@shadowlap/dashboard']) {
      expect(ALLOWED[name], name).toEqual([]);
    }
  });

  it('keeps the Python SDK dependency-free', () => {
    const pyproject = readFileSync(join(ROOT, 'sdks/python/pyproject.toml'), 'utf8');
    expect(pyproject).toMatch(/^dependencies = \[\]$/m);
  });
});
