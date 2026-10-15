import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Settings reads two docs pages when it is asked for them: the section to paste into a coding
 * agent's instructions (agents.md) and the MCP client config (mcp.md). An installed dashboard has
 * no repository to read them from, so the build copies them into dist/docs, which the package ships.
 */
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

describe('the docs pages Settings reads', () => {
  it('ship in the dashboard package, as the repository has them', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: PACKAGE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(['dist/docs/agents.md', 'dist/docs/mcp.md']));
    for (const name of ['agents.md', 'mcp.md']) {
      expect(readFileSync(join(PACKAGE, 'dist', 'docs', name), 'utf8'), name).toBe(readFileSync(join(PACKAGE, '..', '..', 'docs', name), 'utf8'));
    }
  });
});
