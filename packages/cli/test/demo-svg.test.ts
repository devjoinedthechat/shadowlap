import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * scripts/demo-svg.mjs (`npm run demo`) draws the README's terminal pictures from the real CLI: it
 * records, replays and blames the demo's refund agent, then replays it after a fix, each command in a
 * pseudo-terminal, and stops on any line it has no rule for, so a change in what the CLI prints is
 * looked at before it is drawn. Run here into a folder of its own, as `npm run demo` runs it into
 * .github/assets/readme: it gets through all the CLI prints, and draws the six pictures.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// The pseudo-terminal comes from `script`, on macOS and Linux.
const hasScript = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v script'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasScript)('scripts/demo-svg.mjs', () => {
  const out = mkdtempSync(join(tmpdir(), 'sl-demo-svg-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('draws the six pictures, every line the CLI prints shown or left out by a rule, blame folding its progress away', async () => {
    const drawn = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts', 'demo-svg.mjs'), '--out', out], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (d: Buffer) => (text += d.toString()));
      child.stderr.on('data', (d: Buffer) => (text += d.toString()));
      child.on('close', (code) => resolve({ code, out: text }));
    });
    expect(drawn.code, drawn.out).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['terminal-medium-static.svg', 'terminal-medium.svg', 'terminal-narrow-static.svg', 'terminal-narrow.svg', 'terminal-static.svg', 'terminal.svg']);
    const svg = readFileSync(join(out, 'terminal-static.svg'), 'utf8');
    // Blame's finding is drawn; its probes' tallies and the check of the call they pinned, pair by pair, are not.
    expect(svg).toContain('lost at model call #5 (3 of 5)');
    expect(svg).not.toMatch(/\d+ attempts?: \d+ passed|\d+ pairs?: #\d+|fresh pairs/);
  }, 600_000);
});
