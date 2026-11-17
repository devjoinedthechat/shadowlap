import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The CLI starts only on 22.17 and later 22s, and 24 on. Every store uses full-text search, which
 * Node's built-in SQLite has from 22.16 on but never in 23, and 22.16 itself crashes `shadowlap ui`
 * when its terminal closes. Any other Node is named in one line before the CLI loads, rather than
 * failing at the first store it opens with SQLite's "no such module: fts5". The Node here is this
 * one, told to report another version.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'sl-node-minimum-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs `args` on this Node, told to report `version` as its own. */
function nodeAs(version: string, args: string[]): { code: number | null; stdout: string; stderr: string } {
  const preload = join(dir, `node-${version}.mjs`);
  writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\nObject.defineProperty(process, 'version', { value: ${JSON.stringify(`v${version}`)} });\n`);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const cliOn = (version: string) => nodeAs(version, [CLI, '--version']);

/** The Action's own check of the job's Node, as action.yml runs it before installing the CLI. */
const actionCheck = /- name: Check Node\.js\n[\s\S]*?node -e '([^']+)'/.exec(readFileSync(fileURLToPath(new URL('../../../action.yml', import.meta.url)), 'utf8'))![1];

describe('the Node the CLI starts on', () => {
  it.each(['22.13.0', '22.15.1', '22.16.0', '23.11.1', '20.19.0', '18.20.8'])('refuses Node %s in one line naming the Node it needs', (version) => {
    const r = cliOn(version);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(`shadowlap: needs Node.js 22.17 or later (not 23, whose built-in SQLite has no full-text search); this is Node.js ${version}\n`);
  });

  it.each(['22.17.0', '22.20.1', '24.0.0', '26.1.0'])('starts on Node %s', (version) => {
    const r = cliOn(version);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.code).toBe(0);
  });

  it('is the one the GitHub Action asks a job for', () => {
    for (const version of ['22.13.0', '22.15.1', '22.16.0', '23.11.1', '20.19.0']) {
      const r = nodeAs(version, ['-e', actionCheck]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe(`::error title=shadowlap::shadowlap needs Node.js 22.17 or later (not 23, whose built-in SQLite has no full-text search); this job has v${version}. Add actions/setup-node with node-version: 22 before this step.\n`);
    }
    for (const version of ['22.17.0', '24.0.0', '26.1.0']) expect(nodeAs(version, ['-e', actionCheck])).toMatchObject({ code: 0, stdout: '' });
  });
});
