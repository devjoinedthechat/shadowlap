// docs/cli.md says how large `shadowlap export html` makes the copy of a 30-call run. Most of the file
// is the dashboard itself (its script, styles and fonts, which every copy carries), so the number moves
// as the dashboard grows, and nothing else would notice it going stale. This exports the reference
// agent's 30-call golden with the built dashboard, as the command does, and holds the sentence to it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportHtml } from '@shadowlap/dashboard';
import { Store, unpackRun } from '@shadowlap/engine';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const UI = join(ROOT, 'packages', 'dashboard', 'dist', 'ui');

describe('docs/cli.md on export html', () => {
  it('says how large the copy of a 30-call run is, as the built dashboard makes it', () => {
    const said = /A 30-call run comes to about ([\d.]+) MB/.exec(readFileSync(join(ROOT, 'docs', 'cli.md'), 'utf8'));
    expect(said, "docs/cli.md says how large a 30-call run's copy is").not.toBeNull();
    expect(existsSync(join(UI, 'assets', 'app.js')), 'the dashboard is built: npm run build').toBe(true);
    const store = Store.open(':memory:');
    try {
      const runId = unpackRun(store, join(ROOT, 'testing', 'golden', 'reference-agent')).imported[0];
      const { html, calls } = exportHtml({ store, runIds: [runId], uiDir: UI });
      expect(calls).toBe(30);
      // In MB as the command prints the size (1.2 MB), within what a few changes to the dashboard add.
      const mb = Buffer.byteLength(html) / (1024 * 1024);
      expect(Math.abs(mb - Number(said![1])), `the copy is ${mb.toFixed(2)} MB`).toBeLessThan(0.25);
    } finally {
      store.close();
    }
  });
});
