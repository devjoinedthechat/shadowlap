import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Settings reads two docs pages when it is asked for them: the section to paste into a coding
 * agent's instructions (agents.md) and the MCP client config (mcp.md). An installed dashboard has
 * no repository to read them from, so the build copies them into dist/docs, which the package ships.
 * The same goes for the coding agents' plugin and its skills, which `shadowlap skill install` puts
 * into a project from dist/coding-agents.
 */
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(PACKAGE, '..', '..');
let packed: string[];

beforeAll(() => {
  // Through a shell: on Windows npm is npm.cmd, which Node runs only that way.
  const out = execSync('npm pack --dry-run --json', { cwd: PACKAGE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  packed = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0].files.map((f) => f.path);
}, 60_000);

/** Every file under a folder, relative to it with `/`. */
function files(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Array<{ isFile(): boolean; name: string; parentPath: string }>)
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

describe('the docs pages Settings reads', () => {
  it('ship in the dashboard package, as the repository has them', () => {
    expect(packed).toEqual(expect.arrayContaining(['dist/docs/agents.md', 'dist/docs/mcp.md']));
    for (const name of ['agents.md', 'mcp.md']) {
      expect(readFileSync(join(PACKAGE, 'dist', 'docs', name), 'utf8'), name).toBe(readFileSync(join(REPO, 'docs', name), 'utf8'));
    }
  });
});

describe('the coding agents’ plugin and its skills', () => {
  it('ship in the dashboard package, file for file as the repository has them, dot-folders included', () => {
    // A file a system left in the folder (Finder's .DS_Store, Windows' Thumbs.db) is no part of the
    // repository, which ignores it: the build leaves it out of the copy, so the package holds none.
    const repo = files(join(REPO, 'coding-agents')).filter((p) => !['.DS_Store', 'Thumbs.db'].includes(p.split('/').pop()!));
    expect(repo).toEqual(expect.arrayContaining(['claude-code/.claude-plugin/plugin.json', 'claude-code/skills/debug-agent/SKILL.md', 'claude-code/skills/setup-agent/SKILL.md']));
    expect(files(join(PACKAGE, 'dist', 'coding-agents'))).toEqual(repo);
    expect(packed.filter((p) => p.startsWith('dist/coding-agents/')).sort()).toEqual(repo.map((p) => `dist/coding-agents/${p}`));
    for (const p of repo) expect(readFileSync(join(PACKAGE, 'dist', 'coding-agents', ...p.split('/')), 'utf8'), p).toBe(readFileSync(join(REPO, 'coding-agents', ...p.split('/')), 'utf8'));
  });
});
