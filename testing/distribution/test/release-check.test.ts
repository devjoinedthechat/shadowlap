import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { changelogSection, releaseProblems } from '../../../scripts/release-check.mjs';

/**
 * What a release tag must agree with before anything publishes (scripts/release-check.mjs, run first
 * by release.yml): the version of every published package, the Python SDK's two and the one the
 * Node SDK sends, and a section of CHANGELOG.md, which becomes the GitHub release's notes. A tag the
 * changelog has no section for stops the release; it used to publish with "Release x.y.z" for notes.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'release-check.mjs');

const CHANGELOG = [
  '# Changelog',
  '',
  'Every notable change.',
  '',
  '## [Unreleased]',
  '',
  '## [0.2.0] - 2026-11-02',
  '',
  '### Added',
  '',
  '- Fixes on the dashboard.',
  '',
  '## [0.1.0] - 2026-11-01',
  '',
  '- The first release.',
  '',
  '[Unreleased]: https://example.test/compare/v0.2.0...HEAD',
  '[0.2.0]: https://example.test/releases/v0.2.0',
  '',
].join('\n');

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A repository with what the check reads, every version `version` but those `off` names. */
function repository(version: string, off: { package?: string; pyproject?: string; init?: string; node?: string; changelog?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sl-release-check-'));
  dirs.push(root);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('packages/engine/package.json', JSON.stringify({ name: '@shadowlap/engine', version: off.package ?? version }));
  put('packages/sdk/package.json', JSON.stringify({ name: '@shadowlap/sdk', version }));
  put('packages/sdk/src/version.ts', `/** The SDK's version. */\nexport const VERSION = '${off.node ?? version}';\n`);
  // A private package is never published, so its version is its own.
  put('packages/scratch/package.json', JSON.stringify({ name: 'scratch', private: true, version: '0.0.0' }));
  put('sdks/python/pyproject.toml', `[project]\nname = "shadowlap"\nversion = "${off.pyproject ?? version}"\n`);
  put('sdks/python/shadowlap/__init__.py', `__version__ = "${off.init ?? version}"\n`);
  put('CHANGELOG.md', off.changelog ?? CHANGELOG);
  return root;
}

describe("a version's section of the changelog", () => {
  it('is its heading and what follows, up to the next version, without the link references', () => {
    expect(changelogSection(CHANGELOG, '0.2.0')).toBe('## [0.2.0] - 2026-11-02\n\n### Added\n\n- Fixes on the dashboard.\n');
    expect(changelogSection(CHANGELOG, '0.1.0')).toBe('## [0.1.0] - 2026-11-01\n\n- The first release.\n');
  });

  it("is missing for a version the changelog doesn't name, and for one with nothing under its heading", () => {
    expect(changelogSection(CHANGELOG, '0.3.0')).toBeNull();
    expect(changelogSection(CHANGELOG, 'Unreleased')).toBeNull();
    expect(changelogSection('## [1.0.0] - 2027-01-01\n\n[1.0.0]: https://example.test\n', '1.0.0')).toBeNull();
  });
});

describe('a release tag', () => {
  it('agrees with a repository whose packages, Python SDK, Node SDK and changelog all name its version', () => {
    expect(releaseProblems(repository('0.2.0'), '0.2.0')).toEqual([]);
  });

  it('names each thing that disagrees with it', () => {
    const root = repository('0.2.0', { package: '0.1.9', pyproject: '0.1.9', init: '0.1.9', node: '0.1.9' });
    expect(releaseProblems(root, '0.2.0')).toEqual([
      'packages/engine (@shadowlap/engine) is 0.1.9',
      'the Python SDK (sdks/python/pyproject.toml) is 0.1.9',
      "the Python SDK's __version__ is 0.1.9",
      'the version the Node SDK sends (packages/sdk/src/version.ts) is 0.1.9',
    ]);
    expect(releaseProblems(repository('0.3.0'), '0.3.0')).toEqual(['CHANGELOG.md has no section for 0.3.0 (a "## [0.3.0] - <date>" heading with the release\'s changes under it)']);
  });

  it('stops the release from the command line, before anything is installed, and gives its notes from the same section', () => {
    const usage = spawnSync(process.execPath, [SCRIPT, '0.2.0'], { encoding: 'utf8' });
    expect(usage.status).toBe(2);
    // No release will be 99.0.0: every package disagrees, and the changelog has no section for it.
    const off = spawnSync(process.execPath, [SCRIPT, 'v99.0.0'], { encoding: 'utf8' });
    expect(off.status).toBe(1);
    expect(off.stderr).toContain("The tag v99.0.0 doesn't match the repository:");
    expect(off.stderr).toContain('CHANGELOG.md has no section for 99.0.0');
    expect(off.stderr).toContain('node scripts/set-version.mjs 99.0.0');
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toMatch(/run: node scripts\/release-check\.mjs "\$GITHUB_REF_NAME"\n\s+- run: npm ci/);
    expect(workflow).toContain('node scripts/release-check.mjs "$GITHUB_REF_NAME" --notes notes.md');
    expect(workflow).not.toMatch(/echo "Release \$TAG"/);
  });
});
