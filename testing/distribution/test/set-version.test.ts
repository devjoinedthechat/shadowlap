import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

// The release script as it is here, run on a copy of the repository as committed: every package gets the version,
// every internal dependency the exact version, and the SDKs the version they name to the sidecar.
describe('scripts/set-version.mjs', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadowlap-set-version-'));
    const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: ROOT, maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    execFileSync(process.execPath, [join(ROOT, 'scripts/set-version.mjs'), '9.8.7'], { cwd: dir, stdio: 'pipe' });
  }, 60_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('pins every internal dependency to the exact version', () => {
    for (const name of readdirSync(join(dir, 'packages'))) {
      const pkg = JSON.parse(readFileSync(join(dir, 'packages', name, 'package.json'), 'utf8')) as Record<string, unknown> & { version: string };
      expect(pkg.version, name).toBe('9.8.7');
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const [dep, range] of Object.entries((pkg[field] ?? {}) as Record<string, string>)) {
          if (dep === 'shadowlap' || dep.startsWith('@shadowlap/')) expect(range, `${name} ${field} ${dep}`).toBe('9.8.7');
        }
      }
    }
  });

  it('sets the version the Node and Python SDKs name to the sidecar', () => {
    expect(readFileSync(join(dir, 'packages/sdk/src/version.ts'), 'utf8')).toContain("export const VERSION = '9.8.7';");
    expect(readFileSync(join(dir, 'sdks/python/shadowlap/__init__.py'), 'utf8')).toMatch(/^__version__ = "9\.8\.7"$/m);
  });
});
