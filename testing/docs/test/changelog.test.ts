// The changelog says what installing shadowlap brings with it. That claim is easy to break without
// noticing: a package gains a dependency, or depends on one of ours that has some. These checks read
// every published package's manifest and follow its dependencies on our own packages, so the claim
// stays true or the suite fails.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

interface Manifest {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
}
const manifests = new Map(
  readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => JSON.parse(readFileSync(join(ROOT, 'packages', e.name, 'package.json'), 'utf8')) as Manifest)
    .map((m) => [m.name, m]),
);
const published = [...manifests.values()].filter((m) => !m.private).map((m) => m.name);
const ours = (name: string) => name === 'shadowlap' || name.startsWith('@shadowlap/');

/** What installing a package brings from npm: its own dependencies, and those of ours it depends on. */
function external(name: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(name)) return out;
  seen.add(name);
  for (const dep of Object.keys(manifests.get(name)?.dependencies ?? {})) {
    if (ours(dep)) for (const d of external(dep, seen)) out.add(d);
    else out.add(dep);
  }
  return out;
}

/** The changelog's line about dependencies. */
const line = changelog.split('\n').find((l) => /runtime dependencies/i.test(l)) ?? '';

describe('the changelog', () => {
  it('has a line about runtime dependencies', () => {
    expect(line).not.toBe('');
  });

  it('names everything a published package brings from npm', () => {
    const all = new Set(published.flatMap((name) => [...external(name)]));
    expect(all.size).toBeGreaterThan(0);
    for (const dep of all) expect(line.toLowerCase(), dep).toContain(dep.toLowerCase());
  });

  it('is right that the engine, sidecar, SDK and adapters bring nothing', () => {
    expect(line).toContain('The engine, sidecar, SDKs and adapters install nothing else.');
    for (const name of ['@shadowlap/engine', '@shadowlap/sidecar', '@shadowlap/sdk', '@shadowlap/adapters']) expect([...external(name)], name).toEqual([]);
    expect(readFileSync(join(ROOT, 'sdks', 'python', 'pyproject.toml'), 'utf8')).toMatch(/^dependencies = \[\]$/m);
  });

  it('is right about the dashboard and the terminal UI: Ink and React come with the terminal UI, which the CLI brings and the dashboard does not', () => {
    expect([...external('@shadowlap/dashboard')]).toEqual([]);
    expect([...external('@shadowlap/tui')].sort()).toEqual(['ink', 'react']);
    expect([...external('shadowlap')].sort()).toEqual(['commander', ...external('@shadowlap/tui')].sort());
  });
});
